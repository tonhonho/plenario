import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { buscarJson, buscarTexto } from "./http";

type Chamada = { url: string; init: RequestInit | undefined };

const fetchOriginal = globalThis.fetch;
let chamadas: Chamada[] = [];
let respostas: (() => Response)[] = [];
let sleeps: number[] = [];
let sleepSpy: ReturnType<typeof spyOn>;

function stubFetch(fabricas: (() => Response)[]) {
  respostas = [...fabricas];
  chamadas = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    chamadas.push({ url: String(input), init });
    const proxima = respostas.shift();
    if (!proxima) throw new Error("fetch sem resposta stubada");
    return proxima();
  }) as typeof fetch;
}

function cabecalho(c: Chamada, nome: string): string | undefined {
  const h = c.init?.headers as Record<string, string> | undefined;
  return h?.[nome];
}

beforeEach(() => {
  sleeps = [];
  sleepSpy = spyOn(Bun, "sleep").mockImplementation(async (ms: number | Date) => {
    sleeps.push(Number(ms));
  });
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
  sleepSpy.mockRestore();
});

describe("buscarTexto", () => {
  it("C17: envia Accept text/html e o UA, devolve ok com o corpo", async () => {
    stubFetch([() => new Response("<html>oi</html>", { status: 200 })]);
    const r = await buscarTexto("https://exemplo.test/a");
    expect(r).toEqual({ tipo: "ok", corpo: "<html>oi</html>" });
    expect(chamadas).toHaveLength(1);
    expect(cabecalho(chamadas[0]!, "Accept")).toBe("text/html");
    expect(cabecalho(chamadas[0]!, "User-Agent")).toStartWith("plenario/0.1");
  });

  it("C18: 302 devolve redirecionada sem retry", async () => {
    stubFetch([() => new Response(null, { status: 302 }), () => new Response("x", { status: 200 })]);
    const r = await buscarTexto("https://exemplo.test/b");
    expect(r).toEqual({ tipo: "redirecionada", status: 302 });
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.init?.redirect).toBe("manual");
  });

  it("C19: 500 seguido de 200 refaz e devolve ok", async () => {
    stubFetch([() => new Response("erro", { status: 500 }), () => new Response("ok", { status: 200 })]);
    const r = await buscarTexto("https://exemplo.test/c");
    expect(r).toEqual({ tipo: "ok", corpo: "ok" });
    expect(chamadas).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
  });

  it("C19: 429 seguido de 200 refaz e devolve ok", async () => {
    stubFetch([() => new Response("lento", { status: 429 }), () => new Response("ok", { status: 200 })]);
    const r = await buscarTexto("https://exemplo.test/d");
    expect(r).toEqual({ tipo: "ok", corpo: "ok" });
    expect(chamadas).toHaveLength(2);
  });

  it("C20: 404 lanca sem retry", async () => {
    const url = "https://exemplo.test/e";
    stubFetch([() => new Response("nada", { status: 404 }), () => new Response("x", { status: 200 })]);
    const resultado = await buscarTexto(url).then(
      () => "resolveu",
      (e: unknown) => (e instanceof Error ? e.message : "erro estranho"),
    );
    expect(resultado).toBe(`404 em ${url}`);
    expect(chamadas).toHaveLength(1);
  });
});

const TETO = 5 * 1024 * 1024;

// Stream que so entrega os chunks quando puxado e nunca fecha sozinho: `cancel` do corpo chega ao
// underlying source (stream ja fechado nao repassa o cancel).
function respostaStream(
  chunks: Uint8Array[],
  status: number,
  aoCancelar: () => void | Promise<void> = () => undefined,
): Response {
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      const proximo = chunks[i++];
      if (proximo) c.enqueue(proximo);
      else c.close();
    },
    cancel() {
      return aoCancelar();
    },
  });
  return new Response(stream, { status });
}

function bloco(tamanho: number): Uint8Array {
  return new Uint8Array(tamanho).fill(97);
}

describe("buscarTexto: corpo nao lido e teto", () => {
  it("T2: 3xx cancela o corpo e devolve redirecionada", async () => {
    let cancelado = 0;
    stubFetch([() => respostaStream([bloco(4)], 302, () => void cancelado++)]);
    const r = await buscarTexto("https://exemplo.test/r1");
    expect(r).toEqual({ tipo: "redirecionada", status: 302 });
    expect(cancelado).toBe(1);
  });

  it("T2: 404 cancela o corpo e lanca", async () => {
    const url = "https://exemplo.test/r2";
    let cancelado = 0;
    stubFetch([() => respostaStream([bloco(4)], 404, () => void cancelado++)]);
    const msg = await buscarTexto(url).then(
      () => "resolveu",
      (e: unknown) => (e instanceof Error ? e.message : "erro estranho"),
    );
    expect(msg).toBe(`404 em ${url}`);
    expect(cancelado).toBe(1);
  });

  it("T2: 500 seguido de 200 cancela o corpo do 500 antes do retry", async () => {
    let cancelado = 0;
    stubFetch([
      () => respostaStream([bloco(4)], 500, () => void cancelado++),
      () => new Response("ok", { status: 200 }),
    ]);
    const r = await buscarTexto("https://exemplo.test/r3");
    expect(r).toEqual({ tipo: "ok", corpo: "ok" });
    expect(cancelado).toBe(1);
    expect(chamadas).toHaveLength(2);
  });

  it("T2: cancel rejeitando no 3xx ainda devolve redirecionada", async () => {
    stubFetch([() => respostaStream([bloco(4)], 302, () => Promise.reject(new Error("falhou")))]);
    const r = await buscarTexto("https://exemplo.test/r4");
    expect(r).toEqual({ tipo: "redirecionada", status: 302 });
  });

  it("T2: cancel rejeitando no 404 ainda lanca o erro do status", async () => {
    const url = "https://exemplo.test/r5";
    stubFetch([() => respostaStream([bloco(4)], 404, () => Promise.reject(new Error("falhou")))]);
    const msg = await buscarTexto(url).then(
      () => "resolveu",
      (e: unknown) => (e instanceof Error ? e.message : "erro estranho"),
    );
    expect(msg).toBe(`404 em ${url}`);
  });

  it("T2: cancel rejeitando no retry nao impede o retry", async () => {
    stubFetch([
      () => respostaStream([bloco(4)], 503, () => Promise.reject(new Error("falhou"))),
      () => new Response("ok", { status: 200 }),
    ]);
    const r = await buscarTexto("https://exemplo.test/r6");
    expect(r).toEqual({ tipo: "ok", corpo: "ok" });
  });

  it("T2: corpo acima do teto de 5 MiB lanca sem retry e cancela o leitor", async () => {
    const url = "https://exemplo.test/grande";
    let cancelado = 0;
    const chunks = [...Array.from({ length: 5 }, () => bloco(1024 * 1024)), bloco(1), bloco(1)];
    stubFetch([() => respostaStream(chunks, 200, () => void cancelado++), () => new Response("x")]);
    const msg = await buscarTexto(url).then(
      () => "resolveu",
      (e: unknown) => (e instanceof Error ? e.message : "erro estranho"),
    );
    expect(msg).toContain(String(TETO));
    expect(msg).toContain(url);
    expect(chamadas).toHaveLength(1);
    expect(cancelado).toBe(1);
  });

  it("T2: corpo exatamente no teto devolve ok", async () => {
    const chunks = Array.from({ length: 5 }, () => bloco(1024 * 1024));
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(ch);
        c.close();
      },
    });
    stubFetch([() => new Response(stream, { status: 200 })]);
    const r = await buscarTexto("https://exemplo.test/no-teto");
    expect(r.tipo).toBe("ok");
    expect(r.tipo === "ok" ? r.corpo.length : -1).toBe(TETO);
  });

  it("T2: caractere multibyte partido entre chunks volta intacto", async () => {
    const bytes = new TextEncoder().encode("aç");
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 2));
        c.enqueue(bytes.slice(2));
        c.close();
      },
    });
    stubFetch([() => new Response(stream, { status: 200 })]);
    const r = await buscarTexto("https://exemplo.test/utf8");
    expect(r).toEqual({ tipo: "ok", corpo: "aç" });
  });
});

describe("retry esgotado e backoff", () => {
  it("T6: 5xx em todas as tentativas lanca o status e chama fetch `tentativas` vezes", async () => {
    const url = "https://exemplo.test/sempre-503";
    stubFetch([
      () => new Response("e", { status: 503 }),
      () => new Response("e", { status: 503 }),
      () => new Response("e", { status: 503 }),
      () => new Response("ok", { status: 200 }),
    ]);
    const msg = await buscarTexto(url, 3).then(
      () => "resolveu",
      (e: unknown) => (e instanceof Error ? e.message : "erro estranho"),
    );
    expect(msg).toBe(`503 em ${url}`);
    expect(chamadas).toHaveLength(3);
  });

  it("T6: 429 dorme o backoff do codigo (500 * 2^i)", async () => {
    stubFetch([
      () => new Response("l", { status: 429 }),
      () => new Response("l", { status: 429 }),
      () => new Response("ok", { status: 200 }),
    ]);
    const r = await buscarTexto("https://exemplo.test/429");
    expect(r).toEqual({ tipo: "ok", corpo: "ok" });
    expect(sleeps).toEqual([1000, 2000]);
  });
});

describe("buscarJson", () => {
  it("C21: mantem Accept application/json e UA", async () => {
    stubFetch([() => new Response(JSON.stringify({ a: 1 }), { status: 200 })]);
    const r = await buscarJson<{ a: number }>("https://exemplo.test/j");
    expect(r).toEqual({ a: 1 });
    expect(cabecalho(chamadas[0]!, "Accept")).toBe("application/json");
    expect(cabecalho(chamadas[0]!, "User-Agent")).toStartWith("plenario/0.1");
    expect(chamadas[0]!.init?.redirect).toBe("follow");
  });
});
