import { beforeAll, describe, expect, test } from "bun:test";
import {
  contarTabelas,
  limparTabelas,
  prepararBancoDeTeste,
  resolverUrlDeTeste,
  semearMinimo,
  TABELAS_DO_INGEST,
  type ContagemTabelas,
  type Sql,
} from "./banco";

const ZERADO: ContagemTabelas = {
  consulta_publica: 0,
  evento: 0,
  proposicao_autor: 0,
  proposicao: 0,
  parlamentar: 0,
  ingest_cursor: 0,
};

describe("guarda do banco de teste (sem conectar)", () => {
  test("C47 recusa banco sem sufixo _test antes de qualquer truncate", () => {
    // TEST_DATABASE_URL de banco de producao/dev forjado na env: nenhuma conexao, so a decisao da URL
    expect(() =>
      resolverUrlDeTeste({ TEST_DATABASE_URL: "postgres://plenario:plenario@localhost:5433/plenario" }),
    ).toThrow(/_test/);
    expect(() => resolverUrlDeTeste({ TEST_DATABASE_URL: "" })).toThrow(/_test/);
    // DATABASE_URL herdado do .env da raiz (banco plenario) nao impede: a URL usada e a de teste
    expect(
      resolverUrlDeTeste({
        DATABASE_URL: "postgres://plenario:plenario@localhost:5433/plenario",
        TEST_DATABASE_URL: "postgres://plenario:plenario@localhost:5433/plenario_test",
      }),
    ).toBe("postgres://plenario:plenario@localhost:5433/plenario_test");
  });

  test("C47 prepararBancoDeTeste lanca e nao altera DATABASE_URL quando a URL e de producao", async () => {
    const antes = process.env.DATABASE_URL;
    const antesTeste = process.env.TEST_DATABASE_URL;
    try {
      process.env.TEST_DATABASE_URL = "postgres://plenario:plenario@localhost:5433/plenario";
      process.env.DATABASE_URL = "postgres://plenario:plenario@localhost:5433/plenario";
      await expect(prepararBancoDeTeste()).rejects.toThrow(/_test/);
      expect(process.env.DATABASE_URL).toBe("postgres://plenario:plenario@localhost:5433/plenario");
    } finally {
      restaurar("DATABASE_URL", antes);
      restaurar("TEST_DATABASE_URL", antesTeste);
    }
  });

  test("guarda recusa host remoto", () => {
    expect(() =>
      resolverUrlDeTeste({ TEST_DATABASE_URL: "postgres://plenario:plenario@db.exemplo.com:5432/plenario_test" }),
    ).toThrow(/host atual: db\.exemplo\.com/);
    expect(() =>
      resolverUrlDeTeste({ TEST_DATABASE_URL: "postgres://plenario:plenario@10.0.0.5:5432/plenario_test" }),
    ).toThrow(/host atual: 10\.0\.0\.5/);
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      const url = `postgres://plenario:plenario@${host}:5433/plenario_test`;
      expect(resolverUrlDeTeste({ TEST_DATABASE_URL: url })).toBe(url);
    }
  });

  test("guarda recusa host e hostaddr na query string", () => {
    for (const chave of ["host", "hostaddr"]) {
      const url = `postgres://plenario:plenario@localhost:5433/plenario_test?${chave}=db.exemplo.com`;
      expect(() => resolverUrlDeTeste({ TEST_DATABASE_URL: url })).toThrow(new RegExp(`"${chave}"`));
    }
  });

  test("default e URL de teste com query passam sem sufixo na env", () => {
    expect(resolverUrlDeTeste({})).toBe("postgres://localhost:5432/plenario_test");
    const comQuery = "postgres://plenario:plenario@localhost:5433/plenario_test?sslmode=disable";
    expect(resolverUrlDeTeste({ TEST_DATABASE_URL: comQuery })).toBe(comQuery);
  });
});

describe("seed e truncate", () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = await prepararBancoDeTeste();
  });

  test("C48 seed minimo, truncate zera as 6 tabelas e o seed pode ser repetido", async () => {
    expect(TABELAS_DO_INGEST.length).toBe(6);

    await limparTabelas(sql);
    expect(await contarTabelas(sql)).toEqual(ZERADO);

    await semearMinimo(sql);
    const apos1 = await contarTabelas(sql);
    expect(apos1).toEqual({ ...ZERADO, parlamentar: 1, proposicao: 1, proposicao_autor: 1 });
    const [autor] = await sql<{ ordem: number }[]>`select ordem from proposicao_autor where proposicao_id = 'senado:900001'`;
    expect(autor?.ordem).toBe(1);

    await limparTabelas(sql);
    expect(await contarTabelas(sql)).toEqual(ZERADO);

    await semearMinimo(sql);
    expect(await contarTabelas(sql)).toEqual(apos1);
    await limparTabelas(sql);
  });
});

function restaurar(chave: string, valor: string | undefined): void {
  if (valor === undefined) delete process.env[chave];
  else process.env[chave] = valor;
}
