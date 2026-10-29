import { describe, expect, test } from "bun:test";
import { urlFonteConsultaValida } from "@plenario/core/fonte";
import { lerResumoConsulta, parseRefIdConsulta } from "./feed";

describe("parseRefIdConsulta", () => {
  test("corta no ultimo ':' e separa o mes", () => {
    expect(parseRefIdConsulta("senado:123:2026-09")).toEqual({ proposicaoId: "senado:123", mes: "2026-09" });
    expect(parseRefIdConsulta("a:b:c:2026-12")).toEqual({ proposicaoId: "a:b:c", mes: "2026-12" });
  });

  test("formato legado AAAA-MM sem proposicao e null", () => {
    expect(parseRefIdConsulta("2026-09")).toBeNull();
    expect(parseRefIdConsulta("")).toBeNull();
  });

  test("mes 00 e 13 sao null", () => {
    expect(parseRefIdConsulta("senado:1:2026-00")).toBeNull();
    expect(parseRefIdConsulta("senado:1:2026-13")).toBeNull();
    expect(parseRefIdConsulta("senado:1:2026-01")).not.toBeNull();
  });
});

describe("lerResumoConsulta", () => {
  const ok = { votosSim: 3, votosNao: 0, apuradoEm: "2026-09-28T10:00:00.000Z" };

  test("resumo valido e devolvido", () => {
    expect(lerResumoConsulta(ok)).toEqual(ok);
    expect(lerResumoConsulta({ votosSim: 0, votosNao: 0, apuradoEm: "2026-09-28T10:00:00Z" })).not.toBeNull();
  });

  test("null, array e objeto vazio viram null", () => {
    expect(lerResumoConsulta(null)).toBeNull();
    expect(lerResumoConsulta([ok])).toBeNull();
    expect(lerResumoConsulta({})).toBeNull();
  });

  test("contagem negativa ou nao inteira vira null", () => {
    expect(lerResumoConsulta({ ...ok, votosSim: -1 })).toBeNull();
    expect(lerResumoConsulta({ ...ok, votosNao: 1.5 })).toBeNull();
  });

  test("apuradoEm ISO invalido ou nao textual vira null", () => {
    expect(lerResumoConsulta({ ...ok, apuradoEm: "2026-13-01T00:00:00Z" })).toBeNull();
    expect(lerResumoConsulta({ ...ok, apuradoEm: "28/09/2026" })).toBeNull();
    expect(lerResumoConsulta({ ...ok, apuradoEm: 1790000000000 })).toBeNull();
  });
});

describe("urlFonteConsultaValida", () => {
  test("https no host oficial e aceita", () => {
    expect(urlFonteConsultaValida("https://www12.senado.leg.br/ecidadania/visualizacaomateria?id=1")).toBe(true);
  });

  test("http e rejeitado", () => {
    expect(urlFonteConsultaValida("http://www12.senado.leg.br/ecidadania/visualizacaomateria?id=1")).toBe(false);
  });

  test("javascript: e rejeitado", () => {
    expect(urlFonteConsultaValida("javascript:alert(1)")).toBe(false);
  });

  test("host que so comeca com o oficial e rejeitado", () => {
    expect(urlFonteConsultaValida("https://www12.senado.leg.br.evil.com/x")).toBe(false);
  });

  test("userinfo no host oficial e rejeitado", () => {
    expect(urlFonteConsultaValida("https://x@www12.senado.leg.br/")).toBe(false);
    expect(urlFonteConsultaValida("https://x:y@www12.senado.leg.br/")).toBe(false);
  });

  test("string que nao e URL vira false sem lancar", () => {
    expect(urlFonteConsultaValida("nao-url")).toBe(false);
    expect(urlFonteConsultaValida("")).toBe(false);
  });
});
