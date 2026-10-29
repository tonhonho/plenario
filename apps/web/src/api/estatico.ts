import type {
  FeedItem,
  FeedItemTipo,
  Health,
  Pagina,
  Parlamentar,
  ParlamentarResumo,
  PartidoResumo,
  ProposicaoDetalhe,
  VotacaoDetalhe,
} from "@plenario/core/api";
import {
  caminhos,
  TIPOS_FEED,
  type ArquivoParlamentares,
  type ArquivoVotacoes,
  type FeedItemCompacto,
  type Meta,
  type PaginaFeed,
  type ParlamentarIndice,
} from "@plenario/core/estatico";
import { normalizarBusca } from "@plenario/core/texto";
import type { FiltroParlamentares, Fonte, InfoDados } from "./client";
import { ApiError } from "./erro";

// Fonte de dados do site estático (GitHub Pages, VITE_DADOS=estatico): lê os arquivos de
// packages/core/src/estatico.ts em vez da API, e devolve exatamente os mesmos formatos, para
// que hooks e telas não saibam de onde o dado veio.
//
// O que era consulta no servidor vira trabalho aqui:
// - busca e /partidos: sobre parlamentares.json (baixado uma vez);
// - feed: merge, no navegador, dos fluxos (parlamentar × tipo) paginados. Abre com a página
//   corrente de cada fluxo; a seguinte de um fluxo só é baixada quando ela se esgota no meio do
//   merge (é aí que o próximo item dele pode ser o próximo a sair), nunca por antecipação;
// - card de voto: o arquivo guarda só o id da votação; o resumo vem de votacoes.json.

const BASE_DADOS =
  (import.meta.env.VITE_DADOS_URL as string | undefined)?.replace(/\/?$/, "/") ??
  `${import.meta.env.BASE_URL}data/`;

const PAGINA = 30;
const MAX_PARLAMENTARES_FEED = 200;
const CONCORRENCIA = 8;

// ---------- download com cache e concorrência limitada ----------

let emUso = 0;
const fila: (() => void)[] = [];

async function comVaga<T>(fn: () => Promise<T>): Promise<T> {
  if (emUso >= CONCORRENCIA) await new Promise<void>((r) => fila.push(r));
  emUso++;
  try {
    return await fn();
  } finally {
    emUso--;
    fila.shift()?.();
  }
}

async function baixar(caminho: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(BASE_DADOS + caminho, { headers: { Accept: "application/json" } });
  } catch {
    throw new ApiError("Não foi possível conectar. Verifique sua conexão.", 0);
  }
  if (res.status === 404) throw new ApiError("Não há registro com este endereço nos dados publicados.", 404);
  if (!res.ok) throw new ApiError(`Erro ${res.status} ao baixar os dados.`, res.status);
  // servidor com fallback de SPA (vite dev, 404.html) devolve HTML para arquivo que não existe
  if (!(res.headers.get("content-type") ?? "").includes("json")) {
    throw new ApiError("Não há registro com este endereço nos dados publicados.", 404);
  }
  return res.json();
}

// Os arquivos não mudam durante a sessão (são gerados uma vez por dia): cache por caminho.
// O download não recebe o AbortSignal da tela, senão um cancelamento envenenaria o cache.
const cache = new Map<string, Promise<unknown>>();

function buscar<T>(caminho: string): Promise<T> {
  let p = cache.get(caminho);
  if (!p) {
    p = comVaga(() => baixar(caminho));
    cache.set(caminho, p);
    p.catch(() => cache.delete(caminho));
  }
  return p as Promise<T>;
}

// 2026-10-28: tolerância transitória a 404 do fluxo consulta_publica. Existe porque o export já
// publicado no site é anterior a esse fluxo, então o arquivo pode não existir: 404 nele vira página
// vazia. Só para esse tipo; erro de download não vai para o cache (buscar já apaga).
// Remover quando o export com consulta_publica estiver publicado no site: apagar o campo tolerante404
// de Fluxo, suas duas montagens e o ramo de 404 em paginaDo.
async function paginaDo(f: Fluxo, pagina: number): Promise<PaginaFeed> {
  try {
    return await buscar<PaginaFeed>(f.arquivo(pagina));
  } catch (erro) {
    if (f.tolerante404 && erro instanceof ApiError && erro.status === 404) {
      return { itens: [], proxima: null, total: 0 };
    }
    throw erro;
  }
}

// ---------- índice de parlamentares e votações ----------

let mapaIndice: Promise<Map<string, ParlamentarIndice>> | null = null;

function indice(): Promise<ArquivoParlamentares> {
  return buscar<ArquivoParlamentares>(caminhos.parlamentares());
}

function indicePorId(): Promise<Map<string, ParlamentarIndice>> {
  mapaIndice ??= indice().then((l) => new Map(l.map((p) => [p.id, p])));
  mapaIndice.catch(() => (mapaIndice = null));
  return mapaIndice;
}

function resumo(p: ParlamentarIndice): ParlamentarResumo {
  const { id, casa, nome, partido, uf, fotoUrl, emExercicio } = p;
  return { id, casa, nome, partido, uf, fotoUrl, emExercicio };
}

const votacoes = () => buscar<ArquivoVotacoes>(caminhos.votacoes());

/** Remonta o FeedItem do contrato da API; null se faltar a referência (arquivo inconsistente). */
function remontar(
  c: FeedItemCompacto,
  idx: Map<string, ParlamentarIndice>,
  vots: ArquivoVotacoes | null,
): FeedItem | null {
  const p = idx.get(c.parlamentarId);
  if (!p) return null;
  const base = { id: c.id, ocorridoEm: c.ocorridoEm, urlFonte: c.urlFonte, parlamentar: resumo(p) };
  switch (c.tipo) {
    case "voto": {
      const votacao = vots?.[c.votacaoId];
      if (!votacao) return null;
      return { ...base, tipo: "voto", voto: c.voto, votacao, comOPartido: c.comOPartido };
    }
    case "proposicao":
      return { ...base, tipo: "proposicao", papel: c.papel, proposicao: c.proposicao };
    case "despesa_mensal":
      return {
        ...base,
        tipo: "despesa_mensal",
        ano: c.ano,
        mes: c.mes,
        total: c.total,
        porCategoria: c.porCategoria,
      };
    case "consulta_publica":
      return {
        ...base,
        tipo: "consulta_publica",
        proposicao: c.proposicao,
        votosSim: c.votosSim,
        votosNao: c.votosNao,
        apuradoEm: c.apuradoEm,
      };
  }
}

// ---------- merge de fluxos ----------

interface Fluxo {
  chave: string;
  arquivo: (pagina: number) => string;
  tolerante404: boolean;
}

// Cursor: posição de cada fluxo que já andou. Ausente = início (página 1, item 0); 0 = acabou.
type Cursor = Record<string, [pagina: number, item: number] | 0>;

/** Ordem do feed: ocorridoEm desc, id desc (numérico). */
function vemAntes(a: FeedItemCompacto, b: FeedItemCompacto): boolean {
  // ISO UTC de formato fixo: comparar a string já é comparar o instante
  if (a.ocorridoEm !== b.ocorridoEm) return a.ocorridoEm > b.ocorridoEm;
  // id é inteiro em texto: compara como número ("999" vem depois de "1000")
  return Number(a.id) > Number(b.id);
}

async function mesclar(fluxos: Fluxo[], cursorTexto: string | null | undefined): Promise<Pagina<FeedItem>> {
  let cursor: Cursor = {};
  if (cursorTexto) {
    try {
      cursor = JSON.parse(cursorTexto) as Cursor;
    } catch {
      throw new ApiError("Cursor inválido.", 400);
    }
  }

  const estados = fluxos
    .filter((f) => cursor[f.chave] !== 0)
    .map((f) => {
      const pos = cursor[f.chave] || [1, 0];
      return { f, pagina: pos[0], item: pos[1], dados: null as PaginaFeed | null, acabou: false };
    });

  // página corrente de cada fluxo vivo (a concorrência fica limitada em `buscar`)
  await Promise.all(
    estados.map(async (e) => {
      e.dados = await paginaDo(e.f, e.pagina);
    }),
  );

  const saida: FeedItemCompacto[] = [];
  while (saida.length < PAGINA) {
    let escolhido: (typeof estados)[number] | null = null;
    let cabeca: FeedItemCompacto | null = null;
    for (const e of estados) {
      if (e.acabou) continue;
      let d = e.dados!;
      if (e.item >= d.itens.length) {
        if (d.proxima === null) {
          e.acabou = true;
          continue;
        }
        // Página consumida e o merge ainda precisa de item: o próximo deste fluxo pode ser o
        // próximo a sair, então só agora baixa a página seguinte dele (e só dele).
        e.pagina = d.proxima;
        e.item = 0;
        d = e.dados = await paginaDo(e.f, e.pagina);
        if (d.itens.length === 0) {
          if (d.proxima === null) e.acabou = true;
          continue;
        }
      }
      const item = d.itens[e.item]!;
      if (!cabeca || vemAntes(item, cabeca)) {
        escolhido = e;
        cabeca = item;
      }
    }
    if (!escolhido || !cabeca) {
      // fluxo que caiu numa página vazia com continuação: dá mais uma volta
      if (estados.some((e) => !e.acabou && e.item >= e.dados!.itens.length && e.dados!.proxima !== null)) continue;
      break;
    }
    saida.push(cabeca);
    escolhido.item++;
  }

  const proximoCursor: Cursor = { ...cursor };
  let temMais = false;
  for (const e of estados) {
    const d = e.dados!;
    const fim = e.acabou || (e.item >= d.itens.length && d.proxima === null);
    if (fim) proximoCursor[e.f.chave] = 0;
    else {
      temMais = true;
      if (e.pagina !== 1 || e.item !== 0) proximoCursor[e.f.chave] = [e.pagina, e.item];
    }
  }

  const [idx, vots] = await Promise.all([
    indicePorId(),
    saida.some((c) => c.tipo === "voto") ? votacoes() : Promise.resolve(null),
  ]);
  const itens: FeedItem[] = [];
  for (const c of saida) {
    const item = remontar(c, idx, vots);
    if (item) itens.push(item);
    else console.warn("[plenario] card sem parlamentar/votação no índice, ignorado:", c.id);
  }
  return { itens, proximo: temMais ? JSON.stringify(proximoCursor) : null };
}

function tiposOuTodos(tipos: FeedItemTipo[] | undefined): FeedItemTipo[] {
  return tipos?.length ? TIPOS_FEED.filter((t) => tipos.includes(t)) : TIPOS_FEED;
}

function fluxosDe(ids: string[], tipos: FeedItemTipo[] | undefined): Fluxo[] {
  return ids.flatMap((id) =>
    tiposOuTodos(tipos).map((t) => ({
      chave: `${id}|${t}`,
      arquivo: (n: number) => caminhos.feed(id, t, n),
      tolerante404: t === "consulta_publica",
    })),
  );
}

// ---------- busca ----------

function filtrar(lista: ArquivoParlamentares, f: FiltroParlamentares): ParlamentarIndice[] {
  const termo = normalizarBusca(f.q);
  const filtrada = lista.filter(
    (p) =>
      (!f.casa || p.casa === f.casa) &&
      (!f.partido || p.partido === f.partido) &&
      (!f.uf || p.uf === f.uf) &&
      (!termo || p.busca.includes(termo)),
  );
  if (!termo) return filtrada; // índice já vem por nome
  // relevância simples, nome de urna antes do nome civil: o nome começa com o termo > uma
  // palavra do nome começa com ele > uma palavra do nome civil > contém em qualquer lugar
  const nivel = (p: ParlamentarIndice) => {
    const nome = nomeNormalizado(p);
    if (nome.startsWith(termo)) return 0;
    if (` ${nome}`.includes(` ${termo}`)) return 1;
    if (` ${p.busca}`.includes(` ${termo}`)) return 2;
    return 3;
  };
  return filtrada
    .map((p, i) => ({ p, i, n: nivel(p) }))
    .sort((a, b) => a.n - b.n || a.i - b.i)
    .map((x) => x.p);
}

const nomes = new WeakMap<ParlamentarIndice, string>();
function nomeNormalizado(p: ParlamentarIndice): string {
  let n = nomes.get(p);
  if (n === undefined) nomes.set(p, (n = normalizarBusca(p.nome)));
  return n;
}

// ---------- a fonte ----------

async function info(): Promise<InfoDados> {
  const m = await buscar<Meta>(caminhos.meta());
  return { dadosAte: m.dadosAte, geradoEm: m.geradoEm };
}

export const fonteEstatica: Fonte = {
  health: async () => {
    const m = await buscar<Meta>(caminhos.meta());
    return { ok: true, versao: `estatico-${m.versao}`, dadosAte: m.dadosAte } satisfies Health;
  },

  infoDados: info,

  parlamentares: async (f, cursor) => {
    const lista = filtrar(await indice(), f);
    const inicio = Number(cursor) || 0;
    const fim = inicio + PAGINA;
    return { itens: lista.slice(inicio, fim).map(resumo), proximo: fim < lista.length ? String(fim) : null };
  },

  parlamentaresPorIds: async (ids) => {
    const idx = await indicePorId();
    return {
      itens: ids.flatMap((id) => {
        const p = idx.get(id);
        return p ? [resumo(p)] : [];
      }),
      proximo: null,
    };
  },

  parlamentar: (id) => buscar<Parlamentar>(caminhos.parlamentar(id)),

  feedParlamentar: (id, tipos, cursor) => mesclar(fluxosDe([id], tipos), cursor),

  feed: (ids, tipos, cursor) =>
    ids?.length
      ? mesclar(fluxosDe(ids.slice(0, MAX_PARLAMENTARES_FEED), tipos), cursor)
      : mesclar(
          tiposOuTodos(tipos).map((t) => ({
            chave: `geral|${t}`,
            arquivo: (n: number) => caminhos.feedGeral(t, n),
            tolerante404: t === "consulta_publica",
          })),
          cursor,
        ),

  votacao: (id) => buscar<VotacaoDetalhe>(caminhos.votacao(id)),

  // `consulta ?? null`: o site publicado antes da f327 tem proposicao/<id>.json sem o campo; sem
  // isto a tela leria undefined. Arquivo antigo = sem placar (bloco ausente), não erro.
  proposicao: async (id) => {
    const p = await buscar<ProposicaoDetalhe>(caminhos.proposicao(id));
    return { ...p, consulta: p.consulta ?? null };
  },

  partidos: async () => {
    const contagem = new Map<string, number>();
    for (const p of await indice()) if (p.partido) contagem.set(p.partido, (contagem.get(p.partido) ?? 0) + 1);
    return [...contagem.entries()]
      .map(([sigla, total]): PartidoResumo => ({ sigla, total }))
      .sort((a, b) => b.total - a.total || a.sigla.localeCompare(b.sigla, "pt-BR"));
  },
};
