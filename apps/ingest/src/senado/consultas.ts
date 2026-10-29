/**
 * Sync das consultas publicas do e-Cidadania (I/O). Regras puras em consultas_regras.ts;
 * decisoes em docs/consultas-publicas.md. Nao grava o cursor: devolve o mapa de puladas e os
 * contadores para quem chama (index.ts) gravar tudo numa unica `gravarCursor`.
 */
import { db, schema } from "@plenario/core/db";
import { and, eq, inArray, ne, or, sql as dsql } from "drizzle-orm";
import { buscarTexto } from "../http";
import { criarThrottleConsultas } from "../throttle";
import { lerConsulta, urlConsulta } from "./consulta_parser";
import {
  DIAS_PULO_POR_MOTIVO,
  classificarResposta,
  deveAbortar,
  devePularPorRegistro,
  leituraDoResultado,
  montarEvento,
  ordenarCandidatas,
  podarPuladas,
  proximaContagemFalhas,
  type AutorOrdem,
  type Candidata,
  type Desfecho,
  type MotivoRegistro,
  type Puladas,
} from "./consultas_regras";
import { lerCursor } from "./cursor";
import { log } from "./util";

export const FONTE_CURSOR_CONSULTAS = "senado:consultas";
export const VAR_TETO_CONSULTAS = "INGEST_CONSULTAS_MAX";
export const TETO_CONSULTAS_PADRAO = 500;

export interface ResultadoConsultas {
  lidas: number;
  puladas: number;
  eventos: number;
  falhas: number;
  abortou: boolean;
  /** Mapa novo (podado + pulos desta rodada) para o chamador gravar no cursor `senado:consultas`. */
  registroPuladas: Puladas;
}

/** Ausente, vazio ou nao inteiro positivo = padrao. */
export function lerTetoConsultas(env: Readonly<Record<string, string | undefined>>): number {
  const bruto = env[VAR_TETO_CONSULTAS]?.trim();
  if (!bruto) return TETO_CONSULTAS_PADRAO;
  const n = Number(bruto);
  return Number.isSafeInteger(n) && n > 0 ? n : TETO_CONSULTAS_PADRAO;
}

interface CandidataLinha extends Candidata {
  idExterno: string;
  dataApresentacao: Date | null;
}

const CHAVE_COD = /^[1-9][0-9]*$/;

const ehMotivoRegistro = (m: unknown): m is MotivoRegistro =>
  typeof m === "string" && Object.hasOwn(DIAS_PULO_POR_MOTIVO, m);

/**
 * Chave que nao e inteiro positivo em texto e descartada (a defesa contra `__proto__` e afins e essa
 * validacao: `podarPuladas` devolve um objeto comum).
 */
function puladasDoCursor(estado: Record<string, unknown> | null): Puladas {
  const saida: Puladas = Object.create(null) as Puladas;
  const bruto = estado?.puladas;
  if (typeof bruto !== "object" || bruto === null || Array.isArray(bruto)) return saida;
  for (const [cod, r] of Object.entries(bruto as Record<string, unknown>)) {
    if (!CHAVE_COD.test(cod)) continue;
    if (typeof r !== "object" || r === null) continue;
    const { em, motivo } = r as { em?: unknown; motivo?: unknown };
    if (typeof em !== "string" || Number.isNaN(Date.parse(em))) continue;
    if (!ehMotivoRegistro(motivo)) continue;
    saida[cod] = { em, motivo };
  }
  return saida;
}

export const MAX_MSG_ERRO = 200;

/** `name: message` cortada; sem o trecho `params:` que o drizzle anexa a "Failed query". */
function descreverErro(e: unknown): string {
  const nome = e instanceof Error ? e.name : "NaoError";
  const msg = e instanceof Error ? e.message : String(e);
  const i = msg.search(/[\n ]params:/);
  return `${nome}: ${(i >= 0 ? msg.slice(0, i) : msg).slice(0, MAX_MSG_ERRO)}`;
}

/** Excecao da gravacao (`db.transaction`): conta em `falhas` mas nao vira `falha_leitura` (a leitura estava ok). */
class ErroGravacao extends Error {
  readonly causa: unknown;
  constructor(causa: unknown) {
    super("erro de gravacao");
    this.name = "ErroGravacao";
    this.causa = causa;
  }
}

/**
 * Leva o evento `consulta_publica` de cada proposicao ao formato canonico (1 por proposicao, `ocorrido_em` =
 * apresentacao) so com dado do banco, sem rede. Numa unica transacao, por proposicao divergente: upsert do
 * canonico e depois delete dos demais (prefixo exato "<proposicao>:"). Sem divergencia nao escreve nada.
 * Proposicao sem primeiro signatario e ignorada. Lanca se a transacao falhar (nada e alterado); quem chama decide.
 * Devolve quantas proposicoes foram normalizadas.
 */
export async function normalizarEventosConsulta(): Promise<number> {
  const linhasConsulta = await db
    .select({
      materiaCod: schema.consultaPublica.materiaCod,
      proposicaoId: schema.consultaPublica.proposicaoId,
      votosSim: schema.consultaPublica.votosSim,
      votosNao: schema.consultaPublica.votosNao,
      apuradoEm: schema.consultaPublica.apuradoEm,
      dataApresentacao: schema.proposicao.dataApresentacao,
    })
    .from(schema.consultaPublica)
    .innerJoin(schema.proposicao, eq(schema.proposicao.id, schema.consultaPublica.proposicaoId));
  if (linhasConsulta.length === 0) return 0;

  // consulta_publica tem PK materia_cod: a proposicao pode ter mais de uma linha; vale a de maior
  // apurado_em (empate: maior materia_cod, deterministico)
  const maisRecente = new Map<string, (typeof linhasConsulta)[number]>();
  for (const l of linhasConsulta) {
    const atual = maisRecente.get(l.proposicaoId);
    const vence =
      atual === undefined ||
      l.apuradoEm.getTime() > atual.apuradoEm.getTime() ||
      (l.apuradoEm.getTime() === atual.apuradoEm.getTime() && l.materiaCod > atual.materiaCod);
    if (vence) maisRecente.set(l.proposicaoId, l);
  }
  const consultas = [...maisRecente.values()];

  // subconsulta (nao join): varias linhas de consulta_publica nao duplicam os autores
  const autores = await db
    .select({
      proposicaoId: schema.proposicaoAutor.proposicaoId,
      parlamentarId: schema.proposicaoAutor.parlamentarId,
      ordem: schema.proposicaoAutor.ordem,
    })
    .from(schema.proposicaoAutor)
    .where(
      inArray(
        schema.proposicaoAutor.proposicaoId,
        db.select({ id: schema.consultaPublica.proposicaoId }).from(schema.consultaPublica),
      ),
    );
  const autoresPorProposicao = new Map<string, AutorOrdem[]>();
  for (const a of autores) {
    const lista = autoresPorProposicao.get(a.proposicaoId) ?? [];
    lista.push({ parlamentarId: a.parlamentarId, ordem: a.ordem });
    autoresPorProposicao.set(a.proposicaoId, lista);
  }

  const existentes = await db
    .select({
      parlamentarId: schema.evento.parlamentarId,
      refId: schema.evento.refId,
      ocorridoEm: schema.evento.ocorridoEm,
      resumo: schema.evento.resumo,
    })
    .from(schema.evento)
    .where(eq(schema.evento.tipo, "consulta_publica"));
  // chave = ref_id sem o ultimo segmento ":AAAA-MM" (comparacao exata, "senado:12" != "senado:123")
  const eventosPorProposicao = new Map<string, typeof existentes>();
  for (const e of existentes) {
    const chave = e.refId.slice(0, Math.max(0, e.refId.lastIndexOf(":")));
    const lista = eventosPorProposicao.get(chave) ?? [];
    lista.push(e);
    eventosPorProposicao.set(chave, lista);
  }

  const divergentes: NonNullable<ReturnType<typeof montarEvento>>[] = [];
  for (const c of consultas) {
    const canonico = montarEvento({
      proposicaoId: c.proposicaoId,
      autores: autoresPorProposicao.get(c.proposicaoId) ?? [],
      leitura: { cod: 0, votosSim: c.votosSim, votosNao: c.votosNao, apuradoEm: c.apuradoEm, urlFonte: "" },
      dataApresentacao: c.dataApresentacao,
    });
    if (canonico === null) continue;
    const atuais = eventosPorProposicao.get(c.proposicaoId) ?? [];
    const [unico] = atuais;
    const resumo = unico?.resumo as { votosSim?: unknown; votosNao?: unknown; apuradoEm?: unknown } | null | undefined;
    const igual =
      atuais.length === 1 &&
      unico !== undefined &&
      unico.parlamentarId === canonico.parlamentarId &&
      unico.refId === canonico.refId &&
      unico.ocorridoEm.getTime() === canonico.ocorridoEm.getTime() &&
      resumo?.votosSim === canonico.resumo.votosSim &&
      resumo?.votosNao === canonico.resumo.votosNao &&
      resumo?.apuradoEm === canonico.resumo.apuradoEm;
    if (!igual) divergentes.push(canonico);
  }
  if (divergentes.length === 0) return 0;

  await db.transaction(async (tx) => {
    for (const canonico of divergentes) {
      await tx
        .insert(schema.evento)
        .values(canonico)
        .onConflictDoUpdate({
          target: [schema.evento.parlamentarId, schema.evento.tipo, schema.evento.refId],
          set: { ocorridoEm: dsql`excluded.ocorrido_em`, resumo: dsql`excluded.resumo` },
        });
      const prefixo = canonico.refId.slice(0, canonico.refId.lastIndexOf(":") + 1);
      await tx.delete(schema.evento).where(
        and(
          eq(schema.evento.tipo, "consulta_publica"),
          dsql`starts_with(${schema.evento.refId}, ${prefixo})`,
          ne(schema.evento.refId, canonico.refId),
        ),
      );
      // o canonico pode ter o mesmo ref_id em outro parlamentar (primeiro signatario mudou): sobra apagada
      await tx
        .delete(schema.evento)
        .where(
          and(
            eq(schema.evento.tipo, "consulta_publica"),
            eq(schema.evento.refId, canonico.refId),
            ne(schema.evento.parlamentarId, canonico.parlamentarId),
          ),
        );
    }
  });
  return divergentes.length;
}

/**
 * `parcial` (opcional) e preenchido durante a rodada: se o sync lancar, quem chama ainda tem os pulos
 * e contadores ja registrados para gravar no cursor.
 */
export async function sincronizarConsultas(parcial?: { atual?: ResultadoConsultas }): Promise<ResultadoConsultas> {
  try {
    await normalizarEventosConsulta();
  } catch (e) {
    // normalizacao falhou e desfez tudo: a rodada segue (a releitura normaliza aos poucos)
    log(`consultas: normalizacao dos eventos falhou (${descreverErro(e)})`);
  }
  const agora = new Date();
  const teto = lerTetoConsultas(process.env);
  const estado = await lerCursor(FONTE_CURSOR_CONSULTAS);
  const registro = podarPuladas(puladasDoCursor(estado), agora);

  // Carrega todas as proposicoes do Senado e ordena em memoria (ok ate ~5 mil); se crescer, mover a
  // ordem (nunca lidas primeiro, apuradoEm mais antigo) para SQL com ORDER BY ... NULLS FIRST.
  const linhas = await db
    .select({
      proposicaoId: schema.proposicao.id,
      idExterno: schema.proposicao.idExterno,
      dataApresentacao: schema.proposicao.dataApresentacao,
      apuradoEm: schema.consultaPublica.apuradoEm,
    })
    .from(schema.proposicao)
    .leftJoin(schema.consultaPublica, eq(schema.consultaPublica.proposicaoId, schema.proposicao.id))
    .where(eq(schema.proposicao.casa, "senado"));

  const elegiveis: CandidataLinha[] = linhas.filter((l) => !devePularPorRegistro(registro[l.idExterno], agora));
  const selecionadas = ordenarCandidatas(elegiveis).slice(0, teto);

  const autoresPorProposicao = new Map<string, AutorOrdem[]>();
  if (selecionadas.length > 0) {
    const autores = await db
      .select({
        proposicaoId: schema.proposicaoAutor.proposicaoId,
        parlamentarId: schema.proposicaoAutor.parlamentarId,
        ordem: schema.proposicaoAutor.ordem,
      })
      .from(schema.proposicaoAutor)
      .where(
        inArray(
          schema.proposicaoAutor.proposicaoId,
          selecionadas.map((c) => c.proposicaoId),
        ),
      );
    for (const a of autores) {
      const lista = autoresPorProposicao.get(a.proposicaoId) ?? [];
      lista.push({ parlamentarId: a.parlamentarId, ordem: a.ordem });
      autoresPorProposicao.set(a.proposicaoId, lista);
    }
  }

  const throttle = criarThrottleConsultas();
  const novasPuladas: Puladas = { ...registro };
  let lidas = 0;
  let puladas = 0;
  let eventos = 0;
  let falhas = 0;
  let seguidas = 0;
  let abortou = false;

  const publicar = (): void => {
    if (!parcial) return;
    parcial.atual = { lidas, puladas, eventos, falhas, abortou, registroPuladas: novasPuladas };
  };
  publicar();

  const registrar = (cod: string, motivo: MotivoRegistro): void => {
    novasPuladas[cod] = { em: new Date().toISOString(), motivo };
  };
  const pular = (cod: string, motivo: string): Desfecho => {
    puladas++;
    log(`consultas: pulou ${cod} (${motivo})`);
    return "pulo_esperado";
  };
  const falhar = (cod: string, motivo: string): Desfecho => {
    falhas++;
    log(`consultas: falhou ${cod} (${motivo})`);
    return "falha";
  };

  for (const c of selecionadas) {
    const cod = Number(c.idExterno);
    if (!Number.isSafeInteger(cod) || cod <= 0) {
      pular(c.idExterno, "codigo invalido");
      continue;
    }
    let desfecho: Desfecho;
    try {
      await throttle.esperar();
      const resp = await buscarTexto(urlConsulta(cod));
      const cls = classificarResposta(resp);
      if (cls.acao === "pular") {
        desfecho = pular(c.idExterno, cls.motivo);
        registrar(c.idExterno, cls.motivo === "materia_inexistente" ? "materia_inexistente" : "falha_leitura");
      } else {
        const r = lerConsulta(cls.html, cod);
        if (r.tipo === "sem_dado") {
          desfecho = pular(c.idExterno, `sem_dado:${r.motivo}`);
          if (r.motivo === "encerrada") registrar(c.idExterno, "encerrada");
          else if (r.motivo === "sem_apuracao") registrar(c.idExterno, "sem_apuracao");
        } else {
          const v = leituraDoResultado(r, cod);
          if (!v.ok) {
            desfecho = falhar(c.idExterno, v.motivo);
            registrar(c.idExterno, "falha_leitura");
          } else {
            const evento = montarEvento({
              proposicaoId: c.proposicaoId,
              autores: autoresPorProposicao.get(c.proposicaoId) ?? [],
              leitura: v.leitura,
              dataApresentacao: c.dataApresentacao,
            });
            const l = v.leitura;
            const resultado = await db.transaction(async (tx) => {
              // leitura mais antiga que a gravada nao sobrescreve (setWhere) nem gera evento
              const gravadas = await tx
                .insert(schema.consultaPublica)
                .values({
                  materiaCod: String(l.cod),
                  proposicaoId: c.proposicaoId,
                  votosSim: l.votosSim,
                  votosNao: l.votosNao,
                  apuradoEm: l.apuradoEm,
                  urlFonte: l.urlFonte,
                })
                .onConflictDoUpdate({
                  target: schema.consultaPublica.materiaCod,
                  set: {
                    proposicaoId: dsql`excluded.proposicao_id`,
                    votosSim: dsql`excluded.votos_sim`,
                    votosNao: dsql`excluded.votos_nao`,
                    apuradoEm: dsql`excluded.apurado_em`,
                    urlFonte: dsql`excluded.url_fonte`,
                    atualizadoEm: dsql`now()`,
                  },
                  setWhere: dsql`${schema.consultaPublica.apuradoEm} <= excluded.apurado_em`,
                })
                .returning({ materiaCod: schema.consultaPublica.materiaCod });
              if (gravadas.length === 0 || evento === null) return { gravou: gravadas.length > 0, evento: 0 };
              // evento unico por proposicao: a releitura atualiza so o placar (ocorrido_em nunca muda)
              const gravados = await tx
                .insert(schema.evento)
                .values(evento)
                .onConflictDoUpdate({
                  target: [schema.evento.parlamentarId, schema.evento.tipo, schema.evento.refId],
                  set: { resumo: dsql`excluded.resumo` },
                })
                .returning({ id: schema.evento.id });
              // evento unico por proposicao: apaga tudo da proposicao que nao seja o canonico (outro ref_id, de
              // formato antigo, ou o mesmo ref_id de outro parlamentar); prefixo exato "<proposicao>:"
              // (starts_with, sem curinga de LIKE)
              await tx.delete(schema.evento).where(
                and(
                  eq(schema.evento.tipo, "consulta_publica"),
                  dsql`starts_with(${schema.evento.refId}, ${`${c.proposicaoId}:`})`,
                  or(ne(schema.evento.refId, evento.refId), ne(schema.evento.parlamentarId, evento.parlamentarId)),
                ),
              );
              return { gravou: true, evento: gravados.length };
            }).catch((e: unknown): never => {
              throw new ErroGravacao(e);
            });
            if (resultado.gravou) {
              lidas++;
              eventos += resultado.evento;
              desfecho = "ok";
            } else {
              desfecho = pular(c.idExterno, "leitura mais antiga que a gravada");
            }
          }
        }
      }
    } catch (e) {
      if (e instanceof ErroGravacao) {
        // erro de gravacao nao e falha de leitura: conta em falhas, sem entrar no mapa de puladas
        desfecho = falhar(c.idExterno, descreverErro(e.causa));
      } else {
        desfecho = falhar(c.idExterno, descreverErro(e));
        registrar(c.idExterno, "falha_leitura");
      }
    }
    seguidas = proximaContagemFalhas(seguidas, desfecho);
    abortou = deveAbortar(seguidas);
    publicar();
    if (abortou) {
      log(`consultas: abortou a rodada apos ${seguidas} falhas seguidas`);
      break;
    }
  }

  return { lidas, puladas, eventos, falhas, abortou, registroPuladas: novasPuladas };
}
