import { afterEach, describe, expect, it } from "bun:test";
import { criarThrottle, criarThrottleConsultas, lerIntervaloConsultas } from "./throttle";

// Relogio falso: dormir avanca o tempo ate o alvo (assincrono, para expor corrida entre chamadas).
function relogioFalso() {
  let t = 0;
  return {
    agora: () => t,
    dormir: async (ms: number) => {
      const alvo = t + ms;
      await Promise.resolve();
      t = Math.max(t, alvo);
    },
  };
}

describe("criarThrottle", () => {
  it("C22: 3 chamadas seguidas ficam espacadas >= intervaloMs", async () => {
    const rel = relogioFalso();
    const th = criarThrottle(100, rel);
    const marcas: number[] = [];
    for (let i = 0; i < 3; i++) {
      await th.esperar();
      marcas.push(rel.agora());
    }
    expect(marcas[1]! - marcas[0]!).toBeGreaterThanOrEqual(100);
    expect(marcas[2]! - marcas[1]!).toBeGreaterThanOrEqual(100);
  });

  it("C23: chamadas concorrentes sao serializadas", async () => {
    const rel = relogioFalso();
    const th = criarThrottle(100, rel);
    const marcas: number[] = [];
    await Promise.all(
      [0, 1, 2, 3].map(async () => {
        await th.esperar();
        marcas.push(rel.agora());
      }),
    );
    expect(marcas).toHaveLength(4);
    for (let i = 1; i < marcas.length; i++) {
      expect(marcas[i]! - marcas[i - 1]!).toBeGreaterThanOrEqual(100);
    }
  });
});

describe("criarThrottleConsultas", () => {
  const VAR = "INGEST_CONSULTAS_INTERVALO_MS";
  const original = process.env[VAR];

  afterEach(() => {
    if (original === undefined) delete process.env[VAR];
    else process.env[VAR] = original;
  });

  it("T6: le INGEST_CONSULTAS_INTERVALO_MS do env e espaca as chamadas", async () => {
    process.env[VAR] = "250";
    const rel = relogioFalso();
    const th = criarThrottleConsultas(rel);
    const marcas: number[] = [];
    for (let i = 0; i < 3; i++) {
      await th.esperar();
      marcas.push(rel.agora());
    }
    expect(marcas[1]! - marcas[0]!).toBeGreaterThanOrEqual(250);
    expect(marcas[2]! - marcas[1]!).toBeGreaterThanOrEqual(250);
    expect(marcas[2]! - marcas[1]!).toBeLessThan(1000);
  });
});

describe("lerIntervaloConsultas", () => {
  const VAR = "INGEST_CONSULTAS_INTERVALO_MS";

  it("C24: valor nao numerico cai em 1000", () => {
    expect(lerIntervaloConsultas({ [VAR]: "abc" })).toBe(1000);
  });

  it("C25: valor negativo cai em 1000", () => {
    expect(lerIntervaloConsultas({ [VAR]: "-5" })).toBe(1000);
  });

  it("C26: ausente = 1000; valor valido e respeitado", () => {
    expect(lerIntervaloConsultas({})).toBe(1000);
    expect(lerIntervaloConsultas({ [VAR]: "250" })).toBe(250);
  });
});
