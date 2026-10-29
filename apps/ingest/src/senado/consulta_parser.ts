/**
 * Parser puro da pagina de consulta publica do e-Cidadania (sem I/O, sem dependencia).
 * Regras: docs/consultas-publicas.md ("Regras para o parser"). Nunca lanca; ausencia ou
 * formato inesperado e `template_alterado`, nunca zero.
 */

export type MotivoSemDado = "encerrada" | "sem_apuracao";

export type ResultadoConsulta =
  | { tipo: "ok"; votosSim: number; votosNao: number; apuradoEm: Date }
  | { tipo: "sem_dado"; motivo: MotivoSemDado }
  | { tipo: "template_alterado"; motivo: string };

const BASE_URL = "https://www12.senado.leg.br/ecidadania/visualizacaomateria";

export function urlConsulta(cod: number): string {
  if (!Number.isSafeInteger(cod) || cod <= 0) {
    throw new RangeError(`codigo de consulta invalido: ${cod}`);
  }
  return `${BASE_URL}?id=${cod}`;
}

const alterado = (motivo: string): ResultadoConsulta => ({ tipo: "template_alterado", motivo });

/** Tag recortada por varredura linear: `ini` = posicao do `<`, `fim` = posicao apos o `>`. */
interface Tag {
  nome: string;
  fecha: boolean;
  attrs: string;
  ini: number;
  fim: number;
}

/**
 * Varredura linear (sem regex sobre o HTML inteiro): cada caractere e visitado uma vez. Regra unica
 * para tag, aspas e comentario:
 * - dentro de uma tag, `"`/`'` so abre aspa como primeiro caractere nao-espaco apos `=` (valor
 *   citado do HTML5); `<` e `>` entre aspas nao contam; um `<` fora de aspas reinicia a tag;
 * - `<` so abre tag quando seguido de letra, `/` ou `!` (como no HTML5); `<` solto em texto e texto;
 * - `<!--` fora de aspas abre comentario ate `-->` (sem `-->`, ate o fim do HTML); comentario nao e tag;
 * - sem `>` de fechamento (ou aspa nunca fechada) = fim da varredura.
 */
function varrer(html: string): { tags: Tag[]; comentarios: Array<[number, number]> } {
  const tags: Tag[] = [];
  const comentarios: Array<[number, number]> = [];
  let ini = -1;
  let aspa: string | null = null;
  let ultimo = "";
  for (let i = 0; i < html.length; i++) {
    const c = html[i] as string;
    if (aspa !== null) {
      if (c === aspa) {
        aspa = null;
        ultimo = c;
      }
      continue;
    }
    if (c === "<" && /[a-z/!]/i.test(html[i + 1] ?? "")) {
      if (html.startsWith("<!--", i)) {
        const f = html.indexOf("-->", i + 4);
        const fim = f === -1 ? html.length : f + 3;
        comentarios.push([i, fim]);
        ini = -1;
        i = fim - 1;
        continue;
      }
      ini = i;
      ultimo = "";
      continue;
    }
    if (ini === -1) continue;
    if ((c === '"' || c === "'") && ultimo === "=") {
      aspa = c;
    } else if (c === ">") {
      const interno = html.slice(ini + 1, i);
      const m = /^(\/?)([a-z][^\s/>]*)/i.exec(interno);
      if (m) {
        tags.push({
          nome: (m[2] as string).toLowerCase(),
          fecha: m[1] === "/",
          attrs: interno.slice(m[0].length),
          ini,
          fim: i + 1,
        });
      }
      ini = -1;
    } else if (c.trim() !== "") {
      ultimo = c;
    }
  }
  return { tags, comentarios };
}

const tokenizar = (html: string): Tag[] => varrer(html).tags;

/** HTML sem os comentarios `<!-- ... -->` (mesma regra de `varrer`: comentario dentro de aspas nao conta). */
function semComentarios(html: string): string {
  const { comentarios } = varrer(html);
  let saida = "";
  let i = 0;
  for (const [a, b] of comentarios) {
    saida += html.slice(i, a);
    i = b;
  }
  return saida + html.slice(i);
}

/** Indice da proxima tag de fechamento `nome` apos `de`, ou -1. */
function proximoFechamento(tags: Tag[], de: number, nome: string): number {
  for (let j = de + 1; j < tags.length; j++) {
    const t = tags[j] as Tag;
    if (t.fecha && t.nome === nome) return j;
  }
  return -1;
}

/** Fechamento do div aberto em `de`, contando divs aninhados. -1 se nunca fecha. */
function fechamentoDiv(tags: Tag[], de: number): number {
  let prof = 1;
  for (let j = de + 1; j < tags.length; j++) {
    const t = tags[j] as Tag;
    if (t.nome !== "div") continue;
    if (t.fecha) {
      prof--;
      if (prof === 0) return j;
    } else {
      // HTML5: `/` final nao autofecha elemento nao-void; `<div />` abre um div.
      prof++;
    }
  }
  return -1;
}

/** Elemento cujo atributo class contem o token informado. */
const temClasse = (classes: string, token: string): boolean => classes.split(/\s+/).includes(token);

function lerAttr(tag: string, nome: string): string | null {
  const m = new RegExp(`(?:^|\\s)${nome}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? "") : null;
}

function textoLimpo(html: string): string {
  const partes: string[] = [];
  let i = 0;
  for (const t of tokenizar(html)) {
    partes.push(html.slice(i, t.ini), " ");
    i = t.fim;
  }
  partes.push(html.slice(i));
  return partes
    .join("")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const RE_VALOR = /^\d{1,3}(\.\d{3})*$/;

function lerContagem(texto: string): number | null {
  const t = texto.trim();
  if (!RE_VALOR.test(t)) return null;
  const n = Number(t.replace(/\./g, ""));
  return Number.isSafeInteger(n) ? n : null;
}

/** "dd/mm/aaaa hh:mm:ss" em America/Sao_Paulo (offset fixo -03:00). Data impossivel = null. */
function lerApuracao(texto: string): Date | null {
  const m = /^Votos apurados até\s+(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(texto);
  if (!m) return null;
  const [dia, mes, ano, hora, min, seg] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (hora > 23 || min > 59 || seg > 59) return null;
  const local = new Date(Date.UTC(ano, mes - 1, dia, hora, min, seg));
  if (
    local.getUTCFullYear() !== ano ||
    local.getUTCMonth() !== mes - 1 ||
    local.getUTCDate() !== dia
  ) {
    return null;
  }
  return new Date(local.getTime() + 3 * 3600 * 1000);
}

function lerConsultaInterno(html: string, codEsperado: number): ResultadoConsulta {
  // Regra 1: comentarios HTML saem antes de qualquer busca.
  const limpo = semComentarios(html);

  // Regra 5: identidade (precede `encerrada`).
  const tags = tokenizar(limpo);
  const ids = tags.filter(
    (t) => !t.fecha && t.nome === "input" && lerAttr(t.attrs, "id") === "materiaId",
  );
  if (ids.length !== 1) return alterado("input#materiaId ausente ou duplicado");
  const valorId = (lerAttr((ids[0] as Tag).attrs, "value") ?? "").trim();
  if (!/^\d+$/.test(valorId) || Number(valorId) !== codEsperado) {
    return alterado(`materiaId diferente do esperado (${codEsperado})`);
  }

  // Regra 4: tramitacao encerrada.
  for (const t of tags) {
    if (t.fecha) continue;
    const cls = lerAttr(t.attrs, "class");
    if (cls !== null && temClasse(cls, "tramitacao-encerrada")) {
      return { tipo: "sem_dado", motivo: "encerrada" };
    }
  }

  // Regra 3: apuracao (localizada pelo id; conteudo ate o </div> correspondente).
  const iMsg = tags.findIndex(
    (t) => !t.fecha && t.nome === "div" && lerAttr(t.attrs, "id") === "msg-contabilizacao-voto",
  );
  const iFimMsg = iMsg === -1 ? -1 : fechamentoDiv(tags, iMsg);
  if (iMsg === -1 || iFimMsg === -1) return { tipo: "sem_dado", motivo: "sem_apuracao" };
  const conteudoMsg = limpo.slice((tags[iMsg] as Tag).fim, (tags[iFimMsg] as Tag).ini);
  const apuradoEm = lerApuracao(textoLimpo(conteudoMsg));
  if (!apuradoEm) return alterado("data de apuracao ausente ou invalida");

  // Regra 2: placar, so nos spans do footer do figure (nunca a largura da barra).
  let rodape: string | null = null;
  let iFim = -1;
  for (let i = 0; i < tags.length; i++) {
    const f = tags[i] as Tag;
    if (f.fecha || f.nome !== "figure") continue;
    iFim = proximoFechamento(tags, i, "figure");
    if (iFim === -1) break;
    const cls = lerAttr(f.attrs, "class");
    if (cls !== null && temClasse(cls, "grafico-consulta-publica")) {
      const iFoot = tags.findIndex((t, j) => j > i && j < iFim && !t.fecha && t.nome === "footer");
      const iFimFoot = iFoot === -1 ? -1 : proximoFechamento(tags, iFoot, "footer");
      if (iFoot !== -1 && iFimFoot !== -1 && iFimFoot < iFim) {
        rodape = limpo.slice((tags[iFoot] as Tag).fim, (tags[iFimFoot] as Tag).ini);
      }
      break;
    }
    i = iFim;
  }
  if (rodape === null) return alterado("bloco do placar ausente");

  const favor: string[] = [];
  const contra: string[] = [];
  const tagsRodape = tokenizar(rodape);
  for (let i = 0; i < tagsRodape.length; i++) {
    const s = tagsRodape[i] as Tag;
    if (s.fecha || s.nome !== "span") continue;
    const iFimSpan = proximoFechamento(tagsRodape, i, "span");
    if (iFimSpan === -1) break;
    const conteudo = rodape.slice(s.fim, (tagsRodape[iFimSpan] as Tag).ini);
    i = iFimSpan;
    const cls = lerAttr(s.attrs, "class");
    if (cls === null) continue;
    if (temClasse(cls, "contabilizacao-favor")) favor.push(conteudo);
    if (temClasse(cls, "contabilizacao-contra")) contra.push(conteudo);
  }
  if (favor.length !== 1 || contra.length !== 1) return alterado("spans do placar ausentes ou duplicados");
  const votosSim = lerContagem(favor[0] as string);
  const votosNao = lerContagem(contra[0] as string);
  if (votosSim === null || votosNao === null) return alterado("valor do placar fora do formato");

  return { tipo: "ok", votosSim, votosNao, apuradoEm };
}

/** Le o placar de `visualizacaomateria?id=<codEsperado>`. Nunca lanca. */
export function lerConsulta(html: string, codEsperado: number): ResultadoConsulta {
  try {
    if (typeof html !== "string") return alterado("entrada nao e texto");
    return lerConsultaInterno(html, codEsperado);
  } catch {
    return alterado("falha inesperada ao ler o HTML");
  }
}
