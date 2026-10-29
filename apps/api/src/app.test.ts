import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { FeedItem, FeedItemVoto, Pagina, Parlamentar, ParlamentarResumo, ProposicaoDetalhe, VotacaoDetalhe } from "@plenario/core/api";

// db.ts lê DATABASE_URL na importação: troca pro banco de teste antes de importar o app.
// Os testes apagam as tabelas, então se recusam a rodar fora de um banco "*_test".
const URL_TESTE = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/plenario_test";
if (!/_test(\?.*)?$/.test(URL_TESTE)) throw new Error(`banco de teste precisa terminar em _test: ${URL_TESTE}`);
process.env.DATABASE_URL = URL_TESTE;

const { app } = await import("./app");
const { sql } = await import("@plenario/core/db");
const { normalizarBusca } = await import("@plenario/core/texto");
const { urlCotaCamara } = await import("./util");
const { TAMANHO_PAGINA } = await import("./feed");

async function get<T>(path: string): Promise<{ status: number; body: T; res: Response }> {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as T, res };
}

const parlamentares = [
  // id, nome, nomeCivil, partido, uf
  ["camara:1", "João da Silva", "João Carlos da Silva", "PT", "SP"],
  ["camara:3", "Ângela Souza", null, "PT", "SP"],
  ["camara:6", "Zé Ninguém", null, "PT", "MG"],
  ["camara:2", "Maria Conceição", null, "PL", "RJ"],
  ["camara:4", "Pedro Álvares", null, "PSOL", "BA"],
  ["senado:10", "José Serra", "José Serra Chirico", "PSDB", "SP"],
] as const;

// Eventos de enchimento pra paginação: vários com o mesmo instante (desempate por id) e alguns
// separados por 1 µs (o cursor não pode truncar pra milissegundo).
const N_ENCHIMENTO = 70;

const URL_CONSULTA_BASE = "https://www12.senado.leg.br/ecidadania/visualizacaomateria?id=123";
const RESUMO_OK = { votosSim: 120, votosNao: 30, apuradoEm: "2026-09-28T10:00:00.000Z" };
type ResumoSemeado = Record<string, string | number | null> | null;
let idConsultaBase = "";

async function semearEvento(parlamentarId: string, ocorridoEm: string, refId: string, resumo: ResumoSemeado): Promise<string> {
  const [r] = await sql<{ id: string }[]>`insert into evento (parlamentar_id, tipo, ocorrido_em, ref_id, resumo)
    values (${parlamentarId}, 'consulta_publica', ${ocorridoEm}::timestamptz, ${refId}, ${resumo === null ? null : JSON.stringify(resumo)}::jsonb)
    returning id::text as id`;
  return r!.id;
}

async function apagarEventos(ids: string[]): Promise<void> {
  if (ids.length > 0) await sql`delete from evento where id = any(${ids}::bigint[])`;
}

async function idsFeed(path: string): Promise<string[]> {
  return (await percorrer(path)).ids;
}

async function itensConsulta(path: string): Promise<Extract<FeedItem, { tipo: "consulta_publica" }>[]> {
  const { paginas } = await percorrer(path);
  return paginas.flatMap((p) => p.itens).filter((i): i is Extract<FeedItem, { tipo: "consulta_publica" }> => i.tipo === "consulta_publica");
}

beforeAll(async () => {
  await sql`truncate evento, despesa, voto, votacao, exercicio, proposicao_autor, consulta_publica, proposicao, parlamentar restart identity cascade`;

  for (const [id, nome, civil, partido, uf] of parlamentares) {
    const [casa, ext] = id.split(":");
    await sql`insert into parlamentar (id, casa, id_externo, nome, nome_civil, partido, uf, busca)
      values (${id}, ${casa!}::casa, ${ext!}, ${nome}, ${civil}, ${partido}, ${uf}, ${normalizarBusca(nome, civil)})`;
  }

  await sql`insert into proposicao (id, casa, id_externo, sigla_tipo, numero, ano, ementa, url, data_apresentacao) values
    ('camara:p1', 'camara', 'p1', 'PL', 1234, 2026, 'Ementa do PL', 'https://www.camara.leg.br/propostas-legislativas/p1', '2026-09-01T12:00:00Z')`;
  await sql`insert into proposicao_autor (proposicao_id, parlamentar_id, ordem, proponente) values
    ('camara:p1', 'camara:1', 1, true), ('camara:p1', 'camara:3', 2, true)`;
  for (let i = 0; i < N_ENCHIMENTO; i++) {
    await sql`insert into proposicao (id, casa, id_externo, sigla_tipo, numero, ano) values (${"camara:f" + i}, 'camara', ${"f" + i}, 'REQ', ${i}, 2026)`;
    await sql`insert into proposicao_autor (proposicao_id, parlamentar_id, ordem) values (${"camara:f" + i}, 'camara:3', null)`;
  }

  // v1..v5 nominais; camara:1 vota em v1, v2, v3 (ausente), v5 (obstrução) e não aparece em v4
  const votacoes = [
    ["camara:v1", "2026-09-10T15:00:00Z", true],
    ["camara:v2", "2026-09-11T15:00:00Z", true],
    ["camara:v3", "2026-09-12T15:00:00Z", true],
    ["camara:v4", "2026-09-13T15:00:00Z", true],
    ["camara:v5", "2026-09-14T15:00:00Z", true],
    ["camara:v6", "2026-09-20T15:00:00Z", true], // fora da janela de camara:1
    ["camara:s1", "2026-09-12T16:00:00Z", false],
    ["camara:c1", "2026-09-12T17:00:00Z", true], // comissão: fora da conta de presença
    ["camara:v7", "2026-09-25T15:00:00Z", true], // sem proposição e sem url
    ["camara:v8", "2026-09-12T18:00:00Z", true], // secreta: fora da conta de presença
    ["camara:v9", "2026-09-11T02:30:00Z", true], // 10/09 23h30 em Brasília
  ] as const;
  for (const [id, quando, nominal] of votacoes) {
    await sql`insert into votacao (id, casa, id_externo, data_hora, orgao, descricao, proposicao_id, aprovada, nominal,
        secreta, url, placar_sim, placar_nao, placar_outros)
      values (${id}, 'camara', ${id.slice(7)}, ${quando}, ${id === "camara:c1" ? "CCJC" : "PLEN"}, ${"Votação " + id},
        ${id === "camara:v7" ? null : "camara:p1"}, true, ${nominal}, ${id === "camara:v8"},
        ${id === "camara:v1" ? "https://www.camara.leg.br/votacao/v1" : null}, 3, 1, 0)`;
  }
  // camara:3 de licença entre 11/09 e 13/09: dois períodos de exercício, o último em aberto
  await sql`insert into exercicio (parlamentar_id, inicio, fim, motivo_fim) values
    ('camara:3', '2026-09-01', '2026-09-10', 'Licença'), ('camara:3', '2026-09-14', null, null)`;
  const votos: [string, string, string, string | null][] = [
    // v1: PT sim, sim, nao -> maioria sim
    ["camara:v1", "camara:1", "sim", "PT"],
    ["camara:v1", "camara:3", "sim", "PT"],
    ["camara:v1", "camara:6", "nao", "PT"],
    ["camara:v1", "camara:4", "sim", "PSOL"], // único do partido -> null
    ["camara:v1", "camara:2", "nao", null], // sem partido -> null
    // v2: PT empata 1x1 -> null
    ["camara:v2", "camara:1", "nao", "PT"],
    ["camara:v2", "camara:3", "sim", "PT"],
    ["camara:v3", "camara:1", "ausente", "PT"],
    ["camara:v5", "camara:1", "obstrucao", "PT"],
    ["camara:v6", "camara:3", "sim", "PT"],
    ["camara:v7", "camara:3", "ausente", "PT"],
  ];
  for (const [votacaoId, parlId, v, partido] of votos) {
    await sql`insert into voto (votacao_id, parlamentar_id, voto, partido_na_hora) values (${votacaoId}, ${parlId}, ${v}::voto_tipo, ${partido})`;
  }

  const ano = Number(new Intl.DateTimeFormat("en", { timeZone: "America/Sao_Paulo", year: "numeric" }).format(new Date()));
  const despesas: [string, number, string, string][] = [
    ["d1", 9, "PASSAGEM AÉREA", "1000.10"],
    ["d2", 9, "PASSAGEM AÉREA", "500.00"],
    ["d3", 9, "COMBUSTÍVEL", "300.00"],
    ["d4", 9, "TELEFONIA", "50.00"],
    ["d5", 9, "DIVULGAÇÃO", "2000.00"],
    ["d6", 9, "HOSPEDAGEM", "400.00"],
    ["d7", 9, "ALIMENTAÇÃO", "10.00"],
  ];
  for (const [id, mes, cat, valor] of despesas) {
    await sql`insert into despesa (id, parlamentar_id, ano, mes, categoria, valor) values (${"camara:" + id}, 'camara:1', 2026, ${mes}, ${cat}, ${valor})`;
  }
  await sql`insert into despesa (id, parlamentar_id, ano, mes, categoria, valor) values ('camara:dano', 'camara:1', ${ano}, 1, 'X', '1.00')
    on conflict do nothing`;

  await sql`insert into evento (parlamentar_id, tipo, ocorrido_em, ref_id) values
    ('camara:1', 'voto', '2026-09-10T15:00:00Z', 'camara:v1'),
    ('camara:3', 'voto', '2026-09-10T15:00:00Z', 'camara:v1'),
    ('camara:6', 'voto', '2026-09-10T15:00:00Z', 'camara:v1'),
    ('camara:4', 'voto', '2026-09-10T15:00:00Z', 'camara:v1'),
    ('camara:2', 'voto', '2026-09-10T15:00:00Z', 'camara:v1'),
    ('camara:1', 'voto', '2026-09-11T15:00:00Z', 'camara:v2'),
    ('camara:1', 'voto', '2026-09-14T15:00:00Z', 'camara:v5'),
    ('camara:1', 'proposicao', '2026-09-01T12:00:00Z', 'camara:p1'),
    ('camara:3', 'proposicao', '2026-09-01T12:00:00Z', 'camara:p1'),
    ('camara:1', 'despesa_mensal', '2026-09-30T23:00:00Z', '2026-09'),
    ('camara:3', 'voto', '2026-09-25T15:00:00Z', 'camara:v7')`;
  for (let i = 0; i < N_ENCHIMENTO; i++) {
    // grupos de 10 no mesmo instante, e dentro de cada grupo metade separada por 1 µs
    const base = `2026-09-0${1 + Math.floor(i / 10)}T10:00:00.000`;
    const us = i % 2 === 0 ? "000" : "001";
    await sql`insert into evento (parlamentar_id, tipo, ocorrido_em, ref_id)
      values ('camara:3', 'proposicao', ${base + us + "Z"}::timestamptz, ${"camara:f" + i})`;
  }

  // consulta pública: proposição do Senado (ref_id com ":" no id) + a apuração + o evento do autor
  await sql`insert into proposicao (id, casa, id_externo, sigla_tipo, numero, ano, ementa, url) values
    ('senado:123', 'senado', '123', 'PLS', 123, 2026, 'Ementa da consulta', 'https://www25.senado.leg.br/web/atividade/materias/-/materia/123')`;
  await sql`insert into consulta_publica (materia_cod, proposicao_id, votos_sim, votos_nao, apurado_em, url_fonte) values
    ('9001', 'senado:123', 120, 30, '2026-09-28T10:00:00Z', ${URL_CONSULTA_BASE})`;
  idConsultaBase = await semearEvento("camara:1", "2026-09-28T12:00:00Z", "senado:123:2026-09", RESUMO_OK);
});

afterAll(async () => {
  await sql.end();
});

async function idsEsperados(filtro = sql``): Promise<string[]> {
  const r = await sql<{ id: string }[]>`select id::text as id from evento e where true ${filtro} order by e.ocorrido_em desc, e.id desc`; // e.id: sem o prefixo, "id" é o alias texto e ordena lexicograficamente
  return r.map((x) => x.id);
}

async function percorrer(path: string): Promise<{ ids: string[]; paginas: Pagina<FeedItem>[] }> {
  const ids: string[] = [];
  const paginas: Pagina<FeedItem>[] = [];
  let cursor: string | null = null;
  const sep = path.includes("?") ? "&" : "?";
  do {
    const url: string = cursor ? `${path}${sep}cursor=${cursor}` : path;
    const { status, body }: { status: number; body: Pagina<FeedItem> } = await get<Pagina<FeedItem>>(url);
    expect(status).toBe(200);
    paginas.push(body);
    ids.push(...body.itens.map((i) => i.id));
    cursor = body.proximo;
    if (paginas.length > 50) throw new Error("loop de paginação");
  } while (cursor);
  return { ids, paginas };
}

describe("health", () => {
  test("dadosAte = maior ocorrido_em", async () => {
    const { status, body, res } = await get<{ ok: boolean; dadosAte: string }>("/health");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.dadosAte).toBe("2026-09-30T23:00:00.000Z");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("parlamentares", () => {
  test("busca sem acento acha nome acentuado", async () => {
    for (const q of ["joao", "JOÃO", "angela", "ângela", "alvares"]) {
      const { status, body } = await get<Pagina<ParlamentarResumo>>(`/parlamentares?q=${encodeURIComponent(q)}`);
      expect(status).toBe(200);
      expect(body.itens.length).toBeGreaterThan(0);
      expect(normalizarBusca(body.itens[0]!.nome)).toContain(normalizarBusca(q));
    }
  });

  test("busca tolera erro de digitação e acha por nome civil", async () => {
    const r1 = await get<Pagina<ParlamentarResumo>>("/parlamentares?q=conceicao");
    expect(r1.body.itens[0]?.id).toBe("camara:2");
    const r2 = await get<Pagina<ParlamentarResumo>>("/parlamentares?q=chirico");
    expect(r2.body.itens[0]?.id).toBe("senado:10");
    const r3 = await get<Pagina<ParlamentarResumo>>("/parlamentares?q=jose serrra");
    expect(r3.body.itens[0]?.id).toBe("senado:10");
  });

  test("filtros e paginação por nome", async () => {
    const pt = await get<Pagina<ParlamentarResumo>>("/parlamentares?partido=pt&uf=sp");
    expect(pt.body.itens.map((p) => p.id).sort()).toEqual(["camara:1", "camara:3"]);
    const sen = await get<Pagina<ParlamentarResumo>>("/parlamentares?casa=senado");
    expect(sen.body.itens.map((p) => p.id)).toEqual(["senado:10"]);

    const vistos: string[] = [];
    let cursor: string | null = null;
    do {
      const r: { body: Pagina<ParlamentarResumo> } = await get(`/parlamentares?limite=2${cursor ? `&cursor=${cursor}` : ""}`);
      vistos.push(...r.body.itens.map((p) => p.nome));
      cursor = r.body.proximo;
    } while (cursor);
    // ordem alfabética ignorando acento: Ângela antes de João
    expect(vistos).toEqual(["Ângela Souza", "João da Silva", "José Serra", "Maria Conceição", "Pedro Álvares", "Zé Ninguém"]);
  });

  test("detalhe com estatísticas e presença aproximada", async () => {
    const { status, body } = await get<Parlamentar>("/parlamentares/camara:1");
    expect(status).toBe(200);
    expect(body.urlOficial).toBe("https://www.camara.leg.br/deputados/1");
    expect(body.nomeCivil).toBe("João Carlos da Silva");
    // sem exercício: janela aproximada v1..v5 = v1, v9, v2, v3, v4, v5 (s1 simbólica, c1 comissão,
    // v8 secreta); presente em v1, v2, v5 (v3 ausente, v4 e v9 sem linha)
    expect(body.estatisticas.votacoesNominais).toBe(6);
    expect(body.estatisticas.presencaPct).toBe(50);
    expect(body.estatisticas.proposicoesAutor).toBe(1);
    expect(typeof body.estatisticas.despesasAnoCorrente).toBe("number");

    // com exercício interrompido por licença: períodos 01–10/09 e 14/09–hoje pegam v1, v9 (23h30
    // de 10/09 em Brasília), v5, v6, v7; presente em v1 e v6 (v2 foi na licença, v7 ausente)
    const lic = await get<Parlamentar>("/parlamentares/camara:3");
    expect(lic.body.estatisticas.votacoesNominais).toBe(5);
    expect(lic.body.estatisticas.presencaPct).toBe(40);

    const sen = await get<Parlamentar>("/parlamentares/senado:10");
    expect(sen.body.urlOficial).toBe("https://www25.senado.leg.br/web/senadores/senador/-/perfil/10");
    expect(sen.body.estatisticas.presencaPct).toBeNull();
    expect(sen.body.estatisticas.despesasAnoCorrente).toBeNull();
  });
});

describe("parlamentares?ids=", () => {
  test("na ordem pedida, omite inexistente e ignora filtros", async () => {
    const { status, body } = await get<Pagina<ParlamentarResumo>>(
      "/parlamentares?ids=senado:10,camara:999,camara:1,senado:10&casa=camara&limite=1",
    );
    expect(status).toBe(200);
    expect(body.itens.map((p) => p.id)).toEqual(["senado:10", "camara:1"]);
    expect(body.proximo).toBeNull();
  });

  test("400 com mais de 200 ou id malformado", async () => {
    const muitos = Array.from({ length: 201 }, (_, i) => `camara:${i}`).join(",");
    expect((await app.request(`/parlamentares?ids=${muitos}`)).status).toBe(400);
    expect((await app.request("/parlamentares?ids=camara:1,xyz")).status).toBe(400);
  });
});

describe("feed", () => {
  test("urlFonte nunca nulo nos quatro tipos, com a fonte mais específica", async () => {
    const { paginas } = await percorrer("/feed");
    const itens = paginas.flatMap((p) => p.itens);
    expect(new Set(itens.map((i) => i.tipo))).toEqual(new Set(["voto", "proposicao", "despesa_mensal", "consulta_publica"] as const));
    for (const i of itens) expect(i.urlFonte).toStartWith("https://");

    const url = (pred: (i: FeedItem) => boolean) => itens.find(pred)?.urlFonte;
    const voto = (parl: string, v: string) => (i: FeedItem) => i.tipo === "voto" && i.parlamentar.id === parl && i.votacao.id === v;
    expect(url(voto("camara:1", "camara:v1"))).toBe("https://www.camara.leg.br/votacao/v1"); // url da votação
    expect(url(voto("camara:1", "camara:v2"))).toBe("https://www.camara.leg.br/propostas-legislativas/p1"); // da proposição
    expect(url(voto("camara:3", "camara:v7"))).toBe("https://www.camara.leg.br/deputados/3"); // perfil
    const prop = (id: string) => (i: FeedItem) => i.tipo === "proposicao" && i.proposicao.id === id;
    expect(url(prop("camara:p1"))).toBe("https://www.camara.leg.br/propostas-legislativas/p1");
    expect(url(prop("camara:f0"))).toBe("https://www.camara.leg.br/deputados/3");
    expect(url((i) => i.tipo === "despesa_mensal")).toBe(
      "https://www.camara.leg.br/cota-parlamentar/consulta-cota-parlamentar?ideDeputado=1&dataInicio=092026&dataFim=092026",
    );
  });

  test("URL da cota usa mês com dois dígitos", () => {
    expect(urlCotaCamara("1", 2027, 1)).toContain("dataInicio=012027&dataFim=012027");
  });

  test("feed geral pagina sem pular nem duplicar", async () => {
    const esperado = await idsEsperados();
    expect(esperado.length).toBe(12 + N_ENCHIMENTO); // 11 fixos + 1 consulta_publica
    const { ids, paginas } = await percorrer("/feed");
    expect(ids).toEqual(esperado);
    expect(new Set(ids).size).toBe(ids.length);
    expect(paginas[0]!.itens.length).toBe(30);
    expect(paginas.at(-1)!.proximo).toBeNull();
  });

  test("feed por parlamentares pagina sem pular nem duplicar", async () => {
    const esperado = await idsEsperados(sql`and parlamentar_id in ('camara:1', 'camara:3')`);
    const { ids } = await percorrer("/feed?parlamentares=camara:1,camara:3");
    expect(ids).toEqual(esperado);
    const proprio = await percorrer("/parlamentares/camara:3/feed");
    expect(proprio.ids).toEqual(await idsEsperados(sql`and parlamentar_id = 'camara:3'`));
  });

  test("C74: evento consulta_publica com ref_id legado (AAAA-MM) e omitido, nao vira despesa_mensal", async () => {
    // ref_id no formato AAAA-MM, com resumo válido: só a ausência da proposição no ref_id o omite
    const id = await semearEvento("camara:1", "2026-09-30T12:00:00Z", "2026-09", RESUMO_OK);
    try {
      const { ids, paginas } = await percorrer("/feed");
      expect(ids).not.toContain(id);
      expect(ids).toContain(idConsultaBase);
      expect(new Set(paginas.flatMap((p) => p.itens.map((i) => i.tipo)))).toEqual(
        new Set(["voto", "proposicao", "despesa_mensal", "consulta_publica"] as const),
      );
    } finally {
      await apagarEventos([id]);
    }
  });

  test("filtro por tipos", async () => {
    const { ids, paginas } = await percorrer("/feed?tipos=voto,despesa_mensal");
    expect(ids).toEqual(await idsEsperados(sql`and tipo in ('voto', 'despesa_mensal')`));
    for (const p of paginas) for (const i of p.itens) expect(["voto", "despesa_mensal"]).toContain(i.tipo);

    const d = await get<Pagina<FeedItem>>("/parlamentares/camara:1/feed?tipos=despesa_mensal");
    expect(d.body.itens.length).toBe(1);
    const item = d.body.itens[0]!;
    if (item.tipo !== "despesa_mensal") throw new Error("tipo errado");
    expect(item.ano).toBe(2026);
    expect(item.mes).toBe(9);
    expect(item.total).toBe(4260.1);
    expect(item.porCategoria.length).toBe(5);
    expect(item.porCategoria[0]).toEqual({ categoria: "DIVULGAÇÃO", valor: 2000 });
    expect(item.porCategoria[1]).toEqual({ categoria: "PASSAGEM AÉREA", valor: 1500.1 });
  });

  test("comOPartido", async () => {
    const { body } = await get<Pagina<FeedItem>>("/feed?tipos=voto");
    const por = (parl: string, votacao: string) =>
      body.itens.find((i): i is FeedItemVoto => i.tipo === "voto" && i.parlamentar.id === parl && i.votacao.id === votacao);
    expect(por("camara:1", "camara:v1")?.comOPartido).toBe(true);
    expect(por("camara:6", "camara:v1")?.comOPartido).toBe(false);
    expect(por("camara:4", "camara:v1")?.comOPartido).toBeNull(); // partido de um só
    expect(por("camara:2", "camara:v1")?.comOPartido).toBeNull(); // sem partido
    expect(por("camara:1", "camara:v2")?.comOPartido).toBeNull(); // empate
    expect(por("camara:1", "camara:v5")?.comOPartido).toBeNull(); // obstrução
    const v1 = por("camara:1", "camara:v1")!;
    expect(v1.voto).toBe("sim");
    expect(v1.votacao.proposicao?.rotulo).toBe("PL 1234/2026");
    expect(v1.votacao.placar).toEqual({ sim: 3, nao: 1, outros: 0 });
  });

  test("papel autor/coautor", async () => {
    const { paginas } = await percorrer("/feed?tipos=proposicao&parlamentares=camara:1,camara:3");
    const body = { itens: paginas.flatMap((p) => p.itens) };
    const p1 = body.itens.filter((i) => i.tipo === "proposicao" && i.proposicao.id === "camara:p1");
    const papel = Object.fromEntries(p1.map((i) => [i.parlamentar.id, i.tipo === "proposicao" ? i.papel : null]));
    expect(papel).toEqual({ "camara:1": "autor", "camara:3": "coautor" });
    // autor único sem ordem na fonte conta como autor
    const f = body.itens.find((i) => i.tipo === "proposicao" && i.proposicao.id === "camara:f0");
    expect(f && f.tipo === "proposicao" ? f.papel : null).toBe("autor");
  });
});

const TIPOS_FEED = ["voto", "proposicao", "despesa_mensal", "consulta_publica"] as const;

// Consultas semeadas pelos testes de paginação/duplicata: proposições "camara:cp*", tudo apagado no finally.
async function limparSemeadas(): Promise<void> {
  await sql`delete from evento where tipo = 'consulta_publica' and ref_id like 'camara:cp%'`;
  await sql`delete from proposicao where id like 'camara:cp%'`; // consulta_publica cai por cascade
}

async function semearProposicaoConsulta(i: string): Promise<void> {
  await sql`insert into proposicao (id, casa, id_externo, sigla_tipo, numero, ano) values (${"camara:cp" + i}, 'camara', ${"cp" + i}, 'PL', ${Number(i) || 1}, 2026)`;
  await sql`insert into consulta_publica (materia_cod, proposicao_id, votos_sim, votos_nao, apurado_em, url_fonte)
    values (${"cpm" + i}, ${"camara:cp" + i}, 5, 6, '2026-08-01T00:00:00Z', ${"https://www12.senado.leg.br/ecidadania/visualizacaomateria?id=" + i})`;
}

describe("feed consulta_publica", () => {
  test("C73: ref_id com ':' no id da proposicao e partido no ultimo ':'", async () => {
    const itens = await itensConsulta("/feed?tipos=consulta_publica");
    const base = itens.find((i) => i.id === idConsultaBase);
    expect(base?.proposicao.id).toBe("senado:123");
    expect(base?.parlamentar.id).toBe("camara:1");
  });

  test("C75: evento sem linha em consulta_publica e omitido, com 200", async () => {
    // camara:p1 existe, mas não tem apuração: sem urlFonte não há card
    const id = await semearEvento("camara:2", "2026-09-28T12:00:00Z", "camara:p1:2026-09", RESUMO_OK);
    try {
      const ids = await idsFeed("/feed?tipos=consulta_publica");
      expect(ids).not.toContain(id);
      expect(ids).toContain(idConsultaBase);
    } finally {
      await apagarEventos([id]);
    }
  });

  test("C76: evento de proposicao ausente e omitido, com 200", async () => {
    const id = await semearEvento("camara:2", "2026-09-28T12:00:00Z", "senado:999:2026-09", RESUMO_OK);
    try {
      const ids = await idsFeed("/feed?tipos=consulta_publica");
      expect(ids).not.toContain(id);
      expect(ids).toContain(idConsultaBase);
    } finally {
      await apagarEventos([id]);
    }
  });

  test("C77: votosSim negativo omite o evento", async () => {
    const id = await semearEvento("camara:2", "2026-09-28T12:00:00Z", "senado:123:2026-08", { ...RESUMO_OK, votosSim: -1 });
    try {
      const ids = await idsFeed("/feed?tipos=consulta_publica");
      expect(ids).not.toContain(id);
      expect(ids).toContain(idConsultaBase);
    } finally {
      await apagarEventos([id]);
    }
  });

  test("C78: votosNao fracionario omite o evento", async () => {
    const id = await semearEvento("camara:2", "2026-09-28T12:00:00Z", "senado:123:2026-08", { ...RESUMO_OK, votosNao: 1.5 });
    try {
      const ids = await idsFeed("/feed?tipos=consulta_publica");
      expect(ids).not.toContain(id);
      expect(ids).toContain(idConsultaBase);
    } finally {
      await apagarEventos([id]);
    }
  });

  test("C79: resumo sem apuradoEm ou com apuradoEm numerico omite o evento", async () => {
    const semData = await semearEvento("camara:2", "2026-09-28T12:00:00Z", "senado:123:2026-07", { votosSim: 1, votosNao: 2 });
    const numerica = await semearEvento("camara:2", "2026-09-28T12:00:00Z", "senado:123:2026-06", { ...RESUMO_OK, apuradoEm: 1790000000000 });
    try {
      const ids = await idsFeed("/feed?tipos=consulta_publica");
      expect(ids).not.toContain(semData);
      expect(ids).not.toContain(numerica);
      expect(ids).toContain(idConsultaBase);
    } finally {
      await apagarEventos([semData, numerica]);
    }
  });

  test("C80: resumo null ou objeto vazio omite o evento", async () => {
    const nulo = await semearEvento("camara:2", "2026-09-28T12:00:00Z", "senado:123:2026-05", null);
    const vazio = await semearEvento("camara:2", "2026-09-28T12:00:00Z", "senado:123:2026-04", {});
    try {
      const ids = await idsFeed("/feed?tipos=consulta_publica");
      expect(ids).not.toContain(nulo);
      expect(ids).not.toContain(vazio);
      expect(ids).toContain(idConsultaBase);
    } finally {
      await apagarEventos([nulo, vazio]);
    }
  });

  test("C81: numeros congelados no evento, urlFonte vem da tabela", async () => {
    const antes = (await itensConsulta("/feed?tipos=consulta_publica")).find((i) => i.id === idConsultaBase);
    expect(antes?.votosSim).toBe(120);
    const novaUrl = "https://www12.senado.leg.br/ecidadania/visualizacaomateria?id=123&nova=1";
    try {
      await sql`update consulta_publica set votos_sim = 999, votos_nao = 888, apurado_em = '2026-10-15T09:00:00Z', url_fonte = ${novaUrl}
        where materia_cod = '9001'`;
      const depois = (await itensConsulta("/feed?tipos=consulta_publica")).find((i) => i.id === idConsultaBase);
      expect(depois?.votosSim).toBe(120);
      expect(depois?.votosNao).toBe(30);
      expect(depois?.apuradoEm).toBe("2026-09-28T10:00:00.000Z");
      expect(depois?.urlFonte).toBe(novaUrl);
    } finally {
      await sql`update consulta_publica set votos_sim = 120, votos_nao = 30, apurado_em = '2026-09-28T10:00:00Z', url_fonte = ${URL_CONSULTA_BASE}
        where materia_cod = '9001'`;
    }
  });

  test("C82: urlFonte e exatamente consulta_publica.url_fonte, nunca nulo ou vazio", async () => {
    const itens = await itensConsulta("/feed?tipos=consulta_publica");
    expect(itens.length).toBeGreaterThan(0);
    for (const i of itens) {
      expect(typeof i.urlFonte).toBe("string");
      expect(i.urlFonte.length).toBeGreaterThan(0);
      expect(i.urlFonte).toStartWith("https://www12.senado.leg.br/");
    }
    expect(itens.find((i) => i.id === idConsultaBase)?.urlFonte).toBe(URL_CONSULTA_BASE);
  });

  test("C83: tipos=consulta_publica devolve so consultas", async () => {
    const { ids, paginas } = await percorrer("/feed?tipos=consulta_publica");
    const itens = paginas.flatMap((p) => p.itens);
    expect(itens.length).toBeGreaterThan(0);
    for (const i of itens) expect(i.tipo).toBe("consulta_publica");
    expect(ids).toEqual(await idsEsperados(sql`and tipo = 'consulta_publica'`));
  });

  test("C84: paginacao por cursor com mais de 30 consultas nao pula nem duplica", async () => {
    const N = 36;
    try {
      for (let i = 0; i < N; i++) {
        await semearProposicaoConsulta(String(i));
        // grupos de 12 no mesmo dia; dentro do grupo, metade separada por 1 µs
        const quando = `2026-08-0${1 + Math.floor(i / 12)}T10:00:00.000${i % 2 === 0 ? "000" : "001"}Z`;
        await semearEvento("camara:2", quando, `camara:cp${i}:2026-08`, RESUMO_OK);
      }
      const esperado = await idsEsperados(sql`and tipo = 'consulta_publica'`);
      expect(esperado.length).toBe(N + 1);
      const { ids, paginas } = await percorrer("/feed?tipos=consulta_publica");
      expect(paginas.length).toBeGreaterThanOrEqual(2);
      expect(ids).toEqual(esperado);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      await limparSemeadas();
    }
  });

  test("C85: evento omitido no meio e no fim da pagina nao repete nem trava o cursor", async () => {
    const legados: string[] = [];
    // índices k dos eventos legados do seed; a base (idConsultaBase) é a 1ª linha crua, então o k de
    // índice TAMANHO_PAGINA - 2 é a última linha crua da primeira página
    const LEGADOS_K = [9, TAMANHO_PAGINA - 2];
    try {
      let valido = 0;
      for (let k = 0; k < 37; k++) {
        const quando = new Date(Date.UTC(2026, 6, 1, 12, 0) - k * 60_000).toISOString();
        if (LEGADOS_K.includes(k)) {
          legados.push(await semearEvento("camara:2", quando, k === 9 ? "2026-07" : "2026-06", RESUMO_OK));
        } else {
          await semearProposicaoConsulta(String(valido));
          await semearEvento("camara:2", quando, `camara:cp${valido}:2026-07`, RESUMO_OK);
          valido++;
        }
      }
      const todos = await idsEsperados(sql`and tipo = 'consulta_publica'`);
      expect(todos.length).toBe(38);
      const esperado = todos.filter((id) => !legados.includes(id));
      const { ids, paginas } = await percorrer("/feed?tipos=consulta_publica");
      // a 1ª página tem TAMANHO_PAGINA linhas cruas, a base entre elas; cada legado nela some do card
      const legadosNaPrimeira = LEGADOS_K.filter((k) => k < TAMANHO_PAGINA - 1).length;
      expect(paginas[0]!.itens.length).toBe(TAMANHO_PAGINA - legadosNaPrimeira);
      expect(paginas[0]!.proximo).not.toBeNull();
      expect(ids).toEqual(esperado);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      await apagarEventos(legados);
      await limparSemeadas();
    }
  });

  test("url_fonte fora de https no host oficial (javascript:) omite o evento do feed", async () => {
    let id = "";
    try {
      await sql`insert into proposicao (id, casa, id_externo, sigla_tipo, numero, ano) values ('camara:cpjs', 'camara', 'cpjs', 'PL', 78, 2026)`;
      await sql`insert into consulta_publica (materia_cod, proposicao_id, votos_sim, votos_nao, apurado_em, url_fonte) values
        ('cpjs1', 'camara:cpjs', 4, 2, '2026-09-20T00:00:00Z', 'javascript:alert(1)')`;
      id = await semearEvento("camara:2", "2026-09-27T12:00:00Z", "camara:cpjs:2026-09", RESUMO_OK);
      const ids = await idsFeed("/feed?tipos=consulta_publica");
      expect(ids).not.toContain(id);
      expect(ids).toContain(idConsultaBase);
      const itens = await itensConsulta("/feed?tipos=consulta_publica");
      expect(itens.every((i) => i.urlFonte.startsWith("https://www12.senado.leg.br/"))).toBe(true);
    } finally {
      await apagarEventos(id ? [id] : []);
      await limparSemeadas();
    }
  });

  test("C86: duas apuracoes da mesma proposicao viram um card com a url da mais recente", async () => {
    try {
      await sql`insert into proposicao (id, casa, id_externo, sigla_tipo, numero, ano) values ('camara:cpdup', 'camara', 'cpdup', 'PL', 77, 2026)`;
      await sql`insert into consulta_publica (materia_cod, proposicao_id, votos_sim, votos_nao, apurado_em, url_fonte) values
        ('cpdm2', 'camara:cpdup', 9, 9, '2026-09-20T00:00:00Z', 'https://www12.senado.leg.br/ecidadania/visualizacaomateria?id=nova'),
        ('cpdm1', 'camara:cpdup', 1, 1, '2026-09-01T00:00:00Z', 'https://www12.senado.leg.br/ecidadania/visualizacaomateria?id=velha')`;
      await semearEvento("camara:2", "2026-09-27T12:00:00Z", "camara:cpdup:2026-09", RESUMO_OK);
      const dup = (await itensConsulta("/feed?tipos=consulta_publica")).filter((i) => i.proposicao.id === "camara:cpdup");
      expect(dup.length).toBe(1);
      expect(dup[0]!.urlFonte).toBe("https://www12.senado.leg.br/ecidadania/visualizacaomateria?id=nova");
    } finally {
      await limparSemeadas();
    }
  });

  test("C87: tipo invalido em tipos responde 400 listando os 4 tipos", async () => {
    const { status, body } = await get<{ erro: string }>("/feed?tipos=voto,discurso");
    expect(status).toBe(400);
    expect(body.erro).toContain("voto");
    expect(body.erro).toContain("proposicao");
    expect(body.erro).toContain("despesa_mensal");
    expect(body.erro).toContain("consulta_publica");
  });

  test("C88: os 4 tipos explicitos devolvem o mesmo conjunto que sem tipos", async () => {
    const sem = await idsFeed("/feed");
    const explicitos = await idsFeed("/feed?tipos=voto,proposicao,despesa_mensal,consulta_publica");
    expect(explicitos).toEqual(sem);
    expect(sem).toEqual(await idsEsperados());
  });

  test("C89: sem tipos a resposta contem os 4 tipos", async () => {
    const { paginas } = await percorrer("/feed");
    expect(new Set(paginas.flatMap((p) => p.itens.map((i) => i.tipo)))).toEqual(new Set(TIPOS_FEED));
  });

  test("C90: item de consulta tem so as chaves do contrato", async () => {
    const item = (await itensConsulta("/feed?tipos=consulta_publica")).find((i) => i.id === idConsultaBase);
    expect(Object.keys(item!).sort()).toEqual(
      ["apuradoEm", "id", "ocorridoEm", "parlamentar", "proposicao", "tipo", "urlFonte", "votosNao", "votosSim"].sort(),
    );
    expect(item!.ocorridoEm).toBe("2026-09-28T12:00:00.000Z");
  });

  test("C91: feed do parlamentar traz a consulta do autor e nao a de outro", async () => {
    const autor = await get<Pagina<FeedItem>>("/parlamentares/camara:1/feed?tipos=consulta_publica");
    expect(autor.status).toBe(200);
    expect(autor.body.itens.map((i) => i.id)).toEqual([idConsultaBase]);
    const outro = await get<Pagina<FeedItem>>("/parlamentares/camara:3/feed?tipos=consulta_publica");
    expect(outro.status).toBe(200);
    expect(outro.body.itens).toEqual([]);
  });
});

describe("detalhes", () => {
  test("votação", async () => {
    const { status, body } = await get<VotacaoDetalhe>("/votacoes/camara:v1");
    expect(status).toBe(200);
    expect(body.votos.length).toBe(5);
    expect(body.porPartido.find((p) => p.partido === "PT")).toEqual({ partido: "PT", sim: 2, nao: 1, outros: 0 });
    expect(body.urlOficial).toBe("https://www.camara.leg.br/votacao/v1");
    expect(body.secreta).toBe(false);
    expect(body.dataHoraAproximada).toBe(false);
    const v2 = await get<VotacaoDetalhe>("/votacoes/camara:v2");
    expect(v2.body.urlOficial).toBeNull();
    const v8 = await get<VotacaoDetalhe>("/votacoes/camara:v8");
    expect(v8.body.secreta).toBe(true);
  });

  test("proposição", async () => {
    const { status, body } = await get<ProposicaoDetalhe>("/proposicoes/camara:p1");
    expect(status).toBe(200);
    expect(body.rotulo).toBe("PL 1234/2026");
    expect(body.autores.map((a) => a.parlamentar.id)).toEqual(["camara:1", "camara:3"]);
    expect(body.votacoes[0]?.id).toBe("camara:v6"); // mais recente primeiro
    expect(body.dataApresentacao).toBe("2026-09-01T12:00:00.000Z");
  });

  test("partidos", async () => {
    const { body, res } = await get<{ sigla: string; total: number }[]>("/partidos");
    expect(body[0]).toEqual({ sigla: "PT", total: 3 });
    expect(res.headers.get("cache-control")).toContain("max-age=60");
  });
});

const URL_PLACAR = "https://www12.senado.leg.br/ecidadania/visualizacaomateria?id=";

async function semearPlacar(i: string, linhas: [string, number, number, string, string][]): Promise<string> {
  const id = "camara:pl" + i;
  await sql`insert into proposicao (id, casa, id_externo, sigla_tipo, numero, ano) values (${id}, 'camara', ${"pl" + i}, 'PL', ${Number(i)}, 2026)`;
  for (const [cod, sim, nao, quando, url] of linhas) {
    await sql`insert into consulta_publica (materia_cod, proposicao_id, votos_sim, votos_nao, apurado_em, url_fonte)
      values (${cod}, ${id}, ${sim}, ${nao}, ${quando}::timestamptz, ${url})`;
  }
  return id;
}

async function limparPlacares(): Promise<void> {
  await sql`delete from proposicao where id like 'camara:pl%'`; // consulta_publica cai por cascade
}

describe("proposição: placar da consulta pública", () => {
  test("C120: devolve votosSim, votosNao, apuradoEm e urlFonte exatos da linha", async () => {
    try {
      const id = await semearPlacar("11", [["pm11", 137, 58, "2026-09-28T10:00:00Z", URL_PLACAR + "11"]]);
      const { status, body } = await get<ProposicaoDetalhe>(`/proposicoes/${id}`);
      expect(status).toBe(200);
      expect(body.consulta).toEqual({ votosSim: 137, votosNao: 58, apuradoEm: "2026-09-28T10:00:00.000Z", urlFonte: URL_PLACAR + "11" });
    } finally {
      await limparPlacares();
    }
  });

  test("C121: proposição sem linha em consulta_publica => consulta null", async () => {
    try {
      const id = await semearPlacar("12", []);
      const { body } = await get<ProposicaoDetalhe>(`/proposicoes/${id}`);
      expect(body.consulta).toBeNull();
    } finally {
      await limparPlacares();
    }
  });

  test("C122: duas linhas => vale a de apurado_em maior, independente da ordem de inserção", async () => {
    try {
      const id = await semearPlacar("13", [
        ["pm13b", 20, 10, "2026-09-29T10:00:00Z", URL_PLACAR + "13b"],
        ["pm13a", 1, 2, "2026-09-20T10:00:00Z", URL_PLACAR + "13a"],
      ]);
      const { body } = await get<ProposicaoDetalhe>(`/proposicoes/${id}`);
      expect(body.consulta).toEqual({ votosSim: 20, votosNao: 10, apuradoEm: "2026-09-29T10:00:00.000Z", urlFonte: URL_PLACAR + "13b" });
    } finally {
      await limparPlacares();
    }
  });

  test("C123: url_fonte fora da regra (host não-Senado ou http) => consulta null", async () => {
    try {
      const a = await semearPlacar("14", [["pm14", 5, 6, "2026-09-28T10:00:00Z", "https://evil.example.com/ecidadania?id=14"]]);
      const b = await semearPlacar("15", [["pm15", 5, 6, "2026-09-28T10:00:00Z", "http://www12.senado.leg.br/ecidadania/visualizacaomateria?id=15"]]);
      expect((await get<ProposicaoDetalhe>(`/proposicoes/${a}`)).body.consulta).toBeNull();
      expect((await get<ProposicaoDetalhe>(`/proposicoes/${b}`)).body.consulta).toBeNull();
    } finally {
      await limparPlacares();
    }
  });

  test("C124: preserva 0 legítimo (0 x 58)", async () => {
    try {
      const id = await semearPlacar("16", [["pm16", 0, 58, "2026-09-28T10:00:00Z", URL_PLACAR + "16"]]);
      const { body } = await get<ProposicaoDetalhe>(`/proposicoes/${id}`);
      expect(body.consulta).not.toBeNull();
      expect(body.consulta?.votosSim).toBe(0);
      expect(body.consulta?.votosNao).toBe(58);
    } finally {
      await limparPlacares();
    }
  });

  test("C125: votos negativos ou apurado_em que não parseia => consulta null, nunca 0 x 0", async () => {
    try {
      const a = await semearPlacar("17", [["pm17", -1, 58, "2026-09-28T10:00:00Z", URL_PLACAR + "17"]]);
      const b = await semearPlacar("18", [["pm18", 3, -4, "2026-09-28T10:00:00Z", URL_PLACAR + "18"]]);
      const c = await semearPlacar("19", [["pm19", 3, 4, "infinity", URL_PLACAR + "19"]]);
      for (const id of [a, b, c]) {
        const { status, body } = await get<ProposicaoDetalhe>(`/proposicoes/${id}`);
        expect(status).toBe(200);
        expect(body.consulta).toBeNull();
      }
    } finally {
      await limparPlacares();
    }
  });

  test("C126: duas proposições com consultas distintas devolvem cada uma o próprio placar", async () => {
    try {
      const a = await semearPlacar("21", [["pm21", 11, 12, "2026-09-28T10:00:00Z", URL_PLACAR + "21"]]);
      const b = await semearPlacar("22", [["pm22", 31, 32, "2026-09-27T10:00:00Z", URL_PLACAR + "22"]]);
      const ra = await get<ProposicaoDetalhe>(`/proposicoes/${a}`);
      const rb = await get<ProposicaoDetalhe>(`/proposicoes/${b}`);
      expect([ra.body.consulta?.votosSim, ra.body.consulta?.votosNao]).toEqual([11, 12]);
      expect([rb.body.consulta?.votosSim, rb.body.consulta?.votosNao]).toEqual([31, 32]);
    } finally {
      await limparPlacares();
    }
  });

  test("C127: proposição existente sem consulta segue com consulta null e demais campos", async () => {
    const { status, body } = await get<ProposicaoDetalhe>("/proposicoes/camara:p1");
    expect(status).toBe(200);
    expect(body.consulta).toBeNull();
    expect(body.autores.map((a) => a.parlamentar.id)).toEqual(["camara:1", "camara:3"]);
    expect(body.votacoes[0]?.id).toBe("camara:v6");
  });
});

describe("erros", () => {
  test("tipos com mais de 200 caracteres responde 400 sem ecoar o valor; 200 exatos passam", async () => {
    const longo = "voto,".repeat(40) + "v"; // 201 caracteres
    const r = await app.request(`/feed?tipos=${longo}`);
    expect(r.status).toBe(400);
    const corpo = await r.text();
    expect(corpo).not.toContain("voto,voto");
    expect(corpo).toContain("tipos muito longo");
    const teto = await app.request(`/feed?tipos=${"voto,".repeat(40)}`); // 200 caracteres, dedupe em voto
    expect(teto.status).toBe(200);
  });

  test("404 para ids inexistentes", async () => {
    for (const p of ["/parlamentares/camara:999", "/parlamentares/camara:999/feed", "/votacoes/camara:nada", "/proposicoes/senado:0", "/nao-existe"]) {
      const { status, body, res } = await get<{ erro: string }>(p);
      expect(status).toBe(404);
      expect(typeof body.erro).toBe("string");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("400 para parâmetros inválidos", async () => {
    const muitos = Array.from({ length: 201 }, (_, i) => `camara:${i}`).join(",");
    for (const p of [
      "/parlamentares/xyz",
      "/parlamentares?casa=assembleia",
      "/parlamentares?limite=0",
      "/parlamentares?limite=101",
      "/parlamentares?uf=S",
      "/parlamentares?cursor=!!",
      "/feed?tipos=voto,discurso",
      "/feed?cursor=bGl4bw",
      `/feed?parlamentares=${muitos}`,
      "/feed?parlamentares=camara:1,drop%20table",
      "/parlamentares/camara:1/feed?cursor=xx",
    ]) {
      const { status, body } = await get<{ erro: string }>(p);
      expect({ p, status }).toEqual({ p, status: 400 });
      expect(typeof body.erro).toBe("string");
    }
    const ok = await get<Pagina<FeedItem>>(`/feed?parlamentares=${Array.from({ length: 200 }, (_, i) => `camara:${i}`).join(",")}`);
    expect(ok.status).toBe(200);
  });
});
