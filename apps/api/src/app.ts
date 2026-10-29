import { Hono } from "hono";
import { cors } from "hono/cors";
import { sql } from "@plenario/core/db";
import { normalizarBusca } from "@plenario/core/texto";
import { urlFonteConsultaValida } from "@plenario/core/fonte";
import type {
  ConsultaPlacar,
  ErroApi,
  Health,
  PartidoResumo,
  FeedItem,
  Pagina,
  Parlamentar,
  ParlamentarResumo,
  ProposicaoDetalhe,
  VotacaoDetalhe,
  VotoTipo,
} from "@plenario/core/api";
import { paginaFeed, selectVotacaoResumo, validarTipos } from "./feed";
import {
  ErroHttp,
  codificarCursor,
  decodificarCursor,
  erro400,
  erro404,
  FMT_ISO,
  parlamentarResumo,
  proposicaoResumo,
  urlOficialParlamentar,
  validarCasa,
  validarId,
  validarLimite,
  votacaoResumo,
  type LinhaParlamentarResumo,
  type LinhaProposicaoResumo,
  type LinhaVotacaoResumo,
} from "./util";

export const VERSAO = process.env.PLENARIO_VERSAO ?? "0.1.0";
// Escopo do v1: 57ª legislatura (Câmara e Senado), desde 01/02/2023.
const INICIO_LEGISLATURA = "2023-02-01T00:00:00-03:00";
const MAX_IDS = 200;

export const app = new Hono();

app.use("*", cors({ origin: "*", allowMethods: ["GET", "HEAD", "OPTIONS"], maxAge: 86400 }));

// Dado público e que só muda a cada carga do ingest: cache curto em toda resposta 200 de dado.
app.use("*", async (c, next) => {
  await next();
  if (c.req.path === "/health" || c.res.status !== 200) c.header("Cache-Control", "no-store");
  else c.header("Cache-Control", "public, max-age=60");
});

app.onError((e, c) => {
  if (e instanceof ErroHttp) return c.json<ErroApi>({ erro: e.message }, e.status);
  console.error(e);
  return c.json<ErroApi>({ erro: "erro interno" }, 500);
});

app.notFound((c) => c.json<ErroApi>({ erro: "rota não encontrada" }, 404));

// ---------- /health ----------

app.get("/health", async (c) => {
  const [r] = await sql<{ max: string | null }[]>`
    select to_char(max(ocorrido_em) at time zone 'UTC', ${FMT_ISO}) as max from evento`;
  return c.json<Health>({ ok: true, versao: VERSAO, dadosAte: r?.max ?? null });
});

// ---------- /parlamentares ----------

const RE_CURSOR_NOME = /^n\.([^\n]*)\n(.+)$/s;
const RE_CURSOR_OFFSET = /^o\.(\d{1,6})$/;

app.get("/parlamentares", async (c) => {
  const brutoIds = c.req.query("ids");
  if (brutoIds !== undefined && brutoIds.trim() !== "") {
    // lista explícita (ex.: quem a pessoa segue): ignora filtros e paginação
    const ids = listaIds(brutoIds);
    const linhas = await sql<LinhaParlamentarResumo[]>`
      select p.id, p.casa, p.nome, p.partido, p.uf, p.foto_url, p.em_exercicio
      from unnest(${ids}::text[]) with ordinality as u(id, ordem)
      join parlamentar p on p.id = u.id
      order by u.ordem`;
    return c.json<Pagina<ParlamentarResumo>>({ itens: linhas.map(parlamentarResumo), proximo: null });
  }

  const casa = validarCasa(c.req.query("casa"));
  const partido = textoCurto(c.req.query("partido"), "partido", 30);
  const uf = textoCurto(c.req.query("uf"), "uf", 2)?.toUpperCase();
  if (uf !== undefined && !/^[A-Z]{2}$/.test(uf)) throw erro400("uf deve ter 2 letras");
  const limite = validarLimite(c.req.query("limite"), 30, 100);
  const q = normalizarBusca(textoCurto(c.req.query("q"), "q", 100));
  const cursor = c.req.query("cursor");

  const filtros = sql`
    ${casa ? sql`and casa = ${casa}` : sql``}
    ${partido ? sql`and upper(partido) = upper(${partido})` : sql``}
    ${uf ? sql`and uf = ${uf}` : sql``}`;

  let linhas: (LinhaParlamentarResumo & { busca: string })[];
  let proximo: string | null = null;

  if (q) {
    // Ordenada por relevância: cursor é um deslocamento (a tabela tem ~600 linhas, então o
    // custo de offset é desprezível e evita chaveamento por float de similaridade).
    const m = decodificarCursor(cursor, RE_CURSOR_OFFSET);
    const offset = m ? Number(m[1]) : 0;
    const padrao = "%" + q.replace(/[\\%_]/g, (s) => "\\" + s) + "%";
    // `busca like` e `q <% busca` são ambos atendidos pelo índice GIN trigram; o `<%`
    // (word_similarity) tolera erro de digitação e nome parcial.
    linhas = await sql<(LinhaParlamentarResumo & { busca: string })[]>`
      select id, casa, nome, partido, uf, foto_url, em_exercicio, busca
      from parlamentar
      where (busca like ${padrao} or ${q} <% busca) ${filtros}
      order by (busca like ${padrao}) desc, word_similarity(${q}, busca) desc, similarity(${q}, busca) desc, busca, id
      limit ${limite + 1} offset ${offset}`;
    if (linhas.length > limite) proximo = codificarCursor(`o.${offset + limite}`);
  } else {
    // Ordem alfabética por `busca` (nome sem acento) pra "Álvaro" não ir pro fim da lista.
    const m = decodificarCursor(cursor, RE_CURSOR_NOME);
    linhas = await sql<(LinhaParlamentarResumo & { busca: string })[]>`
      select id, casa, nome, partido, uf, foto_url, em_exercicio, busca
      from parlamentar
      where true ${filtros} ${m ? sql`and (busca, id) > (${m[1]!}, ${m[2]!})` : sql``}
      order by busca, id
      limit ${limite + 1}`;
    const ultimo = linhas[limite - 1];
    if (linhas.length > limite && ultimo) proximo = codificarCursor(`n.${ultimo.busca}\n${ultimo.id}`);
  }

  return c.json<Pagina<ParlamentarResumo>>({ itens: linhas.slice(0, limite).map(parlamentarResumo), proximo });
});

// Lista de ids separados por vírgula: sem repetição (mantém a primeira ocorrência), até 200.
function listaIds(bruto: string): string[] {
  const ids = [...new Set(bruto.split(",").map((s) => s.trim()).filter(Boolean))];
  if (ids.length > MAX_IDS) throw erro400(`no máximo ${MAX_IDS} ids`);
  for (const id of ids) validarId(id, "id de parlamentar");
  return ids;
}

function textoCurto(v: string | undefined, nome: string, max: number): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  if (t.length > max) throw erro400(`${nome} muito longo (máx. ${max})`);
  return t === "" ? undefined : t;
}

app.get("/parlamentares/:id", async (c) => {
  const id = validarId(c.req.param("id"), "id de parlamentar");
  const [p] = await sql<
    (LinhaParlamentarResumo & { id_externo: string; nome_civil: string | null; email: string | null })[]
  >`select id, casa, id_externo, nome, nome_civil, partido, uf, foto_url, email, em_exercicio
    from parlamentar where id = ${id}`;
  if (!p) throw erro404("parlamentar não encontrado");

  const anoCorrente = Number(
    new Intl.DateTimeFormat("en", { timeZone: "America/Sao_Paulo", year: "numeric" }).format(new Date()),
  );

  // Presença: denominador = votações nominais não secretas do Plenário da casa dentro dos períodos
  // de `exercicio` (início e fim inclusivos, em dias de Brasília); numerador = votos dele nelas
  // que não são "ausente". Votação sem linha dele conta como falta (a Câmara só lista quem votou).
  // Só Plenário porque comissão só vota quem é membro; secreta fica fora porque não tem voto
  // individual. Sem linha em `exercicio`, a janela cai na aproximação antiga: do primeiro ao
  // último voto dele no Plenário na legislatura.
  const [e] = await sql<
    { votacoes_nominais: number; presentes: number; proposicoes: number; despesas: number | null }[]
  >`
    with meus as materialized (
      -- os votos dele de uma vez pelo voto_parl_idx; deixar o planner sondar a PK de voto por
      -- votação fazia ~2 mil leituras aleatórias (4 s a frio contra ~90 ms assim)
      select v.votacao_id, v.voto from voto v where v.parlamentar_id = ${id}
    ), periodos_ex as (
      select ex.inicio::timestamp at time zone 'America/Sao_Paulo' as ini,
             coalesce((ex.fim + 1)::timestamp at time zone 'America/Sao_Paulo', 'infinity'::timestamptz) as fim
      from exercicio ex where ex.parlamentar_id = ${id}
    ), janela_aprox as (
      select min(vt.data_hora) as ini, max(vt.data_hora) + interval '1 microsecond' as fim
      from meus m join votacao vt on vt.id = m.votacao_id
      where not exists (select 1 from periodos_ex)
        and vt.nominal and vt.orgao = 'PLEN'
        and vt.data_hora >= ${INICIO_LEGISLATURA}::timestamptz
    ), periodos as (
      select ini, fim from periodos_ex
      union all
      select ini, fim from janela_aprox where ini is not null
    ), alvo as (
      -- casa + data_hora com "nominal and orgao = 'PLEN'" casa com o índice parcial votacao_plen_nominal_idx
      select distinct x.id from periodos p
      join votacao x on x.casa = ${p.casa} and x.nominal and x.orgao = 'PLEN'
        and x.data_hora >= p.ini and x.data_hora < p.fim
      where not x.secreta
    )
    select
      (select count(*)::int from alvo) as votacoes_nominais,
      (select count(*)::int from meus m join alvo a on a.id = m.votacao_id
        where m.voto <> 'ausente') as presentes,
      (select count(*)::int from proposicao_autor a where a.parlamentar_id = ${id}) as proposicoes,
      (select round(coalesce(sum(d.valor), 0), 2)::float8 from despesa d
        where d.parlamentar_id = ${id} and d.ano = ${anoCorrente}) as despesas`;

  const nominais = e?.votacoes_nominais ?? 0;
  const presentes = Math.min(e?.presentes ?? 0, nominais);
  const corpo: Parlamentar = {
    ...parlamentarResumo(p),
    nomeCivil: p.nome_civil,
    email: p.email,
    urlOficial: urlOficialParlamentar(p.casa, p.id_externo),
    estatisticas: {
      votacoesNominais: nominais,
      presencaPct: nominais > 0 ? Math.round((presentes / nominais) * 1000) / 10 : null,
      proposicoesAutor: e?.proposicoes ?? 0,
      despesasAnoCorrente: p.casa === "senado" ? null : (e?.despesas ?? 0),
    },
  };
  return c.json(corpo);
});

app.get("/parlamentares/:id/feed", async (c) => {
  const id = validarId(c.req.param("id"), "id de parlamentar");
  const tipos = validarTipos(c.req.query("tipos"));
  const cursor = c.req.query("cursor");
  const [p] = await sql`select 1 from parlamentar where id = ${id}`;
  if (!p) throw erro404("parlamentar não encontrado");
  return c.json<Pagina<FeedItem>>(await paginaFeed({ parlamentares: [id], tipos, cursor }));
});

// ---------- /feed ----------

app.get("/feed", async (c) => {
  const tipos = validarTipos(c.req.query("tipos"));
  const bruto = c.req.query("parlamentares");
  let parlamentares: string[] | null = null;
  if (bruto !== undefined && bruto.trim() !== "") {
    parlamentares = listaIds(bruto);
  }
  return c.json<Pagina<FeedItem>>(await paginaFeed({ parlamentares, tipos, cursor: c.req.query("cursor") }));
});

// ---------- /votacoes/:id ----------

app.get("/votacoes/:id", async (c) => {
  const id = validarId(c.req.param("id"), "id de votação");
  const [v] = await sql<LinhaVotacaoResumo[]>`${selectVotacaoResumo()} where v.id = ${id}`;
  if (!v) throw erro404("votação não encontrada");

  const [porPartido, votos] = await Promise.all([
    // "outros" = presente sem sim/não (abstenção, obstrução, art. 17, outro); ausência fica de fora
    sql<{ partido: string; sim: number; nao: number; outros: number }[]>`
      select coalesce(partido_na_hora, 'Sem partido') as partido,
             count(*) filter (where voto = 'sim')::int as sim,
             count(*) filter (where voto = 'nao')::int as nao,
             count(*) filter (where voto not in ('sim', 'nao', 'ausente'))::int as outros
      from voto where votacao_id = ${id}
      group by 1
      having count(*) filter (where voto <> 'ausente') > 0
      order by count(*) filter (where voto <> 'ausente') desc, 1`,
    sql<(LinhaParlamentarResumo & { voto: VotoTipo })[]>`
      select p.id, p.casa, p.nome, p.partido, p.uf, p.foto_url, p.em_exercicio, v.voto
      from voto v join parlamentar p on p.id = v.parlamentar_id
      where v.votacao_id = ${id}
      order by p.busca, p.id`,
  ]);

  const corpo: VotacaoDetalhe = {
    ...votacaoResumo(v),
    porPartido,
    votos: votos.map((r) => ({ parlamentar: parlamentarResumo(r), voto: r.voto })),
  };
  return c.json(corpo);
});

// ---------- /proposicoes/:id ----------

interface LinhaConsultaPlacar {
  votos_sim: number;
  votos_nao: number;
  url_fonte: string;
  apurado_em: string;
}

// Dado inválido (votos negativos/não inteiros, data que não parseia, URL fora da regra) => null, nunca "0 x 0".
function consultaPlacar(l: LinhaConsultaPlacar | undefined): ConsultaPlacar | null {
  if (!l) return null;
  const votoOk = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;
  if (!votoOk(l.votos_sim) || !votoOk(l.votos_nao)) return null;
  if (typeof l.apurado_em !== "string" || Number.isNaN(Date.parse(l.apurado_em))) return null;
  if (!urlFonteConsultaValida(l.url_fonte)) return null;
  return { votosSim: l.votos_sim, votosNao: l.votos_nao, apuradoEm: l.apurado_em, urlFonte: l.url_fonte };
}

app.get("/proposicoes/:id", async (c) => {
  const id = validarId(c.req.param("id"), "id de proposição");
  const [p] = await sql<(LinhaProposicaoResumo & { data_apresentacao: string | null })[]>`
    select id, casa, sigla_tipo, numero, ano, ementa, url,
           to_char(data_apresentacao at time zone 'UTC', ${FMT_ISO}) as data_apresentacao
    from proposicao where id = ${id}`;
  if (!p) throw erro404("proposição não encontrada");

  const [autores, votacoes, consultas] = await Promise.all([
    sql<(LinhaParlamentarResumo & { proponente: boolean; ordem: number | null })[]>`
      select pa.id, pa.casa, pa.nome, pa.partido, pa.uf, pa.foto_url, pa.em_exercicio, a.proponente, a.ordem
      from proposicao_autor a join parlamentar pa on pa.id = a.parlamentar_id
      where a.proposicao_id = ${id}
      order by a.ordem nulls last, pa.busca, pa.id`,
    sql<LinhaVotacaoResumo[]>`${selectVotacaoResumo()} where v.proposicao_id = ${id} order by v.data_hora desc, v.id`,
    // várias consultas na mesma proposição: vale a apuração mais recente (mesma regra do feed)
    sql<LinhaConsultaPlacar[]>`
      select votos_sim, votos_nao, url_fonte,
             to_char(apurado_em at time zone 'UTC', ${FMT_ISO}) as apurado_em
      from consulta_publica where proposicao_id = ${id}
      order by consulta_publica.apurado_em desc limit 1`,
  ]);

  const corpo: ProposicaoDetalhe = {
    ...proposicaoResumo(p),
    dataApresentacao: p.data_apresentacao,
    autores: autores.map((a) => ({ parlamentar: parlamentarResumo(a), proponente: a.proponente, ordem: a.ordem })),
    votacoes: votacoes.map(votacaoResumo),
    consulta: consultaPlacar(consultas[0]),
  };
  return c.json(corpo);
});

// ---------- /partidos ----------

app.get("/partidos", async (c) => {
  const linhas = await sql<PartidoResumo[]>`
    select partido as sigla, count(*)::int as total
    from parlamentar
    where em_exercicio and partido is not null and partido <> ''
    group by partido
    order by total desc, partido`;
  return c.json<PartidoResumo[]>([...linhas]);
});
