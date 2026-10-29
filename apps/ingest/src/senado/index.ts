// Ingest do Senado Federal (Dados Abertos, https://legis.senado.leg.br/dadosabertos/).
//
// Ordem: parlamentares -> votações (+ votos e eventos "voto") -> proposições de autoria
// (+ autores e eventos "proposicao") -> consultas públicas (+ `consulta_publica` e eventos
// "consulta_publica"; lê a página do e-Cidadania, sem API). Tudo é upsert, então rodar de novo
// o mesmo período não duplica nada. Cursores em `ingest_cursor`:
//   senado:parlamentares  último sync da lista
//   senado:votacoes       { ate: AAAA-MM-DD } última data de sessão coberta
//   senado:proposicoes    { ate: AAAA-MM-DD } última data de apresentação coberta
//   senado:consultas      { puladas: {cod: {em, motivo}}, contagem: {lidas, puladas, eventos, falhas},
//                           abortou, em } rodízio por apuração (não por data): --desde/--ate NÃO
//                           afetam as consultas
// Sem --desde, votações e proposições retomam do próprio cursor com 7 dias de folga (a fonte
// publica votação e autoria com atraso de alguns dias), ou do início da 57ª legislatura.

import type { OpcoesIngest } from "../index";
import { FONTE_CURSOR_CONSULTAS, MAX_MSG_ERRO, sincronizarConsultas, type ResultadoConsultas } from "./consultas";
import { gravarCursor, lerCursor } from "./cursor";
import { completarPartidos, sincronizarParlamentares } from "./parlamentares";
import { sincronizarProposicoes } from "./proposicoes";
import { sincronizarVotacoes } from "./votacoes";
import { INICIO_LEGISLATURA, hojeBrasilia, log, maiorData, somarDias, validarData } from "./util";

const FOLGA_DIAS = 7;

async function inicio(fonte: string, opcoes: OpcoesIngest): Promise<string> {
  if (opcoes.desde) return validarData(opcoes.desde, "desde");
  const cursor = await lerCursor(fonte);
  if (!cursor?.ate) return INICIO_LEGISLATURA;
  return maiorData(INICIO_LEGISLATURA, somarDias(cursor.ate, -FOLGA_DIAS));
}

function gravarConsultas(rc: ResultadoConsultas): Promise<void> {
  return gravarCursor(FONTE_CURSOR_CONSULTAS, {
    puladas: rc.registroPuladas,
    contagem: { lidas: rc.lidas, puladas: rc.puladas, eventos: rc.eventos, falhas: rc.falhas },
    abortou: rc.abortou,
    em: new Date().toISOString(),
  });
}

/** Fontes de rede do run; injetaveis para teste (default: as reais). */
export type Fontes = {
  sincronizarParlamentares: typeof sincronizarParlamentares;
  completarPartidos: typeof completarPartidos;
  sincronizarVotacoes: typeof sincronizarVotacoes;
  sincronizarProposicoes: typeof sincronizarProposicoes;
  sincronizarConsultas: typeof sincronizarConsultas;
};

export const FONTES: Fontes = {
  sincronizarParlamentares,
  completarPartidos,
  sincronizarVotacoes,
  sincronizarProposicoes,
  sincronizarConsultas,
};

function nomeErro(e: unknown): string {
  return e instanceof Error ? e.name : "erro";
}

export async function run(opcoes: OpcoesIngest, fontes: Fontes = FONTES): Promise<void> {
  const t0 = performance.now();
  const hoje = hojeBrasilia();
  const ate = opcoes.ate ? validarData(opcoes.ate, "ate") : hoje;

  // Cada fonte roda em bloco proprio: falha de uma nao derruba as outras (so as que dependem dela).
  const erros: { fonte: string; erro: unknown }[] = [];
  const falhou = (fonte: string, erro: unknown): void => {
    erros.push({ fonte, erro });
    log(`${fonte}: FALHOU (${nomeErro(erro)}: ${(erro instanceof Error ? erro.message : String(erro)).slice(0, MAX_MSG_ERRO)})`);
  };

  let senadores: Awaited<ReturnType<typeof sincronizarParlamentares>> | undefined;
  try {
    senadores = await fontes.sincronizarParlamentares();
    await gravarCursor("senado:parlamentares", { total: senadores.size });
  } catch (e) {
    senadores = undefined;
    falhou("parlamentares", e);
  }

  if (!senadores) {
    log("votações: pulada (parlamentares falhou; o mapa de senadores não está disponível)");
    log("proposições: pulada (parlamentares falhou; o mapa de senadores não está disponível)");
  } else {
    try {
      const desdeVot = await inicio("senado:votacoes", opcoes);
      if (desdeVot <= ate) {
        log(`votações de ${desdeVot} a ${ate}`);
        const rv = await fontes.sincronizarVotacoes(desdeVot, ate, senadores);
        await fontes.completarPartidos();
        await gravarCursor("senado:votacoes", { ate });
        log(
          `votações: ${rv.votacoes} (${rv.nominais} nominais, ${rv.secretas} secretas sem voto individual), ${rv.votos} votos`,
        );
      } else {
        log(`votações: nada a fazer (desde ${desdeVot} > até ${ate})`);
      }
    } catch (e) {
      falhou("votacoes", e);
    }

    try {
      const desdeProp = await inicio("senado:proposicoes", opcoes);
      if (desdeProp <= ate) {
        log(`proposições de ${desdeProp} a ${ate}`);
        const rp = await fontes.sincronizarProposicoes(desdeProp, ate, senadores);
        await gravarCursor("senado:proposicoes", { ate });
        log(
          `proposições: ${rp.proposicoes} com ${rp.autorias} autorias` +
            (rp.semOrdem ? ` (${rp.semOrdem} sem ordem: nome não achado no texto de autoria)` : ""),
        );
      } else {
        log(`proposições: nada a fazer (desde ${desdeProp} > até ${ate})`);
      }
    } catch (e) {
      falhou("proposicoes", e);
    }
  }

  // `parcial` guarda o que o sync ja registrou: se ele lancar, os pulos da rodada nao se perdem.
  const parcial: { atual?: ResultadoConsultas } = {};
  try {
    const rc = await fontes.sincronizarConsultas(parcial);
    await gravarConsultas(rc);
    log(
      `consultas: ${rc.lidas} lidas, ${rc.puladas} puladas, ${rc.eventos} eventos gravados (criados ou atualizados)` +
        (rc.falhas ? `, ${rc.falhas} falhas` : "") +
        (rc.abortou ? " (rodada abortada: falhas seguidas)" : ""),
    );
  } catch (e) {
    if (parcial.atual) {
      try {
        await gravarConsultas(parcial.atual);
      } catch (eCursor) {
        log(`consultas: falha ao gravar o cursor parcial (${nomeErro(eCursor)})`);
      }
    }
    falhou("consultas", e);
  }

  log(`concluído em ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  if (erros.length) log(`fontes com falha: ${erros.map((x) => x.fonte).join(", ")}`);

  if (erros.length === 1) throw erros[0]!.erro;
  if (erros.length > 1) {
    throw new AggregateError(
      erros.map((x) => x.erro),
      `fontes do Senado com falha: ${erros.map((x) => x.fonte).join(", ")}`,
    );
  }
}
