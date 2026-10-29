/**
 * Regras puras do sync das consultas publicas (sem I/O, sem banco). Decisoes: docs/consultas-publicas.md
 * (D2 primeiro signatario, D3 ref_id por mes em America/Sao_Paulo, D5/D6 selecao e pulo).
 */
import { HOST_FONTE, urlFonteConsultaValida } from "@plenario/core/fonte";
import type { RespostaTexto } from "../http";
import { urlConsulta, type ResultadoConsulta } from "./consulta_parser";

// ---------- resposta HTTP ----------

export type MotivoPulo = "materia_inexistente" | "redirecao_inesperada";

export type ClassificacaoResposta =
  | { acao: "ler"; html: string }
  | { acao: "pular"; motivo: MotivoPulo };

/** Redirecionamentos que o e-Cidadania usa para "materia nao existe" (ex.: 302 -> principalmateria). */
const STATUS_MATERIA_INEXISTENTE: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Qualquer outro 3xx (300, 304...) nao prova inexistencia: pula com motivo proprio. */
export function classificarResposta(resp: RespostaTexto): ClassificacaoResposta {
  if (resp.tipo === "ok") return { acao: "ler", html: resp.corpo };
  return {
    acao: "pular",
    motivo: STATUS_MATERIA_INEXISTENTE.has(resp.status) ? "materia_inexistente" : "redirecao_inesperada",
  };
}

// ---------- validacao da leitura ----------

export interface Leitura {
  cod: number;
  votosSim: number;
  votosNao: number;
  apuradoEm: Date;
  urlFonte: string;
}

export type ValidacaoLeitura = { ok: true; leitura: Leitura } | { ok: false; motivo: string };

const contagemValida = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;

export function validarLeitura(l: Leitura): ValidacaoLeitura {
  if (!Number.isSafeInteger(l.cod) || l.cod <= 0) return { ok: false, motivo: "codigo invalido" };
  if (!urlFonteConsultaValida(l.urlFonte)) return { ok: false, motivo: "url_fonte fora de https://" + HOST_FONTE };
  if (!contagemValida(l.votosSim)) return { ok: false, motivo: "votosSim invalido" };
  if (!contagemValida(l.votosNao)) return { ok: false, motivo: "votosNao invalido" };
  if (!(l.apuradoEm instanceof Date) || Number.isNaN(l.apuradoEm.getTime())) {
    return { ok: false, motivo: "apuradoEm invalido" };
  }
  return { ok: true, leitura: l };
}

/** Unico caminho de resultado do parser para leitura gravavel: so `ok` do parser, depois `validarLeitura`. */
export function leituraDoResultado(r: ResultadoConsulta, cod: number): ValidacaoLeitura {
  if (r.tipo !== "ok") {
    return { ok: false, motivo: r.tipo === "sem_dado" ? `sem_dado:${r.motivo}` : `template_alterado:${r.motivo}` };
  }
  return validarLeitura({
    cod,
    votosSim: r.votosSim,
    votosNao: r.votosNao,
    apuradoEm: r.apuradoEm,
    urlFonte: urlConsulta(cod),
  });
}

// ---------- evento (D2, D3) ----------

/** AAAA-MM do instante em America/Sao_Paulo. */
export function mesDaApuracao(apuradoEm: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(apuradoEm).slice(0, 7);
}

export interface AutorOrdem {
  parlamentarId: string;
  ordem: number | null;
}

/** `ordem = 1`, ou `ordem` nula com exatamente 1 linha de autor (mesmo predicado de `papelAutoria` da API). */
export function primeiroSignatario(autores: readonly AutorOrdem[]): string | null {
  const primeiro = autores.find((a) => a.ordem === 1);
  if (primeiro) return primeiro.parlamentarId;
  const unico = autores.length === 1 ? autores[0] : undefined;
  return unico && unico.ordem === null ? unico.parlamentarId : null;
}

export interface EventoConsulta {
  parlamentarId: string;
  tipo: "consulta_publica";
  ocorridoEm: Date;
  refId: string;
  resumo: { votosSim: number; votosNao: number; apuradoEm: string };
}

export function montarEvento(args: {
  proposicaoId: string;
  autores: readonly AutorOrdem[];
  leitura: Leitura;
  /** `proposicao.data_apresentacao`; nula = fallback para `leitura.apuradoEm`. */
  dataApresentacao: Date | null;
}): EventoConsulta | null {
  const parlamentarId = primeiroSignatario(args.autores);
  if (parlamentarId === null) return null;
  const { leitura } = args;
  // um evento por proposicao: data e mes do ref_id vem da apresentacao, estaveis entre leituras
  const ocorridoEm = args.dataApresentacao ?? leitura.apuradoEm;
  return {
    parlamentarId,
    tipo: "consulta_publica",
    ocorridoEm,
    refId: `${args.proposicaoId}:${mesDaApuracao(ocorridoEm)}`,
    resumo: {
      votosSim: leitura.votosSim,
      votosNao: leitura.votosNao,
      apuradoEm: leitura.apuradoEm.toISOString(),
    },
  };
}

// ---------- selecao ----------

export interface Candidata {
  proposicaoId: string;
  /** `null` = nunca lida. */
  apuradoEm: Date | null;
}

/** Nunca lida primeiro; depois `apuradoEm` mais antigo; empate por `proposicaoId`. Nao muta a entrada. */
export function ordenarCandidatas<T extends Candidata>(candidatas: readonly T[]): T[] {
  return [...candidatas].sort((a, b) => {
    if (a.apuradoEm === null && b.apuradoEm !== null) return -1;
    if (a.apuradoEm !== null && b.apuradoEm === null) return 1;
    if (a.apuradoEm !== null && b.apuradoEm !== null) {
      const d = a.apuradoEm.getTime() - b.apuradoEm.getTime();
      if (d !== 0) return d;
    }
    return a.proposicaoId < b.proposicaoId ? -1 : a.proposicaoId > b.proposicaoId ? 1 : 0;
  });
}

// ---------- pulo registrado no cursor (A2) ----------

export const DIAS_PULO = 30;
export const DIAS_PULO_CURTO = 3;
const MS_DIA = 24 * 3600 * 1000;

export type MotivoRegistro = "encerrada" | "materia_inexistente" | "sem_apuracao" | "falha_leitura";

/** Prazo do pulo por motivo: estado duradouro = 30 dias; sem apuracao ou falha de leitura = 3 dias. */
export const DIAS_PULO_POR_MOTIVO: Readonly<Record<MotivoRegistro, number>> = {
  encerrada: DIAS_PULO,
  materia_inexistente: DIAS_PULO,
  sem_apuracao: DIAS_PULO_CURTO,
  falha_leitura: DIAS_PULO_CURTO,
};

export interface RegistroPulo {
  em: string; // ISO
  motivo: MotivoRegistro;
}

export type Puladas = Record<string, RegistroPulo>;

const vencido = (r: RegistroPulo, agora: Date): boolean =>
  agora.getTime() - Date.parse(r.em) >= DIAS_PULO_POR_MOTIVO[r.motivo] * MS_DIA;

/** Registro vigente (dentro do prazo do motivo) = pula; sem registro ou vencido = nao pula. */
export function devePularPorRegistro(registro: RegistroPulo | undefined, agora: Date): boolean {
  return registro !== undefined && !vencido(registro, agora);
}

/** Remove so as entradas vencidas. Nao muta a entrada. */
export function podarPuladas(puladas: Puladas, agora: Date): Puladas {
  return Object.fromEntries(Object.entries(puladas).filter(([, r]) => !vencido(r, agora)));
}

// ---------- falhas seguidas (A3) ----------

export const LIMITE_FALHAS_SEGUIDAS = 10;

/** `falha` incrementa; `ok` zera; `pulo_esperado` (encerrada, inexistente, sem_apuracao) mantem. */
export type Desfecho = "falha" | "ok" | "pulo_esperado";

export function proximaContagemFalhas(falhas: number, desfecho: Desfecho): number {
  if (desfecho === "falha") return falhas + 1;
  if (desfecho === "ok") return 0;
  return falhas;
}

export const deveAbortar = (falhasSeguidas: number): boolean => falhasSeguidas >= LIMITE_FALHAS_SEGUIDAS;
