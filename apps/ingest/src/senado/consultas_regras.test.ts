import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { RespostaTexto } from "../http";
import { lerConsulta } from "./consulta_parser";
import {
  classificarResposta,
  deveAbortar,
  devePularPorRegistro,
  leituraDoResultado,
  mesDaApuracao,
  montarEvento,
  ordenarCandidatas,
  podarPuladas,
  primeiroSignatario,
  proximaContagemFalhas,
  validarLeitura,
  type AutorOrdem,
  type Desfecho,
  type Leitura,
  type RegistroPulo,
} from "./consultas_regras";

const fxTexto = (n: string): string =>
  readFileSync(new URL(`./__fixtures__/${n}`, import.meta.url), "utf8");

const redir = (status: number): RespostaTexto => ({ tipo: "redirecionada", status });

const URL_OK = "https://www12.senado.leg.br/ecidadania/visualizacaomateria?id=160575";

const leituraOk = (extra: Partial<Leitura> = {}): Leitura => ({
  cod: 160575,
  votosSim: 10,
  votosNao: 4,
  apuradoEm: new Date("2026-10-28T13:18:46Z"),
  urlFonte: URL_OK,
  ...extra,
});

const autor = (parlamentarId: string, ordem: number | null): AutorOrdem => ({ parlamentarId, ordem });

describe("mesDaApuracao", () => {
  test("C27: virada de mes no fuso America/Sao_Paulo", () => {
    expect(mesDaApuracao(new Date("2026-11-01T02:30:00Z"))).toBe("2026-10"); // 31/10 23:30 BRT
    expect(mesDaApuracao(new Date("2026-11-01T03:30:00Z"))).toBe("2026-11"); // 01/11 00:30 BRT
  });
});

describe("montarEvento", () => {
  const autores = [autor("senado:1", 1), autor("senado:2", 2)];

  const apresentada = new Date("2023-05-10T15:00:00Z");

  test("C28: mesma leitura reproduz refId e parlamentar; apuracao em outro mes nao muda o refId", () => {
    const a = montarEvento({ proposicaoId: "senado:p9", autores, leitura: leituraOk(), dataApresentacao: null });
    const b = montarEvento({ proposicaoId: "senado:p9", autores, leitura: leituraOk(), dataApresentacao: null });
    if (!a || !b) throw new Error("evento esperado");
    expect(a.refId).toBe("senado:p9:2026-10");
    expect(b.refId).toBe(a.refId);
    expect(b.parlamentarId).toBe(a.parlamentarId);
    expect(b.parlamentarId).toBe("senado:1");
  });

  test("C92: dataApresentacao presente vira ocorridoEm (nao apuradoEm)", () => {
    const ev = montarEvento({ proposicaoId: "senado:p9", autores, leitura: leituraOk(), dataApresentacao: apresentada });
    expect(ev?.ocorridoEm).toEqual(new Date("2023-05-10T15:00:00Z"));
    expect(ev?.refId).toBe("senado:p9:2023-05");
  });

  test("C93: dataApresentacao nula cai no apuradoEm, com o mes dele no refId", () => {
    const ev = montarEvento({ proposicaoId: "senado:p9", autores, leitura: leituraOk(), dataApresentacao: null });
    expect(ev?.ocorridoEm).toEqual(new Date("2026-10-28T13:18:46Z"));
    expect(ev?.refId).toBe("senado:p9:2026-10");
  });

  test("C94: leituras de meses diferentes da mesma proposicao geram o mesmo refId", () => {
    const a = montarEvento({ proposicaoId: "senado:p9", autores, leitura: leituraOk(), dataApresentacao: apresentada });
    const b = montarEvento({
      proposicaoId: "senado:p9",
      autores,
      leitura: leituraOk({ apuradoEm: new Date("2026-11-15T12:00:00Z") }),
      dataApresentacao: apresentada,
    });
    if (!a || !b) throw new Error("evento esperado");
    expect(b.refId).toBe(a.refId);
    expect(b.refId).toBe("senado:p9:2023-05");
  });

  test("C95: apresentacao em 00:00 BRT do dia 1 fica no mes local, nao no do UTC", () => {
    const ev = montarEvento({
      proposicaoId: "senado:p9",
      autores,
      leitura: leituraOk(),
      dataApresentacao: new Date("2023-10-01T03:00:00Z"),
    });
    expect(ev?.refId).toBe("senado:p9:2023-10");
    const vespera = montarEvento({
      proposicaoId: "senado:p9",
      autores,
      leitura: leituraOk(),
      dataApresentacao: new Date("2023-10-01T02:59:59Z"), // 30/09 23:59:59 BRT
    });
    expect(vespera?.refId).toBe("senado:p9:2023-09");
  });

  test("C30: sem primeiro signatario devolve null", () => {
    expect(
      montarEvento({
        proposicaoId: "senado:p9",
        autores: [autor("a", null), autor("b", null)],
        leitura: leituraOk(),
        dataApresentacao: null,
      }),
    ).toBeNull();
    expect(montarEvento({ proposicaoId: "senado:p9", autores: [], leitura: leituraOk(), dataApresentacao: null })).toBeNull();
  });

  test("C31: guarda os numeros em resumo, sem rotulo; sem apresentacao ocorridoEm = apuradoEm", () => {
    const leitura = leituraOk({ votosSim: 721508, votosNao: 1142443 });
    const ev = montarEvento({ proposicaoId: "senado:p9", autores, leitura, dataApresentacao: null });
    expect(ev).toEqual({
      parlamentarId: "senado:1",
      tipo: "consulta_publica",
      ocorridoEm: leitura.apuradoEm,
      refId: "senado:p9:2026-10",
      resumo: { votosSim: 721508, votosNao: 1142443, apuradoEm: "2026-10-28T13:18:46.000Z" },
    });
    expect(Object.keys(ev?.resumo ?? {}).sort()).toEqual(["apuradoEm", "votosNao", "votosSim"]);
  });
});

describe("primeiroSignatario", () => {
  test("C29: ordem=1, autor unico sem ordem, ambiguos e vazio", () => {
    expect(primeiroSignatario([autor("x", 2), autor("primeiro", 1), autor("y", null)])).toBe("primeiro");
    expect(primeiroSignatario([autor("unico", null)])).toBe("unico");
    expect(primeiroSignatario([autor("a", null), autor("b", null)])).toBeNull();
    expect(primeiroSignatario([])).toBeNull();
    expect(primeiroSignatario([autor("a", 2), autor("b", 3)])).toBeNull();
    expect(primeiroSignatario([autor("a", 2)])).toBeNull();
  });
});

describe("classificarResposta", () => {
  test("C32: o status lido de p999999999.hdr e materia_inexistente", () => {
    const m = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(fxTexto("p999999999.hdr"));
    expect(m).not.toBeNull();
    const status = Number(m?.[1]);
    expect(classificarResposta(redir(status))).toEqual({
      acao: "pular",
      motivo: "materia_inexistente",
    });
  });

  test("resposta ok devolve o html para leitura", () => {
    expect(classificarResposta({ tipo: "ok", corpo: "<html>" })).toEqual({ acao: "ler", html: "<html>" });
  });

  test.each([
    ["C33", 301],
    ["C34", 303],
    ["C35", 307],
    ["C36", 308],
  ])("%s: status %i e materia_inexistente", (_id, status) => {
    expect(classificarResposta(redir(status))).toEqual({ acao: "pular", motivo: "materia_inexistente" });
  });

  test.each([
    ["C37", 300],
    ["C38", 304],
  ])("%s: status %i pula sem ser materia_inexistente", (_id, status) => {
    const r = classificarResposta(redir(status));
    expect(r.acao).toBe("pular");
    expect(r).not.toEqual({ acao: "pular", motivo: "materia_inexistente" });
  });
});

describe("validarLeitura", () => {
  test("C39: rejeita http", () => {
    const r = validarLeitura(
      leituraOk({ urlFonte: "http://www12.senado.leg.br/ecidadania/visualizacaomateria?id=160575" }),
    );
    expect(r.ok).toBe(false);
  });

  test("C40: rejeita host parecido ou diferente (host por URL, nao substring)", () => {
    for (const urlFonte of [
      "https://www12.senado.leg.br.evil.com/x",
      "https://evil.com/x",
      "https://evil.com/www12.senado.leg.br",
      "https://www12.senado.leg.br@evil.com/x",
      "https://www12.senado.leg.br:8443/x",
    ]) {
      expect(validarLeitura(leituraOk({ urlFonte })).ok).toBe(false);
    }
  });

  test("C41: urlFonte que nao e URL e rejeitada sem lancar", () => {
    expect(validarLeitura(leituraOk({ urlFonte: "nao-url" })).ok).toBe(false);
    expect(validarLeitura(leituraOk({ urlFonte: "" })).ok).toBe(false);
  });

  test("C42: votos invalidos em sim e em nao, data invalida; 0/0 valido aceito", () => {
    for (const v of [-1, 1.5, Number.NaN]) {
      expect(validarLeitura(leituraOk({ votosSim: v })).ok).toBe(false);
      expect(validarLeitura(leituraOk({ votosNao: v })).ok).toBe(false);
    }
    expect(validarLeitura(leituraOk({ apuradoEm: new Date("invalido") })).ok).toBe(false);
    const zero = leituraOk({ votosSim: 0, votosNao: 0 });
    expect(validarLeitura(zero)).toEqual({ ok: true, leitura: zero });
  });

  test("contagem acima de MAX_SAFE_INTEGER e rejeitada em votosSim e em votosNao", () => {
    const grande = Number.MAX_SAFE_INTEGER + 2;
    expect(validarLeitura(leituraOk({ votosSim: grande })).ok).toBe(false);
    expect(validarLeitura(leituraOk({ votosNao: grande })).ok).toBe(false);
    expect(validarLeitura(leituraOk({ votosSim: Number.MAX_SAFE_INTEGER })).ok).toBe(true);
  });
});

describe("leituraDoResultado", () => {
  test("C43: sem_dado e template_alterado das fixtures nao viram leitura valida", () => {
    const encerrada = lerConsulta(fxTexto("p1181.html"), 1181);
    expect(encerrada).toEqual({ tipo: "sem_dado", motivo: "encerrada" });
    expect(leituraDoResultado(encerrada, 1181).ok).toBe(false);

    const html = fxTexto("p160575.html");
    expect(html.includes(">721.508<")).toBe(true);
    const alterado = lerConsulta(html.replace(">721.508<", ">abc<"), 160575);
    expect(alterado.tipo).toBe("template_alterado");
    expect(leituraDoResultado(alterado, 160575).ok).toBe(false);

    const semApuracao = leituraDoResultado({ tipo: "sem_dado", motivo: "sem_apuracao" }, 176111);
    expect(semApuracao.ok).toBe(false);
  });

  test("resultado ok do parser vira leitura com a url da consulta", () => {
    const r = leituraDoResultado(
      { tipo: "ok", votosSim: 3, votosNao: 2, apuradoEm: new Date("2026-10-28T13:18:46Z") },
      160575,
    );
    expect(r).toEqual({ ok: true, leitura: leituraOk({ votosSim: 3, votosNao: 2 }) });
  });
});

describe("ordenarCandidatas", () => {
  test("C44: nunca lida primeiro, depois apuradoEm mais antigo, empate por proposicaoId; sem mutar", () => {
    const t = new Date("2026-10-01T00:00:00Z");
    const entrada = [
      { proposicaoId: "a", apuradoEm: new Date("2026-10-20T00:00:00Z") },
      { proposicaoId: "d", apuradoEm: t },
      { proposicaoId: "c", apuradoEm: t },
      { proposicaoId: "z", apuradoEm: null },
      { proposicaoId: "y", apuradoEm: null },
    ];
    const copia = entrada.map((c) => ({ ...c }));
    const saida = ordenarCandidatas(entrada);
    expect(saida.map((c) => c.proposicaoId)).toEqual(["y", "z", "c", "d", "a"]);
    expect(entrada).toEqual(copia);
    expect(saida).not.toBe(entrada);
  });

  test("C44: lida mais antiga vem antes mesmo com proposicaoId maior", () => {
    const saida = ordenarCandidatas([
      { proposicaoId: "a", apuradoEm: new Date("2026-10-20T00:00:00Z") },
      { proposicaoId: "z", apuradoEm: new Date("2026-10-01T00:00:00Z") },
    ]);
    expect(saida.map((c) => c.proposicaoId)).toEqual(["z", "a"]);
  });
});

describe("pulo registrado", () => {
  const agora = new Date("2026-10-28T12:00:00Z");
  const haDias = (d: number): string => new Date(agora.getTime() - d * 24 * 3600 * 1000).toISOString();
  const reg = (d: number, motivo: RegistroPulo["motivo"]): RegistroPulo => ({ em: haDias(d), motivo });

  test("C45: 29 dias pula, 31 nao, sem registro nao; poda remove so vencidas", () => {
    expect(devePularPorRegistro(reg(29, "encerrada"), agora)).toBe(true);
    expect(devePularPorRegistro(reg(29, "materia_inexistente"), agora)).toBe(true);
    expect(devePularPorRegistro(reg(31, "encerrada"), agora)).toBe(false);
    expect(devePularPorRegistro(reg(31, "materia_inexistente"), agora)).toBe(false);
    expect(devePularPorRegistro(undefined, agora)).toBe(false);

    const entrada = { "1": reg(29, "encerrada"), "2": reg(31, "encerrada"), "3": reg(1, "materia_inexistente") };
    const copia = { ...entrada };
    expect(Object.keys(podarPuladas(entrada, agora)).sort()).toEqual(["1", "3"]);
    expect(entrada).toEqual(copia);
  });

  test("prazo curto: sem_apuracao com 2 dias pula e com 4 nao", () => {
    expect(devePularPorRegistro(reg(2, "sem_apuracao"), agora)).toBe(true);
    expect(devePularPorRegistro(reg(4, "sem_apuracao"), agora)).toBe(false);
  });

  test("prazo curto: falha de leitura (template_alterado) com 2 dias pula e com 4 nao", () => {
    expect(devePularPorRegistro(reg(2, "falha_leitura"), agora)).toBe(true);
    expect(devePularPorRegistro(reg(4, "falha_leitura"), agora)).toBe(false);
  });

  test("poda remove o curto vencido e mantem o de 30 dias ainda valido", () => {
    const entrada = {
      "1": reg(4, "sem_apuracao"),
      "2": reg(10, "encerrada"),
      "3": reg(4, "falha_leitura"),
      "4": reg(2, "falha_leitura"),
    };
    expect(Object.keys(podarPuladas(entrada, agora)).sort()).toEqual(["2", "4"]);
  });
});

describe("falhas seguidas", () => {
  const rodar = (desfechos: Desfecho[]): number =>
    desfechos.reduce((n, d) => proximaContagemFalhas(n, d), 0);
  const falhas = (n: number): Desfecho[] => Array.from({ length: n }, () => "falha" as const);

  test("C46: 10 falhas abortam, 9 nao; pulo esperado nao conta; ok zera", () => {
    expect(deveAbortar(rodar(falhas(10)))).toBe(true);
    expect(deveAbortar(rodar(falhas(9)))).toBe(false);
    expect(rodar([...falhas(9), "pulo_esperado", "pulo_esperado", "pulo_esperado"])).toBe(9);
    expect(deveAbortar(rodar([...falhas(9), "pulo_esperado"]))).toBe(false);
    expect(rodar([...falhas(9), "ok"])).toBe(0);
    expect(deveAbortar(rodar([...falhas(9), "ok", ...falhas(9)]))).toBe(false);
    expect(proximaContagemFalhas(3, "falha")).toBe(4);
  });
});
