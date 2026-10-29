// Integracao do `run` do Senado contra o Postgres de teste (banco terminado em _test).
// Fontes de rede injetadas (parametro `fontes` de run); `sincronizarConsultas` e a real quando o caso
// precisa de cursor gravado. O modulo de producao so e importado depois da guarda do banco.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { limparTabelas, prepararBancoDeTeste, type Sql } from "../testing/banco";
import type { Fontes } from "./index";
import type { ResultadoConsultas } from "./consultas";

process.env.INGEST_CONSULTAS_INTERVALO_MS = "0";
delete process.env.INGEST_CONSULTAS_MAX;

const FETCH_ORIGINAL = globalThis.fetch;
const CONSOLE_LOG_ORIGINAL = console.log;

const OPCOES = { desde: "2026-01-01", ate: "2026-01-02" };

let sql: Sql;
let run: typeof import("./index").run;
let sincronizarConsultasReal: Fontes["sincronizarConsultas"];
let chamadas: string[];

const e429 = (): Error => new Error("429 em https://legis.senado.leg.br/dadosabertos/senador/lista/atual");

function fontes(sobrepor: Partial<Fontes> = {}): Fontes {
  return {
    sincronizarParlamentares: async () => {
      chamadas.push("parlamentares");
      return new Map();
    },
    completarPartidos: async () => {
      chamadas.push("partidos");
    },
    sincronizarVotacoes: async () => {
      chamadas.push("votacoes");
      return { votacoes: 0, nominais: 0, secretas: 0, votos: 0 };
    },
    sincronizarProposicoes: async () => {
      chamadas.push("proposicoes");
      return { proposicoes: 0, autorias: 0, semOrdem: 0 };
    },
    sincronizarConsultas: async (parcial) => {
      chamadas.push("consultas");
      return sincronizarConsultasReal(parcial);
    },
    ...sobrepor,
  };
}

async function cursor(fonte: string): Promise<Record<string, unknown> | undefined> {
  const [r] = await sql<{ estado: Record<string, unknown> }[]>`select estado from ingest_cursor where fonte = ${fonte}`;
  return r?.estado;
}

async function fontesComCursor(): Promise<string[]> {
  const r = await sql<{ fonte: string }[]>`select fonte from ingest_cursor order by fonte`;
  return r.map((x) => x.fonte);
}

async function bloquearCursorConsultas(): Promise<void> {
  await sql`create or replace function falha_cursor_teste() returns trigger language plpgsql as $$
    begin
      if new.fonte = 'senado:consultas' then raise exception 'cursor bloqueado pelo teste'; end if;
      return new;
    end $$`;
  await sql`create trigger falha_cursor_teste before insert on ingest_cursor for each row execute function falha_cursor_teste()`;
}

async function liberarCursor(): Promise<void> {
  await sql`drop trigger if exists falha_cursor_teste on ingest_cursor`;
  await sql`drop function if exists falha_cursor_teste()`;
}

const capturar = async (p: Promise<void>): Promise<unknown> => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
};

const resultadoParcial = (): ResultadoConsultas => ({
  lidas: 3,
  puladas: 2,
  eventos: 1,
  falhas: 1,
  abortou: false,
  registroPuladas: { "777": { em: new Date().toISOString(), motivo: "encerrada" } },
});

beforeAll(async () => {
  sql = await prepararBancoDeTeste();
  ({ run } = await import("./index"));
  ({ sincronizarConsultas: sincronizarConsultasReal } = await import("./consultas"));
});

beforeEach(async () => {
  await liberarCursor();
  await limparTabelas(sql);
  chamadas = [];
  console.log = (): void => {};
});

afterEach(async () => {
  globalThis.fetch = FETCH_ORIGINAL;
  console.log = CONSOLE_LOG_ORIGINAL;
  await liberarCursor();
});

describe("caminho parcial das consultas", () => {
  test("C65 sincronizarConsultas lanca apos pulo: cursor parcial gravado e run rejeita com o erro original", async () => {
    const original = new Error("queda no meio da rodada");
    const f = fontes({
      sincronizarConsultas: async (parcial) => {
        if (parcial) parcial.atual = resultadoParcial();
        throw original;
      },
    });
    const erro = await capturar(run(OPCOES, f));
    expect(erro).toBe(original);
    const c = await cursor("senado:consultas");
    expect(c?.contagem).toEqual({ lidas: 3, puladas: 2, eventos: 1, falhas: 1 });
    expect(Object.keys((c?.puladas ?? {}) as object)).toEqual(["777"]);
    expect(c?.abortou).toBe(false);
  });

  test("C66 falha ao gravar o cursor parcial nao mascara o erro original", async () => {
    const original = new Error("queda no meio da rodada");
    const f = fontes({
      sincronizarConsultas: async (parcial) => {
        if (parcial) parcial.atual = resultadoParcial();
        throw original;
      },
    });
    await bloquearCursorConsultas();
    const erro = await capturar(run(OPCOES, f));
    expect(erro).toBe(original);
    expect(await cursor("senado:consultas")).toBeUndefined();
    expect(await cursor("senado:parlamentares")).toBeDefined();
  });
});

describe("isolamento entre fontes", () => {
  test("C67 429 em parlamentares: votacoes e proposicoes nao rodam, consultas rodam e gravam cursor", async () => {
    await sql`insert into ingest_cursor (fonte, estado) values ('senado:votacoes', '{"ate":"2025-12-30"}'::jsonb)`;
    await sql`insert into ingest_cursor (fonte, estado) values ('senado:proposicoes', '{"ate":"2025-12-31"}'::jsonb)`;
    const original = e429();
    const f = fontes({
      sincronizarParlamentares: async () => {
        chamadas.push("parlamentares");
        throw original;
      },
    });
    const erro = await capturar(run(OPCOES, f));
    expect(erro).toBe(original);
    expect(chamadas).toEqual(["parlamentares", "consultas"]);
    expect(await cursor("senado:votacoes")).toEqual({ ate: "2025-12-30" });
    expect(await cursor("senado:proposicoes")).toEqual({ ate: "2025-12-31" });
    expect(await cursor("senado:parlamentares")).toBeUndefined();
    expect(await cursor("senado:consultas")).toMatchObject({ contagem: { lidas: 0, puladas: 0, eventos: 0, falhas: 0 } });
  });

  test("C68 falha de votacoes: proposicoes e consultas rodam e o cursor de votacoes nao muda", async () => {
    await sql`insert into ingest_cursor (fonte, estado) values ('senado:votacoes', '{"ate":"2025-12-30"}'::jsonb)`;
    const original = new Error("votacoes fora do ar");
    const f = fontes({
      sincronizarVotacoes: async () => {
        chamadas.push("votacoes");
        throw original;
      },
    });
    const erro = await capturar(run(OPCOES, f));
    expect(erro).toBe(original);
    expect(chamadas).toEqual(["parlamentares", "votacoes", "proposicoes", "consultas"]);
    expect(await cursor("senado:votacoes")).toEqual({ ate: "2025-12-30" });
    expect(await cursor("senado:proposicoes")).toEqual({ ate: OPCOES.ate });
    expect(await cursor("senado:consultas")).toBeDefined();
  });

  test("C69 duas fontes falhando: AggregateError com os nomes; uma so: o erro original", async () => {
    const eParl = e429();
    const eCons = new Error("consultas fora do ar");
    const duas = fontes({
      sincronizarParlamentares: async () => {
        throw eParl;
      },
      sincronizarConsultas: async () => {
        throw eCons;
      },
    });
    const erro = await capturar(run(OPCOES, duas));
    expect(erro).toBeInstanceOf(AggregateError);
    const agregado = erro as AggregateError;
    expect(agregado.message).toContain("parlamentares");
    expect(agregado.message).toContain("consultas");
    expect(agregado.errors).toEqual([eParl, eCons]);

    const unica = new Error("so proposicoes");
    const uma = fontes({
      sincronizarProposicoes: async () => {
        throw unica;
      },
    });
    const erro1 = await capturar(run(OPCOES, uma));
    expect(erro1).toBe(unica);
    expect(erro1).not.toBeInstanceOf(AggregateError);
  });

  test("C70 completarPartidos lancando apos votacoes: cursor de votacoes nao avanca e run rejeita", async () => {
    const original = new Error("partidos fora do ar");
    const f = fontes({
      completarPartidos: async () => {
        chamadas.push("partidos");
        throw original;
      },
    });
    const erro = await capturar(run(OPCOES, f));
    expect(erro).toBe(original);
    expect(chamadas).toContain("votacoes");
    expect(chamadas).toContain("partidos");
    expect(await cursor("senado:votacoes")).toBeUndefined();
    expect(await cursor("senado:proposicoes")).toEqual({ ate: OPCOES.ate });
  });
});

describe("log de falha", () => {
  test("C72 mensagem de erro longa e truncada em 200 caracteres na linha FALHOU", async () => {
    const linhas: string[] = [];
    console.log = (...args: unknown[]): void => {
      linhas.push(args.map(String).join(" "));
    };
    try {
      const msg = "a".repeat(200) + "b".repeat(300);
      const f = fontes({
        sincronizarProposicoes: async () => {
          throw new Error(msg);
        },
      });
      await capturar(run(OPCOES, f));
      const linha = linhas.find((l) => l.includes("proposicoes: FALHOU"));
      expect(linha).toBeDefined();
      expect(linha).toContain("a".repeat(200));
      expect(linha).not.toContain("b");
    } finally {
      console.log = CONSOLE_LOG_ORIGINAL;
    }
  });
});

describe("sem falhas", () => {
  test("C71 todos os cursores gravados e run resolve", async () => {
    // fetch falso: o afterEach precisa restaurar o original
    globalThis.fetch = Object.assign(async () => new Response("sem mock", { status: 404 }), {
      preconnect: FETCH_ORIGINAL.preconnect,
    });
    await run(OPCOES, fontes());
    expect(chamadas).toEqual(["parlamentares", "votacoes", "partidos", "proposicoes", "consultas"]);
    expect(await fontesComCursor()).toEqual([
      "senado:consultas",
      "senado:parlamentares",
      "senado:proposicoes",
      "senado:votacoes",
    ]);
    expect(await cursor("senado:parlamentares")).toEqual({ total: 0 });
    expect(await cursor("senado:votacoes")).toEqual({ ate: OPCOES.ate });
    expect(await cursor("senado:proposicoes")).toEqual({ ate: OPCOES.ate });
  });

  test("C71 fetch global restaurado pelo afterEach do teste anterior", () => {
    expect(globalThis.fetch).toBe(FETCH_ORIGINAL);
  });
});
