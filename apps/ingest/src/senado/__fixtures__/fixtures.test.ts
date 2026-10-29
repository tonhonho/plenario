import { describe, expect, test } from "bun:test";

const ler = (nome: string): Promise<string> =>
  Bun.file(new URL(`./${nome}`, import.meta.url)).text();

describe("fixtures recortadas do e-Cidadania (texto cru, sem parser)", () => {
  test("p160575: materiaId 160575, placar 721.508 x 1.142.443, comentarios 10+ e data da apuracao", async () => {
    const html = await ler("p160575.html");
    expect(html).toContain('<input type="hidden" id="materiaId" value="160575" />');
    expect(html).toContain('<span class="contabilizacao-favor">721.508</span>');
    expect(html).toContain('<span class="contabilizacao-contra">1.142.443</span>');
    expect(html.match(/10\+<\/span>/g)?.length).toBe(4);
    expect(html).toContain("Votos apurados até 28/10/2026 10:18:46");
  });

  test("p172395: materiaId 172395, placar 439 x 371 sem separador de milhar", async () => {
    const html = await ler("p172395.html");
    expect(html).toContain('<input type="hidden" id="materiaId" value="172395" />');
    expect(html).toContain('<span class="contabilizacao-favor">439</span>');
    expect(html).toContain('<span class="contabilizacao-contra">371</span>');
  });

  test("p176111: materiaId 176111, placar 0 x 0 com marcador presente e apuracao informada", async () => {
    const html = await ler("p176111.html");
    expect(html).toContain('<input type="hidden" id="materiaId" value="176111" />');
    expect(html).toContain('<span class="contabilizacao-favor">0</span>');
    expect(html).toContain('<span class="contabilizacao-contra">0</span>');
    expect(html).toContain('<div id="msg-contabilizacao-voto">Votos apurados até');
  });

  test("p1181: materiaId 1181 encerrada, sem bloco de apuracao", async () => {
    const html = await ler("p1181.html");
    expect(html).toContain('<input type="hidden" id="materiaId" value="1181" />');
    expect(html).toContain('<div class="tramitacao-encerrada text-right">');
    expect(html).not.toContain("msg-contabilizacao-voto");
  });

  test("p999999999.hdr: resposta 302 com Location para principalmateria", async () => {
    const hdr = await ler("p999999999.hdr");
    expect(hdr).toMatch(/^HTTP\/1\.1 302\b/m);
    expect(hdr).toMatch(/^location:\s*principalmateria\s*$/im);
  });
});
