import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { ProposicaoDetalhe } from "@plenario/core/api";
import { fonteEstatica } from "./estatico";

// estatico.ts guarda os downloads em cache por caminho (modulo): cada caso usa um id proprio,
// senao o segundo teste leria a resposta do primeiro sem chamar o fetch stubado.
const restauracoes: (() => void)[] = [];

afterEach(() => {
  for (const restaurar of restauracoes.splice(0)) restaurar();
});

function responderCom(resposta: () => Response) {
  // typeof fetch em Bun inclui preconnect: copiado do original para o stub tipar sem cast
  const stub = Object.assign(
    async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => resposta(),
    { preconnect: fetch.preconnect },
  );
  const espiao = spyOn(globalThis, "fetch").mockImplementation(stub);
  restauracoes.push(() => espiao.mockRestore());
  return espiao;
}

function respostaJson(corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), { status: 200, headers: { "content-type": "application/json" } });
}

// formato anterior à f327: o arquivo proposicao/<id>.json não traz o campo consulta
const proposicaoPreF327: Omit<ProposicaoDetalhe, "consulta"> = {
  id: "101",
  casa: "camara",
  siglaTipo: "PL",
  numero: 1234,
  ano: 2026,
  rotulo: "PL 1234/2026",
  ementa: "Dispõe sobre a publicidade dos gastos parlamentares.",
  url: "https://www.camara.leg.br/proposicoesWeb/fichadetramitacao?idProposicao=101",
  dataApresentacao: "2026-03-10",
  autores: [],
  votacoes: [],
};

describe("fonteEstatica.proposicao", () => {
  it("JSON pre-f327 sem o campo consulta resolve com consulta null, nao undefined", async () => {
    const espiao = responderCom(() => respostaJson(proposicaoPreF327));

    const resultado = await fonteEstatica.proposicao("101");

    expect(espiao).toHaveBeenCalledTimes(1);
    expect(resultado.consulta).toBeNull();
    expect(resultado.rotulo).toBe("PL 1234/2026");
  });

  it("JSON com consulta preserva o placar, a data de apuracao e a url da fonte", async () => {
    const consulta = {
      votosSim: 4321,
      votosNao: 1787,
      apuradoEm: "2026-10-27T14:05:00.000Z",
      urlFonte: "https://www12.senado.leg.br/ecidadania/visualizacaomateria?id=987654",
    };
    responderCom(() => respostaJson({ ...proposicaoPreF327, id: "102", consulta }));

    const resultado = await fonteEstatica.proposicao("102");

    expect(resultado.consulta).toEqual(consulta);
    expect(resultado.consulta?.votosSim).toBe(4321);
    expect(resultado.consulta?.votosNao).toBe(1787);
    expect(resultado.consulta?.apuradoEm).toBe("2026-10-27T14:05:00.000Z");
    expect(resultado.consulta?.urlFonte).toBe("https://www12.senado.leg.br/ecidadania/visualizacaomateria?id=987654");
  });

  it("resposta sem content-type JSON (fallback de SPA) rejeita com 'nao ha registro'", async () => {
    responderCom(
      () =>
        new Response("<!doctype html><html><body>app</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );

    await expect(fonteEstatica.proposicao("103")).rejects.toThrow(
      "Não há registro com este endereço nos dados publicados.",
    );
  });
});
