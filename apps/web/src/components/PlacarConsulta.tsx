import { urlFonteConsultaValida } from "@plenario/core/fonte";
import { dataHora, num } from "../lib/format";
import { FonteLink, VotoSelo } from "./ui";

export const AVISO_CONSULTA =
  "Enquete aberta no e-Cidadania: cada pessoa cadastrada vota uma vez. Não representa a população.";

export const CTA_CONSULTA = "Opine no e-Cidadania";

interface PlacarConsultaProps {
  votosSim: number;
  votosNao: number;
  apuradoEm: string;
  urlFonte: string;
  /** Classe extra do bloco do link (o card do feed usa `above-stretch`). */
  linkClassName?: string;
}

/**
 * Placar da consulta pública do e-Cidadania, compartilhado pelo card do feed e pela página da
 * proposição. Texto neutro: só os totais, sem percentual nem barra; Sim/Nao com texto e ícone.
 */
export function PlacarConsulta({
  votosSim,
  votosNao,
  apuradoEm,
  urlFonte,
  linkClassName = "",
}: PlacarConsultaProps) {
  return (
    <>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <li className="inline-flex items-center gap-1.5 tabular-nums">
          <VotoSelo voto="sim" compacto />
          <span className="font-semibold">{num(votosSim)}</span>
        </li>
        <li className="inline-flex items-center gap-1.5 tabular-nums">
          <VotoSelo voto="nao" compacto />
          <span className="font-semibold">{num(votosNao)}</span>
        </li>
      </ul>
      <p className="mt-1.5 text-sm text-muted">
        Votos apurados até <span className="tabular-nums">{dataHora(apuradoEm)}</span>
      </p>
      <p className="mt-1 text-xs leading-4 text-muted">{AVISO_CONSULTA}</p>
      {/* Mesma regra da API: no modo estático o arquivo não passa por ela, então o link só sai se a URL valer. */}
      {urlFonteConsultaValida(urlFonte) && (
        <div className={`${linkClassName} mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm`.trim()}>
          <FonteLink href={urlFonte}>
            {CTA_CONSULTA}
            <span className="sr-only"> — site do Senado</span>
          </FonteLink>
        </div>
      )}
    </>
  );
}
