// Confere um export contra a API rodando: detalhes idênticos (deepEqual) e feed com a mesma
// sequência de ids. Uso: bun --env-file=../../.env src/conferir.ts [--saida <dir>] [--api <url>]
import { deepStrictEqual } from "node:assert";
import { join, resolve } from "node:path";
import { sql } from "@plenario/core/db";
import type { FeedItem, FeedItemTipo, Pagina } from "@plenario/core/api";
import { TIPOS_FEED, caminhos, type PaginaFeed } from "@plenario/core/estatico";
import { ordenarPorMicrossegundo, primeiraQuebraDeOrdem } from "./ordem";

const arg = (nome: string) => {
  const i = process.argv.indexOf(nome);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const SAIDA = resolve(arg("--saida") ?? join(import.meta.dir, "../../web/public/data"));
const API = arg("--api") ?? `http://localhost:${process.env.API_PORT ?? 8787}`;

const lerArquivo = (rel: string) => Bun.file(join(SAIDA, rel)).json();
async function lerApi<T>(path: string): Promise<T> {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return (await r.json()) as T;
}

let falhas = 0;
function conferir(nome: string, fn: () => void) {
  try {
    fn();
  } catch (e) {
    falhas++;
    console.log(`FALHA ${nome}: ${(e as Error).message.slice(0, 400)}`);
  }
}

async function amostra(q: Promise<{ id: string }[]>) {
  return (await q).map((r) => r.id);
}

// 1. detalhes
const parls = await amostra(sql`select id from parlamentar order by random() limit 20`);
const votacoes = await amostra(sql`
  (select id from votacao where nominal order by random() limit 10)
  union all (select id from votacao where not nominal order by random() limit 10)`);
const proposicoes = await amostra(sql`
  (select id from (select distinct proposicao_id as id from votacao where proposicao_id is not null) x order by random() limit 10)
  union all (select id from proposicao order by random() limit 10)`);

for (const id of parls) {
  const [a, b] = await Promise.all([lerArquivo(caminhos.parlamentar(id)), lerApi(`/parlamentares/${id}`)]);
  conferir(`p/${id}`, () => deepStrictEqual(a, b));
}
for (const id of votacoes) {
  const [a, b] = await Promise.all([lerArquivo(caminhos.votacao(id)), lerApi(`/votacoes/${id}`)]);
  conferir(`votacao/${id}`, () => deepStrictEqual(a, b));
}
for (const id of proposicoes) {
  const [a, b] = await Promise.all([lerArquivo(caminhos.proposicao(id)), lerApi(`/proposicoes/${id}`)]);
  conferir(`proposicao/${id}`, () => deepStrictEqual(a, b));
}
console.log(`detalhes: ${parls.length} parlamentares, ${votacoes.length} votações, ${proposicoes.length} proposições`);

// 2. feed por parlamentar: merge dos três fluxos == /parlamentares/:id/feed paginado
async function fluxo(caminho: (n: number) => string): Promise<PaginaFeed["itens"]> {
  const itens: PaginaFeed["itens"] = [];
  let n: number | null = 1;
  while (n !== null) {
    const p = (await lerArquivo(caminho(n))) as PaginaFeed;
    itens.push(...p.itens);
    if (p.total < itens.length) throw new Error("total menor que os itens lidos");
    n = p.proxima;
  }
  return itens;
}

async function apiPaginada(path: string, max = Infinity): Promise<FeedItem[]> {
  const itens: FeedItem[] = [];
  let cursor: string | null = null;
  do {
    const sep = path.includes("?") ? "&" : "?";
    const p: Pagina<FeedItem> = await lerApi(cursor ? `${path}${sep}cursor=${cursor}` : path);
    itens.push(...p.itens);
    cursor = p.proximo;
  } while (cursor && itens.length < max);
  return itens.slice(0, max);
}

// A API ordena por ocorrido_em em us; o ISO exportado so tem ms. Le o us do banco para ordenar igual.
async function usDosIds(ids: string[]): Promise<Map<string, bigint>> {
  if (ids.length === 0) return new Map();
  const rows = await sql<{ id: string; us: string }[]>`
    select id::text as id, (extract(epoch from ocorrido_em) * 1000000)::bigint::text as us
    from evento where id = any(${ids}::bigint[])`;
  return new Map(rows.map((r) => [r.id, BigInt(r.us)]));
}

const feedParls = await amostra(sql`
  (select parlamentar_id as id from evento group by 1 order by count(*) desc limit 2)
  union all (select id from parlamentar order by random() limit 8)`);
let itensConferidos = 0;
for (const id of feedParls) {
  const fluxos = await Promise.all(TIPOS_FEED.map((t) => fluxo((n) => caminhos.feed(id, t, n))));
  const todos = fluxos.flat();
  const usPorId = await usDosIds(todos.map((i) => i.id));
  const merge = ordenarPorMicrossegundo(todos, usPorId);
  // o merge reordena, entao a ordem de cada arquivo exportado e conferida a parte
  TIPOS_FEED.forEach((tipo, k) => {
    const fluxoTipo = fluxos[k]!;
    conferir(`feed ${id} ${tipo} ordem`, () => {
      const q = primeiraQuebraDeOrdem(fluxoTipo, usPorId);
      if (q !== null) {
        throw new Error(
          `fora de ordem no indice ${q}: ids ${fluxoTipo[q - 1]!.id} (${fluxoTipo[q - 1]!.ocorridoEm}, us ${usPorId.get(fluxoTipo[q - 1]!.id) ?? "?"}), ${fluxoTipo[q]!.id} (${fluxoTipo[q]!.ocorridoEm}, us ${usPorId.get(fluxoTipo[q]!.id) ?? "?"})`,
        );
      }
    });
  });
  const api = await apiPaginada(`/parlamentares/${id}/feed`);
  itensConferidos += api.length;
  conferir(`feed ${id} ids`, () => deepStrictEqual(merge.map((i) => i.id), api.map((i) => i.id)));
  // conteúdo do card: os campos compactos têm de bater com o FeedItem da API
  conferir(`feed ${id} conteúdo`, () =>
    deepStrictEqual(merge.map(compactar), api.map(compactar)),
  );
}
console.log(`feed por parlamentar: ${feedParls.length} parlamentares, ${itensConferidos} itens`);

function compactar(i: FeedItem | PaginaFeed["itens"][number]): unknown {
  const { parlamentar, votacao, ...resto } = i as unknown as Record<string, unknown> & { parlamentar?: { id: string }; votacao?: { id: string } };
  const r: Record<string, unknown> = { ...resto };
  if (parlamentar) r.parlamentarId = parlamentar.id;
  if (votacao) r.votacaoId = votacao.id;
  return r;
}

// 3. feed geral: início de cada tipo == /feed?tipos=<tipo>
for (const tipo of TIPOS_FEED as FeedItemTipo[]) {
  const arq = await fluxo((n) => caminhos.feedGeral(tipo, n));
  const api = await apiPaginada(`/feed?tipos=${tipo}`, 600);
  conferir(`geral ${tipo}`, () => deepStrictEqual(arq.slice(0, api.length).map((i) => i.id), api.map((i) => i.id)));
}
console.log("feed geral: 600 primeiros de cada tipo");

await sql.end();
console.log(falhas === 0 ? "OK: tudo idêntico" : `${falhas} falha(s)`);
process.exit(falhas === 0 ? 0 : 1);
