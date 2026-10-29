import type { FeedItem, FeedItemTipo, FeedItemVoto, Pagina } from "@plenario/core/api";
import type { InfiniteData, UseInfiniteQueryResult } from "@tanstack/react-query";
import { useEffect, useRef, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { CardGrupoVotacao, FeedCard } from "./FeedCard";
import { Botao, CardSkeleton, Chips, EstadoErro, EstadoVazio, ListaSkeleton } from "./ui";

export type FiltroTipo = "todos" | FeedItemTipo;

export const OPCOES_TIPO: { valor: FiltroTipo; rotulo: string }[] = [
  { valor: "todos", rotulo: "Tudo" },
  { valor: "voto", rotulo: "Votos" },
  { valor: "proposicao", rotulo: "Projetos" },
  { valor: "despesa_mensal", rotulo: "Gastos" },
  { valor: "consulta_publica", rotulo: "Consultas" },
];

/** Filtro de tipo guardado na URL (?tipo=voto), para o voltar do navegador e o link funcionarem. */
export function useFiltroTipo(): [FiltroTipo, (v: FiltroTipo) => void, FeedItemTipo[] | undefined] {
  const [params, setParams] = useSearchParams();
  const bruto = params.get("tipo");
  const valor: FiltroTipo = OPCOES_TIPO.some((o) => o.valor === bruto)
    ? (bruto as FiltroTipo)
    : "todos";
  const set = (v: FiltroTipo) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (v === "todos") n.delete("tipo");
        else n.set("tipo", v);
        return n;
      },
      { replace: true, preventScrollReset: true },
    );
  return [valor, set, valor === "todos" ? undefined : [valor]];
}

export function FiltroTipoChips({ valor, onChange }: { valor: FiltroTipo; onChange: (v: FiltroTipo) => void }) {
  return <Chips rotulo="Filtrar por tipo de atividade" opcoes={OPCOES_TIPO} valor={valor} onChange={onChange} />;
}

/** Sentinela de rolagem infinita, com botão de fallback (teclado, leitor de tela, sem IO). */
export function CarregarMais({
  temMais,
  carregando,
  carregar,
}: {
  temMais: boolean;
  carregando: boolean;
  carregar: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !temMais || carregando || !("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver(
      (entradas) => {
        if (entradas.some((e) => e.isIntersecting)) carregar();
      },
      { rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [temMais, carregando, carregar]);

  if (!temMais) return null;
  return (
    <div ref={ref}>
      {carregando ? (
        <div role="status">
          <span className="sr-only">Carregando mais…</span>
          <CardSkeleton />
        </div>
      ) : (
        <div className="flex justify-center py-5">
          <Botao onClick={carregar}>Carregar mais</Botao>
        </div>
      )}
    </div>
  );
}

type Bloco = { chave: string; item: FeedItem } | { chave: string; grupo: FeedItemVoto[] };

/** Junta votos consecutivos da mesma votação num bloco só. */
function agruparVotos(itens: FeedItem[]): Bloco[] {
  const blocos: Bloco[] = [];
  for (const item of itens) {
    const ultimo = blocos[blocos.length - 1];
    if (item.tipo === "voto" && ultimo) {
      const anterior = "grupo" in ultimo ? ultimo.grupo[0] : ultimo.item;
      if (anterior?.tipo === "voto" && anterior.votacao.id === item.votacao.id) {
        if ("grupo" in ultimo) ultimo.grupo.push(item);
        else blocos[blocos.length - 1] = { chave: ultimo.chave, grupo: [anterior, item] };
        continue;
      }
    }
    blocos.push({ chave: item.id, item });
  }
  return blocos;
}

export function FeedLista({
  query,
  vazio,
}: {
  query: UseInfiniteQueryResult<InfiniteData<Pagina<FeedItem>>>;
  vazio: ReactNode;
}) {
  const { data, isPending, isError, error, refetch, hasNextPage, isFetchingNextPage, fetchNextPage } =
    query;

  if (isPending) return <ListaSkeleton n={5} />;
  if (isError && !query.isFetchNextPageError)
    return <EstadoErro erro={error} tentarDeNovo={() => void refetch()} />;

  const itens = data?.pages.flatMap((p) => p.itens) ?? [];
  if (itens.length === 0) return <>{vazio}</>;

  return (
    <>
      <div aria-label="Atividades" role="feed" aria-busy={isFetchingNextPage}>
        {agruparVotos(itens).map((b) =>
          "grupo" in b ? (
            <CardGrupoVotacao key={b.chave} itens={b.grupo} />
          ) : (
            <FeedCard key={b.chave} item={b.item} />
          ),
        )}
      </div>
      {query.isFetchNextPageError ? (
        <EstadoErro
          erro={error}
          titulo="Não foi possível carregar mais"
          tentarDeNovo={() => void fetchNextPage()}
        />
      ) : (
        <CarregarMais
          temMais={!!hasNextPage}
          carregando={isFetchingNextPage}
          carregar={() => void fetchNextPage()}
        />
      )}
      {!hasNextPage && (
        <p className="py-8 text-center text-sm text-muted">Isso é tudo por enquanto.</p>
      )}
    </>
  );
}

export function VazioFiltro() {
  return (
    <EstadoVazio titulo="Nada por aqui">Nenhuma atividade deste tipo no período.</EstadoVazio>
  );
}
