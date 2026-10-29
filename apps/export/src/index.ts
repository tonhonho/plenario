// Gera o site estático (contrato em @plenario/core/estatico) a partir do banco.
// Uso: bun run start [--saida <dir>]   (padrão: apps/web/public/data)
//
// p/, votacao/ e proposicao/ saem do próprio app da API chamado em processo: o arquivo é o corpo
// da resposta, byte a byte, então não há SQL duplicado nem risco de divergir da API. O feed sai
// de uma consulta em streaming por tipo, com as mesmas regras de card da API (apps/api/src/util).

import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { sql } from "@plenario/core/db";
import { urlFonteConsultaValida } from "@plenario/core/fonte";
import { normalizarBusca } from "@plenario/core/texto";
import type { Casa, Health, VotacaoResumo, VotoTipo } from "@plenario/core/api";
import {
  ESTATICO_VERSAO,
  LIMITE_FEED_GERAL,
  TAMANHO_PAGINA,
  TIPOS_FEED,
  caminhos,
  type ArquivoParlamentares,
  type ArquivoVotacoes,
  type FeedItemCompacto,
  type Meta,
  type PaginaFeed,
  type ParlamentarIndice,
} from "@plenario/core/estatico";
import type { FeedItemTipo } from "@plenario/core/api";
import { app } from "../../api/src/app";
import { RE_MES, lerResumoConsulta, parseRefIdConsulta, selectVotacaoResumo } from "../../api/src/feed";
import {
  FMT_ISO,
  comOPartido,
  papelAutoria,
  parlamentarResumo,
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
} from "../../api/src/util";

const RAIZ = resolve(import.meta.dir, "../../..");

function argSaida(): string {
  const i = process.argv.indexOf("--saida");
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (i >= 0 && !v) throw new Error("--saida precisa de um diretório");
  return resolve(v ?? join(RAIZ, "apps/web/public/data"));
}

const SAIDA = argSaida();
// Paralelismo de escrita em disco e de requisições ao app (o pool do banco é DB_POOL, padrão 10).
const PARALELO_ESCRITA = 64;
const PARALELO_API = Number(process.env.EXPORT_PARALELO ?? 12);
const LOTE_CURSOR = 5000;

// ---------- infraestrutura ----------

let arquivos = 0;
const dirsCriados = new Set<string>();

async function gravar(rel: string, conteudo: string): Promise<void> {
  const caminho = join(SAIDA, rel);
  const dir = dirname(caminho);
  if (!dirsCriados.has(dir)) {
    dirsCriados.add(dir);
    await mkdir(dir, { recursive: true });
  }
  await Bun.write(caminho, conteudo);
  arquivos++;
}

// Limita quantas promessas rodam ao mesmo tempo; `add` só retorna quando há vaga (contrapressão
// para o streaming não acumular milhares de escritas pendentes na memória).
class Limitador {
  private ativos = new Set<Promise<void>>();
  private erro: unknown = null;
  constructor(private readonly max: number) {}
  async add(fn: () => Promise<void>): Promise<void> {
    if (this.erro) throw this.erro;
    while (this.ativos.size >= this.max) await Promise.race(this.ativos);
    const p: Promise<void> = fn()
      .catch((e) => {
        this.erro ??= e;
      })
      .finally(() => this.ativos.delete(p));
    this.ativos.add(p);
  }
  async fim(): Promise<void> {
    await Promise.all(this.ativos);
    if (this.erro) throw this.erro;
  }
}

const escrita = new Limitador(PARALELO_ESCRITA);
const gravarJson = (rel: string, obj: unknown) => escrita.add(() => gravar(rel, JSON.stringify(obj)));

async function etapa<T>(nome: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const antes = arquivos;
  const r = await fn();
  await escrita.fim();
  console.log(`${nome.padEnd(24)} ${((performance.now() - t0) / 1000).toFixed(1).padStart(6)} s  ${arquivos - antes} arquivos`);
  return r;
}

// ---------- parlamentares, meta, votacoes.json ----------

interface Parl {
  resumo: ParlamentarIndice;
  casa: Casa;
  idExterno: string;
  perfil: string;
}

async function exportarParlamentares(): Promise<Map<string, Parl>> {
  const linhas = await sql<(LinhaParlamentarResumo & { id_externo: string; nome_civil: string | null })[]>`
    select id, casa, id_externo, nome, nome_civil, partido, uf, foto_url, em_exercicio from parlamentar`;
  const porId = new Map<string, Parl>();
  for (const l of linhas) {
    porId.set(l.id, {
      resumo: { ...parlamentarResumo(l), busca: normalizarBusca(l.nome, l.nome_civil) },
      casa: l.casa,
      idExterno: l.id_externo,
      perfil: urlOficialParlamentar(l.casa, l.id_externo),
    });
  }
  const colacao = new Intl.Collator("pt-BR", { sensitivity: "base" });
  const indice: ArquivoParlamentares = [...porId.values()]
    .map((p) => p.resumo)
    .sort((a, b) => colacao.compare(a.nome, b.nome) || (a.id < b.id ? -1 : 1));
  await gravarJson(caminhos.parlamentares(), indice);
  return porId;
}

async function exportarMeta(): Promise<void> {
  const health = (await (await app.request("/health")).json()) as Health;
  const meta: Meta = {
    versao: ESTATICO_VERSAO,
    geradoEm: new Date().toISOString(),
    dadosAte: health.dadosAte,
    tamanhoPagina: TAMANHO_PAGINA,
  };
  await gravarJson(caminhos.meta(), meta);
}

async function exportarVotacoes(): Promise<Map<string, VotacaoResumo>> {
  const linhas = await sql<LinhaVotacaoResumo[]>`
    ${selectVotacaoResumo()} where v.id in (select distinct ref_id from evento where tipo = 'voto')`;
  const mapa = new Map(linhas.map((l) => [l.id, votacaoResumo(l)]));
  const arquivo: ArquivoVotacoes = Object.fromEntries(mapa);
  await gravarJson(caminhos.votacoes(), arquivo);
  return mapa;
}

// ---------- feed ----------

// Monta os itens de um tipo em streaming. `geral` = os N mais recentes do tipo (todas as casas);
// senão, todos os eventos em ordem (parlamentar, ocorridoEm desc, id desc), um fluxo por vez.
type Hidratador = (geral: boolean) => AsyncIterable<{ parlamentarId: string; item: FeedItemCompacto }>;

const chave = (...p: (string | number)[]) => p.join("|");

function ordemEventos(geral: boolean) {
  return geral
    ? sql`order by e.ocorrido_em desc, e.id desc limit ${LIMITE_FEED_GERAL}`
    : sql`order by e.parlamentar_id, e.ocorrido_em desc, e.id desc`;
}

function hidratadorVoto(parls: Map<string, Parl>, votacoes: Map<string, VotacaoResumo>): Hidratador {
  // Maioria por partido em cada votação, calculada uma vez para a base toda (a API calcula por
  // página; o resultado por votação é o mesmo).
  let maiorias: Map<string, { sim: number; nao: number }> | null = null;
  return async function* (geral) {
    maiorias ??= new Map(
      (
        await sql<{ votacao_id: string; partido_na_hora: string; sim: number; nao: number }[]>`
          select votacao_id, partido_na_hora,
                 count(*) filter (where voto = 'sim')::int as sim,
                 count(*) filter (where voto = 'nao')::int as nao
          from voto where partido_na_hora is not null
          group by 1, 2`
      ).map((r) => [chave(r.votacao_id, r.partido_na_hora), { sim: r.sim, nao: r.nao }]),
    );
    const cursor = sql<
      { id: string; parlamentar_id: string; ocorrido_iso: string; ref_id: string; voto: VotoTipo; partido_na_hora: string | null }[]
    >`
      select e.id::text as id, e.parlamentar_id, to_char(e.ocorrido_em at time zone 'UTC', ${FMT_ISO}) as ocorrido_iso,
             e.ref_id, v.voto, v.partido_na_hora
      from evento e
      join voto v on v.votacao_id = e.ref_id and v.parlamentar_id = e.parlamentar_id
      where e.tipo = 'voto'
      ${ordemEventos(geral)}`.cursor(LOTE_CURSOR);
    for await (const lote of cursor) {
      for (const r of lote) {
        const p = parls.get(r.parlamentar_id);
        const votacao = votacoes.get(r.ref_id);
        if (!p || !votacao) continue;
        const m = r.partido_na_hora === null ? undefined : maiorias.get(chave(r.ref_id, r.partido_na_hora));
        yield {
          parlamentarId: r.parlamentar_id,
          item: {
            id: r.id,
            parlamentarId: r.parlamentar_id,
            ocorridoEm: r.ocorrido_iso,
            urlFonte: urlFonteVoto(votacao, p.perfil),
            tipo: "voto",
            votacaoId: r.ref_id,
            voto: r.voto,
            comOPartido: comOPartido(r.voto, r.partido_na_hora, m?.sim ?? null, m?.nao ?? null),
          },
        };
      }
    }
  };
}

function hidratadorProposicao(parls: Map<string, Parl>): Hidratador {
  return async function* (geral) {
    const cursor = sql<
      (LinhaProposicaoResumo & {
        evento_id: string;
        parlamentar_id: string;
        ocorrido_iso: string;
        tem_autoria: boolean;
        ordem: number | null;
        n_autores: number;
      })[]
    >`
      select e.id::text as evento_id, e.parlamentar_id, to_char(e.ocorrido_em at time zone 'UTC', ${FMT_ISO}) as ocorrido_iso,
             p.id, p.casa, p.sigla_tipo, p.numero, p.ano, p.ementa, p.url,
             a.proposicao_id is not null as tem_autoria, a.ordem, coalesce(n.n, 0) as n_autores
      from evento e
      join proposicao p on p.id = e.ref_id
      left join proposicao_autor a on a.proposicao_id = e.ref_id and a.parlamentar_id = e.parlamentar_id
      left join (select proposicao_id, count(*)::int as n from proposicao_autor group by 1) n on n.proposicao_id = e.ref_id
      where e.tipo = 'proposicao'
      ${ordemEventos(geral)}`.cursor(LOTE_CURSOR);
    for await (const lote of cursor) {
      for (const r of lote) {
        const p = parls.get(r.parlamentar_id);
        if (!p) continue;
        const proposicao = proposicaoResumo(r);
        yield {
          parlamentarId: r.parlamentar_id,
          item: {
            id: r.evento_id,
            parlamentarId: r.parlamentar_id,
            ocorridoEm: r.ocorrido_iso,
            urlFonte: urlFonteProposicao(proposicao, p.perfil),
            tipo: "proposicao",
            papel: papelAutoria(r.tem_autoria ? { ordem: r.ordem, n_autores: r.n_autores } : undefined),
            proposicao,
          },
        };
      }
    }
  };
}

function hidratadorDespesa(parls: Map<string, Parl>): Hidratador {
  let porMes: Map<string, { categoria: string; valor: number }[]> | null = null;
  return async function* (geral) {
    if (!porMes) {
      porMes = new Map();
      const linhas = await sql<{ parlamentar_id: string; ano: number; mes: number; categoria: string; valor: number }[]>`
        select parlamentar_id, ano, mes, categoria, round(sum(valor), 2)::float8 as valor
        from despesa group by 1, 2, 3, 4`;
      for (const d of linhas) {
        const k = chave(d.parlamentar_id, d.ano, d.mes);
        const l = porMes.get(k);
        if (l) l.push({ categoria: d.categoria, valor: d.valor });
        else porMes.set(k, [{ categoria: d.categoria, valor: d.valor }]);
      }
    }
    const cursor = sql<{ id: string; parlamentar_id: string; ocorrido_iso: string; ref_id: string }[]>`
      select e.id::text as id, e.parlamentar_id, to_char(e.ocorrido_em at time zone 'UTC', ${FMT_ISO}) as ocorrido_iso, e.ref_id
      from evento e
      where e.tipo = 'despesa_mensal'
      ${ordemEventos(geral)}`.cursor(LOTE_CURSOR);
    for await (const lote of cursor) {
      for (const r of lote) {
        const p = parls.get(r.parlamentar_id);
        const m = r.ref_id.match(RE_MES);
        if (!p || !m) continue;
        const ano = Number(m[1]);
        const mes = Number(m[2]);
        const { total, porCategoria } = resumoDespesa(porMes.get(chave(r.parlamentar_id, ano, mes)) ?? []);
        yield {
          parlamentarId: r.parlamentar_id,
          item: {
            id: r.id,
            parlamentarId: r.parlamentar_id,
            ocorridoEm: r.ocorrido_iso,
            urlFonte: urlFonteDespesa(p.casa, p.idExterno, ano, mes, p.perfil),
            tipo: "despesa_mensal",
            ano,
            mes,
            total,
            porCategoria,
          },
        };
      }
    }
  };
}

function hidratadorConsulta(parls: Map<string, Parl>): Hidratador {
  return async function* (geral) {
    // várias consultas na mesma proposição: vale a apuração mais recente (igual à API)
    const cursor = sql<
      (LinhaProposicaoResumo & {
        evento_id: string;
        parlamentar_id: string;
        ocorrido_iso: string;
        ref_id: string;
        resumo: unknown;
        url_fonte: string;
      })[]
    >`
      select e.id::text as evento_id, e.parlamentar_id, to_char(e.ocorrido_em at time zone 'UTC', ${FMT_ISO}) as ocorrido_iso,
             e.ref_id, e.resumo, c.url_fonte,
             p.id, p.casa, p.sigla_tipo, p.numero, p.ano, p.ementa, p.url
      from evento e
      join proposicao p on p.id = substring(e.ref_id from '^(.+):[0-9]{4}-(?:0[1-9]|1[0-2])$')
      join (
        select distinct on (proposicao_id) proposicao_id, url_fonte
        from consulta_publica
        order by proposicao_id, apurado_em desc
      ) c on c.proposicao_id = p.id
      where e.tipo = 'consulta_publica'
      ${ordemEventos(geral)}`.cursor(LOTE_CURSOR);
    for await (const lote of cursor) {
      for (const r of lote) {
        if (!parls.has(r.parlamentar_id)) continue;
        // mesma regra da API: ref_id fora do padrão ou resumo malformado = evento omitido
        if (!parseRefIdConsulta(r.ref_id)) continue;
        const resumo = lerResumoConsulta(r.resumo);
        // url fora do host/esquema oficial = evento omitido (mesma regra da API)
        if (!resumo || !urlFonteConsultaValida(r.url_fonte)) continue;
        yield {
          parlamentarId: r.parlamentar_id,
          item: {
            id: r.evento_id,
            parlamentarId: r.parlamentar_id,
            ocorridoEm: r.ocorrido_iso,
            urlFonte: r.url_fonte,
            tipo: "consulta_publica",
            proposicao: proposicaoResumo(r),
            votosSim: resumo.votosSim,
            votosNao: resumo.votosNao,
            apuradoEm: resumo.apuradoEm,
          },
        };
      }
    }
  };
}

async function gravarFluxo(itens: FeedItemCompacto[], caminho: (pagina: number) => string): Promise<void> {
  const paginas = Math.max(1, Math.ceil(itens.length / TAMANHO_PAGINA));
  for (let n = 1; n <= paginas; n++) {
    const pagina: PaginaFeed = {
      itens: itens.slice((n - 1) * TAMANHO_PAGINA, n * TAMANHO_PAGINA),
      proxima: n < paginas ? n + 1 : null,
      total: itens.length,
    };
    await gravarJson(caminho(n), pagina);
  }
}

async function exportarFeedTipo(tipo: FeedItemTipo, hidratar: Hidratador, parls: Map<string, Parl>): Promise<number> {
  // um fluxo por parlamentar: a consulta vem ordenada por parlamentar, então só um fluxo fica em memória
  let atual: string | null = null;
  let buf: FeedItemCompacto[] = [];
  let total = 0;
  const vistos = new Set<string>();
  const fechar = async () => {
    if (atual === null) return;
    vistos.add(atual);
    await gravarFluxo(buf, (n) => caminhos.feed(atual!, tipo, n));
  };
  for await (const { parlamentarId, item } of hidratar(false)) {
    if (parlamentarId !== atual) {
      await fechar();
      atual = parlamentarId;
      buf = [];
    }
    buf.push(item);
    total++;
  }
  await fechar();
  // todo fluxo tem a página 1, mesmo vazio
  for (const id of parls.keys()) if (!vistos.has(id)) await gravarFluxo([], (n) => caminhos.feed(id, tipo, n));

  const geral: FeedItemCompacto[] = [];
  for await (const { item } of hidratar(true)) geral.push(item);
  await gravarFluxo(geral, (n) => caminhos.feedGeral(tipo, n));
  return total;
}

// ---------- detalhes (via app da API) ----------

async function exportarDetalhes(
  ids: AsyncIterable<string[]> | string[][],
  rota: (id: string) => string,
  caminho: (id: string) => string,
): Promise<void> {
  const api = new Limitador(PARALELO_API);
  for await (const lote of ids) {
    for (const id of lote) {
      await api.add(async () => {
        const res = await app.request(rota(id));
        const corpo = await res.text();
        if (res.status !== 200) throw new Error(`${rota(id)} -> ${res.status}: ${corpo}`);
        await gravar(caminho(id), corpo);
      });
    }
  }
  await api.fim();
}

function idsDe(tabela: "votacao" | "proposicao"): AsyncIterable<string[]> {
  const q =
    tabela === "votacao"
      ? sql<{ id: string }[]>`select id from votacao order by id`
      : sql<{ id: string }[]>`select id from proposicao order by id`;
  const cursor = q.cursor(LOTE_CURSOR);
  return (async function* () {
    for await (const lote of cursor) yield lote.map((r) => r.id);
  })();
}

// ---------- principal ----------

async function main() {
  const t0 = performance.now();
  console.log(`saída: ${SAIDA}`);
  await rm(SAIDA, { recursive: true, force: true });
  await mkdir(SAIDA, { recursive: true });

  const parls = await etapa("parlamentares.json", exportarParlamentares);
  await etapa("meta.json", exportarMeta);
  const votacoes = await etapa("votacoes.json", exportarVotacoes);

  const hidratadores: Record<FeedItemTipo, Hidratador> = {
    voto: hidratadorVoto(parls, votacoes),
    proposicao: hidratadorProposicao(parls),
    despesa_mensal: hidratadorDespesa(parls),
    consulta_publica: hidratadorConsulta(parls),
  };
  for (const tipo of TIPOS_FEED) {
    await etapa(`feed ${tipo}`, async () => {
      const n = await exportarFeedTipo(tipo, hidratadores[tipo], parls);
      console.log(`  ${n} itens`);
    });
  }

  await etapa("p/", () =>
    exportarDetalhes([[...parls.keys()]], (id) => `/parlamentares/${encodeURIComponent(id)}`, caminhos.parlamentar),
  );
  await etapa("votacao/", () =>
    exportarDetalhes(idsDe("votacao"), (id) => `/votacoes/${encodeURIComponent(id)}`, caminhos.votacao),
  );
  await etapa("proposicao/", () =>
    exportarDetalhes(idsDe("proposicao"), (id) => `/proposicoes/${encodeURIComponent(id)}`, caminhos.proposicao),
  );

  console.log(`total: ${arquivos} arquivos em ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  await sql.end();
}

await main();
