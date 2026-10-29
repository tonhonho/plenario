import type {
  FeedItem,
  FeedItemConsulta,
  FeedItemDespesaMensal,
  FeedItemProposicao,
  FeedItemVoto,
  VotacaoResumo,
  VotoTipo,
} from "@plenario/core/api";
import { useState, type ReactNode } from "react";
import { idParaUrl } from "../lib/ids";
import { Link } from "react-router";
import {
  brl,
  CASA_NOME,
  categoriaDespesa,
  mesAno,
  mesCorrente,
  NOTA_PASSAGEM,
  notaQuorum,
  num,
  semPassagemAerea,
  partidoUf,
} from "../lib/format";
import { IconeDiferente, IconeIgual, IconePredio } from "./Icones";
import { PlacarConsulta } from "./PlacarConsulta";
import { Avatar, Etiqueta, FonteLink, Tempo, VotoSelo } from "./ui";

export function hrefParlamentar(id: string) {
  return `/p/${idParaUrl(id)}`;
}
export function hrefVotacao(id: string) {
  return `/votacoes/${idParaUrl(id)}`;
}
export function hrefProposicao(id: string) {
  return `/proposicoes/${idParaUrl(id)}`;
}

/**
 * Linha de resultado: "Aprovada · 312 sim, 140 não, 5 outros". Texto neutro. Se o resultado
 * contradiz a maioria simples numa PEC/PLP, explica com a nota de quórum.
 */
export function ResultadoVotacao({ v }: { v: VotacaoResumo }) {
  const resultado = v.aprovada === null ? null : v.aprovada ? "Aprovada" : "Rejeitada";
  const nota = notaQuorum(v);
  return (
    <>
      <p className="text-sm text-muted">
        {resultado && <span className="font-medium text-ink-2">{resultado}</span>}
        {resultado && v.placar && " · "}
        {v.placar && (
          <span className="tabular-nums">
            {num(v.placar.sim)} sim, {num(v.placar.nao)} não
            {v.placar.outros > 0 &&
              `, ${num(v.placar.outros)} ${v.placar.outros === 1 ? "outro" : "outros"}`}
          </span>
        )}
        {!v.placar && !v.nominal && (resultado ? " · " : "") + "votação simbólica"}
      </p>
      {nota && <p className="text-xs text-muted">{nota}</p>}
    </>
  );
}

function Cabecalho({ item }: { item: FeedItem }) {
  const p = item.parlamentar;
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-sm leading-5">
      <Link
        to={hrefParlamentar(p.id)}
        className="above-stretch truncate font-semibold text-ink hover:underline"
      >
        {p.nome}
      </Link>
      <span className="text-muted">
        {partidoUf(p)} · {CASA_NOME[p.casa]}
      </span>
      <span aria-hidden="true" className="text-muted">
        ·
      </span>
      <Tempo
        iso={item.ocorridoEm}
        soData={item.tipo === "voto" && item.votacao.dataHoraAproximada}
        className="text-muted"
      />
    </div>
  );
}

function Moldura({
  item,
  children,
  rodape,
}: {
  item: FeedItem;
  children: ReactNode;
  rodape?: ReactNode;
}) {
  return (
    <article className="relative flex gap-3 border-b border-line px-4 py-3.5 transition-colors has-[.stretched:hover]:bg-sunken/60 has-[.stretched:focus-visible]:bg-sunken/60">
      <Link
        to={hrefParlamentar(item.parlamentar.id)}
        className="above-stretch shrink-0 self-start rounded-full"
        tabIndex={-1}
        aria-hidden="true"
      >
        <Avatar p={item.parlamentar} />
      </Link>
      <div className="min-w-0 flex-1">
        <Cabecalho item={item} />
        <div className="mt-1">{children}</div>
        {rodape && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">{rodape}</div>
        )}
      </div>
    </article>
  );
}

function fraseVoto(voto: VotoTipo): ReactNode {
  switch (voto) {
    case "sim":
    case "nao":
    case "obstrucao":
    case "outro":
      return (
        <>
          votou <VotoSelo voto={voto} /> em
        </>
      );
    case "abstencao":
      return (
        <>
          registrou <VotoSelo voto={voto} /> em
        </>
      );
    case "art17":
      return (
        <>
          presidia a sessão e não votou (<VotoSelo voto={voto} />) em
        </>
      );
    case "ausente":
      return (
        <>
          não registrou voto (<VotoSelo voto={voto} />) em
        </>
      );
  }
}

function CardVoto({ item }: { item: FeedItemVoto }) {
  const v = item.votacao;
  const alvo = v.proposicao?.rotulo ?? v.descricao ?? "votação nominal";
  const ementa = v.proposicao?.ementa;
  return (
    <Moldura
      item={item}
      rodape={
        <>
          {item.comOPartido !== null && (
            <Etiqueta title="Comparação do voto com o que a maioria do partido votou nesta votação">
              {item.comOPartido ? <IconeIgual tamanho={13} /> : <IconeDiferente tamanho={13} />}
              {item.comOPartido ? "Votou com o partido" : "Votou diferente do partido"}
            </Etiqueta>
          )}
          <FonteLink href={item.urlFonte} className="above-stretch" />
        </>
      }
    >
      <p className="text-[15px] leading-6 text-ink">
        {fraseVoto(item.voto)}{" "}
        <Link to={hrefVotacao(v.id)} className="stretched font-semibold hover:underline">
          {alvo}
        </Link>
      </p>
      {v.proposicao && v.descricao && (
        <p className="mt-0.5 text-sm text-ink-2">{v.descricao}</p>
      )}
      {ementa && <p className="mt-1 line-clamp-3 text-sm leading-5 text-muted">{ementa}</p>}
      <div className="mt-1.5">
        <ResultadoVotacao v={v} />
      </div>
    </Moldura>
  );
}

function CardProposicao({ item }: { item: FeedItemProposicao }) {
  const pr = item.proposicao;
  return (
    <Moldura item={item} rodape={<FonteLink href={item.urlFonte} className="above-stretch" />}>
      <p className="text-[15px] leading-6 text-ink">
        {item.papel === "autor" ? "apresentou " : "assinou como coautor(a) "}
        <Link to={hrefProposicao(pr.id)} className="stretched font-semibold hover:underline">
          {pr.rotulo}
        </Link>
      </p>
      {pr.ementa && <p className="mt-1 line-clamp-4 text-sm leading-5 text-ink-2">{pr.ementa}</p>}
    </Moldura>
  );
}

function CardDespesa({ item }: { item: FeedItemDespesaMensal }) {
  const max = item.porCategoria[0]?.valor ?? 0;
  return (
    <Moldura item={item} rodape={<FonteLink href={item.urlFonte} className="above-stretch" />}>
      <p className="text-[15px] leading-6 text-ink">
        gastou{" "}
        <Link
          to={`${hrefParlamentar(item.parlamentar.id)}?tipo=despesa_mensal`}
          className="stretched font-semibold tabular-nums hover:underline"
        >
          {brl(item.total)}
        </Link>{" "}
        da cota parlamentar em {mesAno(item.mes, item.ano)}
        {mesCorrente(item.mes, item.ano) && (
          <span className="text-muted"> (mês em andamento, valor parcial)</span>
        )}
      </p>
      {item.porCategoria.length > 0 && (
        <ul className="mt-2 space-y-1.5" aria-label="Maiores categorias de gasto">
          {item.porCategoria.map((c) => (
            <li key={c.categoria} className="text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-ink-2" title={categoriaDespesa(c.categoria)}>
                  {categoriaDespesa(c.categoria)}
                </span>
                <span className="shrink-0 tabular-nums text-muted">{brl(c.valor)}</span>
              </div>
              <span
                aria-hidden="true"
                className="mt-0.5 block h-1 rounded-full bg-line-strong"
                style={{ width: `${max ? Math.max(2, (c.valor / max) * 100) : 0}%` }}
              />
            </li>
          ))}
        </ul>
      )}
      {semPassagemAerea(item.parlamentar.casa, item.ano, item.mes) && (
        <p className="mt-2 text-xs leading-4 text-muted">{NOTA_PASSAGEM}</p>
      )}
    </Moldura>
  );
}

export function FeedCard({ item }: { item: FeedItem }) {
  switch (item.tipo) {
    case "voto":
      return <CardVoto item={item} />;
    case "proposicao":
      return <CardProposicao item={item} />;
    case "despesa_mensal":
      return <CardDespesa item={item} />;
    case "consulta_publica":
      return <CardConsulta item={item} />;
  }
}

/** Classe do `<article>` dos cards "prédio" (consulta pública e votação agrupada). */
const CLASSE_CARD_PREDIO =
  "relative flex gap-3 border-b border-line px-4 py-3.5 transition-colors has-[.stretched:hover]:bg-sunken/60 has-[.stretched:focus-visible]:bg-sunken/60";

/**
 * Consulta pública do e-Cidadania (Senado): quem votou foi o público, então o card é do tipo
 * "prédio", com o autor citado no corpo. Texto neutro: só os totais, sem percentual nem barra.
 */
function CardConsulta({ item }: { item: FeedItemConsulta }) {
  const pr = item.proposicao;
  const p = item.parlamentar;
  return (
    <article className={CLASSE_CARD_PREDIO}>
      <span
        aria-hidden="true"
        className="grid size-11 shrink-0 place-items-center self-start rounded-full border border-line bg-sunken text-muted"
      >
        <IconePredio tamanho={20} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-5 text-muted">
          Consulta pública · {CASA_NOME[pr.casa]} · <Tempo iso={item.ocorridoEm} />
        </p>
        <p className="mt-1 text-[15px] leading-6 text-ink">
          <Link to={hrefProposicao(pr.id)} className="stretched font-semibold hover:underline">
            {pr.rotulo}
          </Link>{" "}
          — de{" "}
          <Link
            to={hrefParlamentar(p.id)}
            className="above-stretch font-medium text-ink-2 hover:underline"
          >
            {p.nome}
          </Link>{" "}
          ({partidoUf(p)})
        </p>
        {pr.ementa && <p className="mt-1 line-clamp-3 text-sm leading-5 text-ink-2">{pr.ementa}</p>}
        <PlacarConsulta
          votosSim={item.votosSim}
          votosNao={item.votosNao}
          apuradoEm={item.apuradoEm}
          urlFonte={item.urlFonte}
          linkClassName="above-stretch"
        />
      </div>
    </article>
  );
}

const VISIVEIS_GRUPO = 6;

/**
 * Votos consecutivos na mesma votação viram um card só (o feed geral teria centenas
 * de cards iguais seguidos). Cada voto continua listado, com nome, partido e selo.
 */
export function CardGrupoVotacao({ itens }: { itens: FeedItemVoto[] }) {
  const [aberto, setAberto] = useState(false);
  const v = itens[0]!.votacao;
  const alvo = v.proposicao?.rotulo ?? v.descricao ?? "votação nominal";
  const mostrados = aberto ? itens : itens.slice(0, VISIVEIS_GRUPO);
  const ocultos = itens.length - mostrados.length;
  return (
    <article className={CLASSE_CARD_PREDIO}>
      <span
        aria-hidden="true"
        className="grid size-11 shrink-0 place-items-center self-start rounded-full border border-line bg-sunken text-muted"
      >
        <IconePredio tamanho={20} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-5 text-muted">
          Votação nominal · {CASA_NOME[v.casa]} ·{" "}
          <Tempo iso={itens[0]!.ocorridoEm} soData={v.dataHoraAproximada} />
        </p>
        <p className="mt-1 text-[15px] leading-6 text-ink">
          {itens.length} parlamentares votaram em{" "}
          <Link to={hrefVotacao(v.id)} className="stretched font-semibold hover:underline">
            {alvo}
          </Link>
        </p>
        {v.proposicao && v.descricao && <p className="mt-0.5 text-sm text-ink-2">{v.descricao}</p>}
        {v.proposicao?.ementa && (
          <p className="mt-1 line-clamp-3 text-sm leading-5 text-muted">{v.proposicao.ementa}</p>
        )}
        <div className="mt-1.5">
          <ResultadoVotacao v={v} />
        </div>
        <ul className="above-stretch mt-3 divide-y divide-line rounded-lg border border-line bg-surface">
          {mostrados.map((it) => (
            <li key={it.id} className="flex items-center gap-2.5 px-3 py-2">
              <Avatar p={it.parlamentar} tamanho="sm" />
              <div className="min-w-0 flex-1 leading-5">
                <Link
                  to={hrefParlamentar(it.parlamentar.id)}
                  className="block truncate text-sm font-semibold hover:underline"
                >
                  {it.parlamentar.nome}
                </Link>
                <p className="truncate text-xs text-muted">
                  {partidoUf(it.parlamentar)}
                  {it.comOPartido !== null &&
                    (it.comOPartido ? " · votou com o partido" : " · votou diferente do partido")}
                </p>
              </div>
              <VotoSelo voto={it.voto} compacto />
            </li>
          ))}
        </ul>
        <div className="above-stretch mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
          {ocultos > 0 && (
            <button
              type="button"
              onClick={() => setAberto(true)}
              className="font-medium text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
            >
              Mostrar mais {ocultos}
            </button>
          )}
          <FonteLink href={itens[0]!.urlFonte} />
        </div>
      </div>
    </article>
  );
}
