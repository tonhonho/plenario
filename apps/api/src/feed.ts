import { sql } from "@plenario/core/db";
import type { FeedItem, FeedItemTipo, Pagina, VotoTipo } from "@plenario/core/api";
import { urlFonteConsultaValida } from "@plenario/core/fonte";
import {
  codificarCursor,
  comOPartido,
  decodificarCursor,
  erro400,
  FMT_ISO,
  parlamentarResumo,
  papelAutoria,
  proposicaoResumo,
  resumoDespesa,
  urlFonteDespesa,
  urlFonteProposicao,
  urlFonteVoto,
  urlOficialParlamentar,
  votacaoResumo,
  type LinhaParlamentarResumo,
  type LinhaProposicaoResumo,
  type LinhaVotacaoResumo,
} from "./util";

export const TAMANHO_PAGINA = 30;
// teto do parametro `tipos` (os 4 tipos juntos somam ~45 caracteres)
const MAX_TIPOS_CHARS = 200;
const TIPOS: readonly FeedItemTipo[] = ["voto", "proposicao", "despesa_mensal", "consulta_publica"];

// ref_id de consulta_publica: "<proposicao_id>:<AAAA-MM>". O proposicao_id tem ":" ("senado:123"),
// então o corte é no ÚLTIMO ":". Formato legado ("2026-09") ou fora do padrão = null.
const RE_REF_CONSULTA = /^(.+):(\d{4}-(?:0[1-9]|1[0-2]))$/;

export function parseRefIdConsulta(refId: string): { proposicaoId: string; mes: string } | null {
  const m = RE_REF_CONSULTA.exec(refId);
  return m ? { proposicaoId: m[1]!, mes: m[2]! } : null;
}

export interface ResumoConsulta {
  votosSim: number;
  votosNao: number;
  apuradoEm: string;
}

const RE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const inteiroNaoNegativo = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

// Valida o jsonb `evento.resumo` de consulta_publica; malformado = null (evento omitido).
export function lerResumoConsulta(resumo: unknown): ResumoConsulta | null {
  if (typeof resumo !== "object" || resumo === null || Array.isArray(resumo)) return null;
  const r = resumo as Record<string, unknown>;
  const { votosSim, votosNao, apuradoEm } = r;
  if (!inteiroNaoNegativo(votosSim) || !inteiroNaoNegativo(votosNao)) return null;
  if (typeof apuradoEm !== "string" || !RE_ISO.test(apuradoEm) || Number.isNaN(Date.parse(apuradoEm))) return null;
  return { votosSim, votosNao, apuradoEm };
}

export function validarTipos(v: string | undefined): FeedItemTipo[] | null {
  if (v === undefined || v.trim() === "") return null;
  // teto antes do split: a mensagem nao ecoa o valor (um tipos enorme nao vira corpo de erro)
  if (v.length > MAX_TIPOS_CHARS) throw erro400(`tipos muito longo (maximo ${MAX_TIPOS_CHARS} caracteres)`);
  const tipos = [...new Set(v.split(",").map((s) => s.trim()).filter(Boolean))];
  for (const t of tipos) {
    if (!(TIPOS as readonly string[]).includes(t)) throw erro400(`tipo inválido: ${t} (use ${TIPOS.join(", ")})`);
  }
  // todos os tipos = sem filtro (o plano sem filtro de tipo é o mais barato)
  return tipos.length === TIPOS.length ? null : (tipos as FeedItemTipo[]);
}

// Cursor do feed: "<ocorrido_em em microssegundos desde epoch>.<evento.id>". Microssegundo e não
// milissegundo porque timestamptz guarda µs: truncar pra ms faria pular/repetir itens.
const RE_CURSOR_FEED = /^(-?\d{1,17})\.(\d{1,18})$/;

interface LinhaEvento {
  id: string;
  parlamentar_id: string;
  tipo: FeedItemTipo;
  ocorrido_iso: string;
  ref_id: string;
  resumo: unknown;
  cur_us: string;
}

export interface FiltroFeed {
  parlamentares: string[] | null; // null = feed geral
  tipos: FeedItemTipo[] | null;
  cursor: string | undefined;
}

export async function paginaFeed(f: FiltroFeed): Promise<Pagina<FeedItem>> {
  const c = decodificarCursor(f.cursor, RE_CURSOR_FEED);
  const limite = TAMANHO_PAGINA + 1; // um a mais pra saber se há próxima página

  const condTipo = f.tipos ? sql`and e.tipo = any(${f.tipos}::evento_tipo[])` : sql``;
  // Comparação de linha (ocorrido_em, id) < (...) vira condição de índice nos dois índices de
  // evento, então a página N custa o mesmo que a primeira.
  const condCursor = c
    ? sql`and (e.ocorrido_em, e.id) < (timestamptz 'epoch' + ${c[1]!}::bigint * interval '1 microsecond', ${c[2]!}::bigint)`
    : sql``;
  const colunas = sql`e.id::text as id, e.parlamentar_id, e.tipo, e.ocorrido_em, e.ref_id, e.resumo,
    to_char(e.ocorrido_em at time zone 'UTC', ${FMT_ISO}) as ocorrido_iso,
    (extract(epoch from e.ocorrido_em) * 1000000)::bigint::text as cur_us`;

  const ORDEM = sql`order by e.ocorrido_em desc, e.id desc`;

  let eventos: LinhaEvento[];
  if (f.parlamentares === null) {
    eventos = await sql<LinhaEvento[]>`
      select ${colunas} from evento e
      where true ${condTipo} ${condCursor}
      ${ORDEM}
      limit ${limite}`;
  } else {
    if (f.parlamentares.length === 0) return { itens: [], proximo: null };
    // Um top-N por parlamentar (evento_feed_idx) e merge: custo ~ ids × 31 linhas, independente
    // de quantos eventos cada um tem. Um "parlamentar_id = any(...)" direto tenderia a ler tudo
    // de cada um e ordenar, ou varrer o índice global filtrando.
    eventos = await sql<LinhaEvento[]>`
      select x.* from unnest(${f.parlamentares}::text[]) as p(id)
      cross join lateral (
        select ${colunas} from evento e
        where e.parlamentar_id = p.id ${condTipo} ${condCursor}
        ${ORDEM}
        limit ${limite}
      ) x
      order by x.ocorrido_em desc, x.id::bigint desc
      limit ${limite}`;
  }

  const temMais = eventos.length > TAMANHO_PAGINA;
  const pagina = temMais ? eventos.slice(0, TAMANHO_PAGINA) : eventos;
  const ultimo = pagina[pagina.length - 1];
  const proximo = temMais && ultimo ? codificarCursor(`${ultimo.cur_us}.${ultimo.id}`) : null;
  return { itens: await montarItens(pagina), proximo };
}

interface LinhaVotoFeed {
  votacao_id: string;
  parlamentar_id: string;
  voto: VotoTipo;
  partido_na_hora: string | null;
  sim: number | null;
  nao: number | null;
}

interface LinhaAutoria {
  proposicao_id: string;
  parlamentar_id: string;
  ordem: number | null;
  n_autores: number;
}

interface LinhaConsultaUrl {
  proposicao_id: string;
  url_fonte: string;
}

interface LinhaDespesaCat {
  parlamentar_id: string;
  ano: number;
  mes: number;
  categoria: string;
  valor: number;
}

const chave = (...p: (string | number)[]) => p.join("|");
export const RE_MES = /^(\d{4})-(\d{1,2})$/;

// Hidrata uma página de eventos com um número fixo de consultas (no máx. 6, em paralelo),
// independente do tamanho da página (a de consulta_publica entra como a 7ª).
async function montarItens(eventos: LinhaEvento[]): Promise<FeedItem[]> {
  if (eventos.length === 0) return [];

  const parlIds = [...new Set(eventos.map((e) => e.parlamentar_id))];
  const votos = eventos.filter((e) => e.tipo === "voto");
  const props = eventos.filter((e) => e.tipo === "proposicao");
  const desps = eventos
    .filter((e) => e.tipo === "despesa_mensal")
    .map((e) => ({ e, m: e.ref_id.match(RE_MES) }))
    .filter((x): x is { e: LinhaEvento; m: RegExpMatchArray } => x.m !== null);

  const consultas = eventos
    .filter((e) => e.tipo === "consulta_publica")
    .map((e) => ({ e, ref: parseRefIdConsulta(e.ref_id), resumo: lerResumoConsulta(e.resumo) }))
    .filter(
      (x): x is { e: LinhaEvento; ref: { proposicaoId: string; mes: string }; resumo: ResumoConsulta } =>
        x.ref !== null && x.resumo !== null,
    );
  const consultaPropIds = [...new Set(consultas.map((x) => x.ref.proposicaoId))];

  const votacaoIds = [...new Set(votos.map((e) => e.ref_id))];
  const propIds = [...new Set([...props.map((e) => e.ref_id), ...consultaPropIds])];
  const propEventoIds = [...new Set(props.map((e) => e.ref_id))];

  const [parls, votacoes, votosLinhas, proposicoes, autorias, despesas, consultaUrls] = await Promise.all([
    sql<(LinhaParlamentarResumo & { id_externo: string })[]>`
      select id, casa, id_externo, nome, partido, uf, foto_url, em_exercicio
      from parlamentar where id = any(${parlIds}::text[])`,
    votacaoIds.length
      ? sql<LinhaVotacaoResumo[]>`${selectVotacaoResumo()} where v.id = any(${votacaoIds}::text[])`
      : [],
    votos.length
      ? sql<LinhaVotoFeed[]>`
          with partidos as (
            -- votacao_id = any(array) usa o prefixo da PK de voto; um semi-join com a lista
            -- dos próprios votos levava o planner a varrer a tabela voto inteira (~200 ms)
            select v.votacao_id, v.partido_na_hora,
                   count(*) filter (where v.voto = 'sim')::int as sim,
                   count(*) filter (where v.voto = 'nao')::int as nao
            from voto v
            where v.votacao_id = any(${votacaoIds}::text[]) and v.partido_na_hora is not null
            group by 1, 2
          )
          select m.votacao_id, m.parlamentar_id, m.voto, m.partido_na_hora, p.sim, p.nao
          from unnest(${votos.map((e) => e.ref_id)}::text[], ${votos.map((e) => e.parlamentar_id)}::text[])
            as k(votacao_id, parlamentar_id)
          join voto m on m.votacao_id = k.votacao_id and m.parlamentar_id = k.parlamentar_id
          left join partidos p on p.votacao_id = m.votacao_id and p.partido_na_hora = m.partido_na_hora`
      : [],
    propIds.length
      ? sql<LinhaProposicaoResumo[]>`
          select id, casa, sigla_tipo, numero, ano, ementa, url from proposicao where id = any(${propIds}::text[])`
      : [],
    propEventoIds.length
      ? sql<LinhaAutoria[]>`
          select a.proposicao_id, a.parlamentar_id, a.ordem,
                 (select count(*)::int from proposicao_autor b where b.proposicao_id = a.proposicao_id) as n_autores
          from proposicao_autor a
          join unnest(${props.map((e) => e.ref_id)}::text[], ${props.map((e) => e.parlamentar_id)}::text[])
            as k(proposicao_id, parlamentar_id) using (proposicao_id, parlamentar_id)`
      : [],
    desps.length
      ? sql<LinhaDespesaCat[]>`
          select d.parlamentar_id, d.ano, d.mes, d.categoria, round(sum(d.valor), 2)::float8 as valor
          from despesa d
          join unnest(${desps.map((x) => x.e.parlamentar_id)}::text[],
                      ${desps.map((x) => Number(x.m[1]))}::int[],
                      ${desps.map((x) => Number(x.m[2]))}::int[]) as k(parlamentar_id, ano, mes)
            using (parlamentar_id, ano, mes)
          group by 1, 2, 3, 4`
      : [],
    consultaPropIds.length
      ? sql<LinhaConsultaUrl[]>`
          -- várias consultas na mesma proposição: vale a apuração mais recente
          select distinct on (proposicao_id) proposicao_id, url_fonte
          from consulta_publica where proposicao_id = any(${consultaPropIds}::text[])
          order by proposicao_id, apurado_em desc`
      : [],
  ]);

  const parlPorId = new Map(parls.map((p) => [p.id, parlamentarResumo(p)]));
  const perfilPorId = new Map(parls.map((p) => [p.id, urlOficialParlamentar(p.casa, p.id_externo)]));
  const externoPorId = new Map(parls.map((p) => [p.id, p.id_externo]));
  const votacaoPorId = new Map(votacoes.map((v) => [v.id, votacaoResumo(v)]));
  const votoPor = new Map(votosLinhas.map((v) => [chave(v.votacao_id, v.parlamentar_id), v]));
  const propPorId = new Map(proposicoes.map((p) => [p.id, proposicaoResumo(p)]));
  const autoriaPor = new Map(autorias.map((a) => [chave(a.proposicao_id, a.parlamentar_id), a]));
  const despPor = new Map<string, { categoria: string; valor: number }[]>();
  for (const d of despesas) {
    const k = chave(d.parlamentar_id, d.ano, d.mes);
    const l = despPor.get(k);
    if (l) l.push({ categoria: d.categoria, valor: d.valor });
    else despPor.set(k, [{ categoria: d.categoria, valor: d.valor }]);
  }

  const consultaUrlPor = new Map(consultaUrls.map((c) => [c.proposicao_id, c.url_fonte]));
  const consultaPorEvento = new Map(consultas.map((x) => [x.e.id, x]));

  // Evento cuja origem sumiu (ref quebrada) é omitido em vez de virar card incompleto; o cursor
  // continua andando pelo evento cru, então nada se repete.
  const itens: FeedItem[] = [];
  for (const e of eventos) {
    const parlamentar = parlPorId.get(e.parlamentar_id);
    const perfil = perfilPorId.get(e.parlamentar_id);
    if (!parlamentar || !perfil) continue;
    const base = { id: e.id, ocorridoEm: e.ocorrido_iso, parlamentar };

    if (e.tipo === "voto") {
      const votacao = votacaoPorId.get(e.ref_id);
      const v = votoPor.get(chave(e.ref_id, e.parlamentar_id));
      if (!votacao || !v) continue;
      itens.push({
        ...base,
        urlFonte: urlFonteVoto(votacao, perfil),
        tipo: "voto",
        voto: v.voto,
        votacao,
        comOPartido: comOPartido(v.voto, v.partido_na_hora, v.sim, v.nao),
      });
    } else if (e.tipo === "proposicao") {
      const proposicao = propPorId.get(e.ref_id);
      if (!proposicao) continue;
      const papel = papelAutoria(autoriaPor.get(chave(e.ref_id, e.parlamentar_id)));
      itens.push({ ...base, urlFonte: urlFonteProposicao(proposicao, perfil), tipo: "proposicao", papel, proposicao });
    } else if (e.tipo === "despesa_mensal") {
      const m = e.ref_id.match(RE_MES);
      if (!m) continue;
      const ano = Number(m[1]);
      const mes = Number(m[2]);
      const { total, porCategoria } = resumoDespesa(despPor.get(chave(e.parlamentar_id, ano, mes)) ?? []);
      const urlFonte = urlFonteDespesa(parlamentar.casa, externoPorId.get(e.parlamentar_id), ano, mes, perfil);
      itens.push({ ...base, urlFonte, tipo: "despesa_mensal", ano, mes, total, porCategoria });
    } else if (e.tipo === "consulta_publica") {
      const c = consultaPorEvento.get(e.id);
      if (!c) continue;
      const proposicao = propPorId.get(c.ref.proposicaoId);
      const urlFonte = consultaUrlPor.get(c.ref.proposicaoId);
      // url fora do host/esquema oficial = evento omitido (mesma regra do ingest e do export)
      if (!proposicao || !urlFonte || !urlFonteConsultaValida(urlFonte)) continue;
      itens.push({
        ...base,
        urlFonte,
        tipo: "consulta_publica",
        proposicao,
        votosSim: c.resumo.votosSim,
        votosNao: c.resumo.votosNao,
        apuradoEm: c.resumo.apuradoEm,
      });
    }
  }
  return itens;
}

export function selectVotacaoResumo() {
  return sql`
    select v.id, v.casa, v.id_externo, to_char(v.data_hora at time zone 'UTC', ${FMT_ISO}) as data_hora,
           v.data_hora_aproximada, v.orgao, v.descricao, v.aprovada, v.nominal, v.secreta, v.url,
           v.placar_sim, v.placar_nao, v.placar_outros,
           p.id as p_id, p.casa as p_casa, p.sigla_tipo as p_sigla_tipo, p.numero as p_numero,
           p.ano as p_ano, p.ementa as p_ementa, p.url as p_url
    from votacao v left join proposicao p on p.id = v.proposicao_id`;
}
