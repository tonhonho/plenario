import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { lerConsulta, urlConsulta } from "./consulta_parser";

const fx = (n: string): string =>
  readFileSync(new URL(`./__fixtures__/${n}.html`, import.meta.url), "utf8");

/** Substitui `de` por `para` e prova que casou (senao a variante seria igual ao original e o teste, vacuo). */
const troca = (html: string, de: string, para: string): string => {
  expect(html.includes(de)).toBe(true);
  const novo = html.replace(de, para);
  expect(novo).not.toBe(html);
  return novo;
};

const alterado = { tipo: "template_alterado" };

describe("lerConsulta", () => {
  test("C1: 160575 ok 721508 x 1142443 sem ler os 10+ dos comentarios", () => {
    expect(lerConsulta(fx("p160575"), 160575)).toEqual({
      tipo: "ok",
      votosSim: 721508,
      votosNao: 1142443,
      apuradoEm: new Date("2026-10-28T13:18:46.000Z"),
    });
    // Comentario com spans dentro do proprio footer: se fosse lido, duplicaria o placar.
    const comComentario = troca(
      fx("p160575"),
      "<footer>",
      '<footer><!-- <span class="contabilizacao-favor">10+</span><span class="contabilizacao-contra">10+</span> -->',
    );
    expect(lerConsulta(comComentario, 160575)).toMatchObject({
      tipo: "ok",
      votosSim: 721508,
      votosNao: 1142443,
    });
  });

  test("C2: apuradoEm 28/10/2026 10:18:46 e 2026-10-28T13:18:46.000Z (-03:00 fixo)", () => {
    const r = lerConsulta(fx("p160575"), 160575);
    expect(r.tipo === "ok" && r.apuradoEm.toISOString()).toBe("2026-10-28T13:18:46.000Z");
  });

  test("C3: 176111 ok com 0 x 0 quando o marcador diz 0", () => {
    expect(lerConsulta(fx("p176111"), 176111)).toEqual({
      tipo: "ok",
      votosSim: 0,
      votosNao: 0,
      apuradoEm: new Date("2026-10-28T13:19:32.000Z"),
    });
  });

  test("C4: 160575 sem o bloco do placar e template_alterado, nunca ok 0 x 0", () => {
    const html = troca(
      fx("p160575"),
      '<figure class="grafico-consulta-publica">',
      '<figure class="outro">',
    );
    expect(lerConsulta(html, 160575)).toMatchObject(alterado);
  });

  test("C5: 1181 e sem_dado encerrada", () => {
    expect(lerConsulta(fx("p1181"), 1181)).toEqual({ tipo: "sem_dado", motivo: "encerrada" });
  });

  test("C6: sem msg-contabilizacao-voto e sem tramitacao-encerrada e sem_dado sem_apuracao", () => {
    const html = troca(fx("p176111"), 'id="msg-contabilizacao-voto"', 'id="outro"');
    expect(lerConsulta(html, 176111)).toEqual({ tipo: "sem_dado", motivo: "sem_apuracao" });
  });

  test("C7: materiaId diferente de codEsperado e template_alterado (inclusive 1181)", () => {
    expect(lerConsulta(fx("p160575"), 5)).toMatchObject(alterado);
    expect(lerConsulta(fx("p1181"), 5)).toMatchObject(alterado);
    const sem = troca(fx("p160575"), 'id="materiaId"', 'id="outroId"');
    expect(lerConsulta(sem, 160575)).toMatchObject(alterado);
  });

  test("C8: valor do placar 1.14 e template_alterado", () => {
    const html = troca(fx("p160575"), ">721.508<", ">1.14<");
    expect(lerConsulta(html, 160575)).toMatchObject(alterado);
  });

  test("C9: valor do placar abc e template_alterado", () => {
    const html = troca(fx("p160575"), ">721.508<", ">abc<");
    expect(lerConsulta(html, 160575)).toMatchObject(alterado);
  });

  test("C10: valor do placar vazio e template_alterado", () => {
    const html = troca(fx("p160575"), ">721.508<", "><");
    expect(lerConsulta(html, 160575)).toMatchObject(alterado);
  });

  test("C11: data impossivel e ancora ausente sao template_alterado", () => {
    const dataImpossivel = troca(fx("p160575"), "28/10/2026 10:18:46", "31/02/2026 10:18:46");
    expect(lerConsulta(dataImpossivel, 160575)).toMatchObject(alterado);
    const semAncora = troca(fx("p160575"), "Votos apurados até", "Apurado em");
    expect(lerConsulta(semAncora, 160575)).toMatchObject(alterado);
  });

  test("C12: span favor duplicado ou contra ausente e template_alterado", () => {
    const duplicado = troca(
      fx("p160575"),
      '<span class="contabilizacao-contra">1.142.443</span>',
      '<span class="contabilizacao-favor">1</span><span class="contabilizacao-contra">1.142.443</span>',
    );
    expect(lerConsulta(duplicado, 160575)).toMatchObject(alterado);
    const semContra = troca(
      fx("p160575"),
      '<span class="contabilizacao-contra">1.142.443</span>',
      '<span class="outro">1.142.443</span>',
    );
    expect(lerConsulta(semContra, 160575)).toMatchObject(alterado);
  });

  test("C13: largura da barra 50% com 0 votos nao influencia o resultado", () => {
    const base = fx("p176111");
    expect(base.includes("width:50%")).toBe(true);
    const outraLargura = troca(base, "width:50%", "width:80%");
    expect(lerConsulta(outraLargura, 176111)).toMatchObject({ tipo: "ok", votosSim: 0, votosNao: 0 });
    expect(lerConsulta(base, 176111)).toMatchObject({ tipo: "ok", votosSim: 0, votosNao: 0 });
  });

  test("C14: nao lanca para HTML arbitrario", () => {
    expect(lerConsulta("", 1)).toMatchObject(alterado);
    expect(lerConsulta("<<<!-- x", 1)).toMatchObject(alterado);
    expect(lerConsulta("lixo qualquer </div><figure", 1)).toMatchObject(alterado);
  });

  test("C15: urlConsulta(160575)", () => {
    expect(urlConsulta(160575)).toBe(
      "https://www12.senado.leg.br/ecidadania/visualizacaomateria?id=160575",
    );
  });

  test("T4c1-a: template_alterado traz motivo (string nao vazia)", () => {
    const r = lerConsulta("", 1);
    expect(r.tipo).toBe("template_alterado");
    const motivo = r.tipo === "template_alterado" ? r.motivo : "";
    expect(typeof motivo).toBe("string");
    expect(motivo.length).toBeGreaterThan(0);
    expect("detalhe" in r).toBe(false);
  });

  test("T4c1-b: HTML adversarial sem '>' termina rapido e e template_alterado", () => {
    const entradas = [
      "<input ".repeat(50_000),
      "<a".repeat(80_000),
      '<div id="msg-contabilizacao-voto" '.repeat(5000),
      '<input id="materiaId" value="1">\n<div id="msg-contabilizacao-voto">lixo' +
        '<div id="msg-contabilizacao-voto" '.repeat(5000) +
        "</div>",
      // aspa aberta e reaberta sem fechar a tag
      '<input title="'.repeat(50_000),
      // comentario aberto repetido, nunca fechado
      "<!--".repeat(80_000),
    ];
    for (const html of entradas) {
      const t0 = performance.now();
      const r = lerConsulta(html, 1);
      const ms = performance.now() - t0;
      expect(r.tipo).toBe("template_alterado");
      expect(ms).toBeLessThan(2000);
    }
  });

  test("T4c2-a: msg-contabilizacao-voto com divs nunca fechados termina rapido e e sem_apuracao", () => {
    const html =
      '<input id="materiaId" value="1">\n<div id="msg-contabilizacao-voto">' + "<div>".repeat(50_000);
    const t0 = performance.now();
    const r = lerConsulta(html, 1);
    const ms = performance.now() - t0;
    expect(r).toEqual({ tipo: "sem_dado", motivo: "sem_apuracao" });
    expect(ms).toBeLessThan(2000);
  });

  test("T4c2-b: '<' e '>' dentro de valor de atributo entre aspas nao cortam a tag", () => {
    const html = troca(fx("p160575"), 'id="materiaId"', 'id="materiaId" title="a<b>c"');
    expect(lerConsulta(html, 160575)).toMatchObject({
      tipo: "ok",
      votosSim: 721508,
      votosNao: 1142443,
    });
    const encerrada =
      '<input id="materiaId" value="1181"><div title="a<b>c" class="tramitacao-encerrada">x</div>';
    expect(lerConsulta(encerrada, 1181)).toEqual({ tipo: "sem_dado", motivo: "encerrada" });
  });

  test("T4c2-c: '/' final nao autofecha div (HTML5): <div data-x=a/> abre um div", () => {
    const html = troca(
      fx("p160575"),
      "Votos apurados até 28/10/2026 10:18:46</div>",
      "<div data-x=a/>Votos apurados até </div>28/10/2026 10:18:46</div>",
    );
    expect(lerConsulta(html, 160575)).toMatchObject({
      tipo: "ok",
      apuradoEm: new Date("2026-10-28T13:18:46.000Z"),
    });
  });

  test("T4c3-a: apostrofo fora de valor citado nao abre aspa (<a title=it's>, title='a<b>c')", () => {
    const placar = { tipo: "ok", votosSim: 721508, votosNao: 1142443 };
    const figure = '<figure class="grafico-consulta-publica">';
    const apostrofo = troca(fx("p160575"), figure, `<a title=it's>${figure}`);
    expect(lerConsulta(apostrofo, 160575)).toMatchObject(placar);
    const simples = troca(fx("p160575"), 'id="materiaId"', `id="materiaId" title='a<b>c'`);
    expect(lerConsulta(simples, 160575)).toMatchObject(placar);
    expect(lerConsulta("<a title=it's>" + fx("p1181"), 1181)).toEqual({
      tipo: "sem_dado",
      motivo: "encerrada",
    });
  });

  test("T4c4-a: '<' solto em texto nao abre tag nem aspa (a < b = \"q, 5 < 6 isn't = 'x)", () => {
    const figure = '<figure class="grafico-consulta-publica">';
    const encerrada = troca(
      fx("p160575"),
      figure,
      `<p>a < b = "q</p><div class="tramitacao-encerrada"></div>${figure}`,
    );
    expect(lerConsulta(encerrada, 160575)).toEqual({ tipo: "sem_dado", motivo: "encerrada" });
    const apostrofo = troca(fx("p160575"), figure, `<p>5 < 6 isn't = 'x</p>${figure}`);
    expect(lerConsulta(apostrofo, 160575)).toMatchObject({
      tipo: "ok",
      votosSim: 721508,
      votosNao: 1142443,
    });
  });

  test("T4c3-b: '>' dentro de atributo citado numa tag dentro da msg nao deixa lixo no texto", () => {
    const html = troca(
      fx("p160575"),
      "Votos apurados até",
      '<b title="x>y" data-z=\'a>b\'></b> Votos apurados até',
    );
    expect(lerConsulta(html, 160575)).toMatchObject({
      tipo: "ok",
      apuradoEm: new Date("2026-10-28T13:18:46.000Z"),
    });
  });

  test("T4c3-c: title=\"<!--\" dentro de tag nao abre comentario; <!-- sem --> vai ate o fim", () => {
    const html = troca(fx("p160575"), 'id="materiaId"', 'id="materiaId" title="<!--"');
    expect(lerConsulta(html, 160575)).toMatchObject({
      tipo: "ok",
      votosSim: 721508,
      votosNao: 1142443,
    });
    const aberto = troca(fx("p160575"), "<footer>", "<footer><!-- sem fim");
    // O resto do HTML e comentario: nada do que vem depois (inclusive o fechamento da msg) e lido.
    expect(lerConsulta(aberto, 160575)).toEqual({ tipo: "sem_dado", motivo: "sem_apuracao" });
  });

  test("T4c1-c: div aninhado dentro de msg-contabilizacao-voto nao corta a data", () => {
    const html = troca(
      fx("p160575"),
      "Votos apurados até",
      "<div><b></b></div> Votos apurados até",
    );
    expect(lerConsulta(html, 160575)).toMatchObject({
      tipo: "ok",
      apuradoEm: new Date("2026-10-28T13:18:46.000Z"),
    });
  });

  test("T4c1-d: urlConsulta lanca RangeError para codigo invalido", () => {
    for (const cod of [Number.NaN, 1.5, 0, -1, 1e21]) {
      expect(() => urlConsulta(cod)).toThrow(RangeError);
    }
    expect(urlConsulta(7)).toBe("https://www12.senado.leg.br/ecidadania/visualizacaomateria?id=7");
  });

  test("C16: 172395 sem milhar e ok 439 x 371", () => {
    const r = lerConsulta(fx("p172395"), 172395);
    expect(r).toMatchObject({ tipo: "ok", votosSim: 439, votosNao: 371 });
  });
});
