import { Link, useParams } from "react-router";
import { idDaUrl } from "../lib/ids";
import { useProposicao } from "../api/queries";
import { hrefVotacao, ResultadoVotacao } from "../components/FeedCard";
import { Topo } from "../components/Layout";
import { ParlamentarLinha } from "../components/ParlamentarLinha";
import { PlacarConsulta } from "../components/PlacarConsulta";
import { EstadoErro, EstadoVazio, Etiqueta, FonteLink, Linha, Orgao, SeguirBotao } from "../components/ui";
import { CASA_NOME, dataExtenso, quandoVotacao } from "../lib/format";

function Skeleton() {
  return (
    <div className="px-4 py-5" role="status">
      <span className="sr-only">Carregando…</span>
      <div className="space-y-3" aria-hidden="true">
        <Linha className="w-1/4" />
        <Linha className="h-6 w-1/2" />
        <Linha className="w-full" />
        <Linha className="w-full" />
        <Linha className="w-3/5" />
      </div>
    </div>
  );
}

export function Proposicao() {
  const id = idDaUrl(useParams().id);
  const q = useProposicao(id);

  if (q.isPending)
    return (
      <>
        <Topo titulo="Proposição" voltar />
        <Skeleton />
      </>
    );
  if (q.isError)
    return (
      <>
        <Topo titulo="Proposição" voltar />
        <EstadoErro erro={q.error} tentarDeNovo={() => void q.refetch()} />
      </>
    );

  const p = q.data;
  const autores = [...p.autores].sort(
    (a, b) =>
      Number(b.proponente) - Number(a.proponente) || (a.ordem ?? 9999) - (b.ordem ?? 9999),
  );
  const votacoes = [...p.votacoes].sort((a, b) => (a.dataHora < b.dataHora ? 1 : -1));

  return (
    <>
      <title>{`${p.rotulo} · Plenário`}</title>
      <Topo titulo="Proposição" voltar />
      <article>
        <section className="border-b border-line px-4 py-5">
          <p className="text-sm text-muted">
            {CASA_NOME[p.casa]}
            {p.dataApresentacao && (
              <>
                {" · apresentada em "}
                <time dateTime={p.dataApresentacao}>{dataExtenso(p.dataApresentacao)}</time>
              </>
            )}
          </p>
          <h2 className="mt-1 font-serif text-2xl font-semibold leading-tight tracking-tight">{p.rotulo}</h2>
          {p.ementa ? (
            <p className="mt-3 text-base leading-7 text-ink">{p.ementa}</p>
          ) : (
            <p className="mt-3 text-sm text-muted">Ementa não informada pela fonte.</p>
          )}
          {p.url && (
            <p className="mt-4 text-sm">
              <FonteLink href={p.url}>Ver na página oficial (texto, tramitação)</FonteLink>
            </p>
          )}
        </section>

        {p.consulta && (
          <section aria-labelledby="consulta" className="border-b border-line px-4 py-5">
            <h2 id="consulta" className="text-base font-semibold">
              Consulta pública
            </h2>
            <PlacarConsulta
              votosSim={p.consulta.votosSim}
              votosNao={p.consulta.votosNao}
              apuradoEm={p.consulta.apuradoEm}
              urlFonte={p.consulta.urlFonte}
            />
          </section>
        )}

        <section aria-labelledby="autores" className="border-b border-line">
          <h2 id="autores" className="px-4 pt-5 pb-2 text-base font-semibold">
            Autoria
          </h2>
          {autores.length === 0 ? (
            <EstadoVazio titulo="Sem autor parlamentar">
              A autoria pode ser de outro poder, comissão ou órgão; veja a página oficial.
            </EstadoVazio>
          ) : (
            <ul className="border-t border-line">
              {autores.map((a) => (
                <ParlamentarLinha
                  key={a.parlamentar.id}
                  p={a.parlamentar}
                  acao={
                    <div className="flex items-center gap-2">
                      <span className="hidden sm:inline">
                        <Etiqueta>{a.proponente ? "Autor(a)" : "Coautor(a)"}</Etiqueta>
                      </span>
                      <SeguirBotao id={a.parlamentar.id} nome={a.parlamentar.nome} tamanho="sm" />
                    </div>
                  }
                />
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="votacoes">
          <h2 id="votacoes" className="px-4 pt-5 pb-2 text-base font-semibold">
            Votações
          </h2>
          {votacoes.length === 0 ? (
            <EstadoVazio titulo="Nenhuma votação registrada">
              Pode não ter sido votada ainda; a tramitação completa está na página oficial.
            </EstadoVazio>
          ) : (
            <ul className="border-t border-line">
              {votacoes.map((v) => (
                <li key={v.id} className="relative border-b border-line px-4 py-3 has-[.stretched:hover]:bg-sunken/60 has-[.stretched:focus-visible]:bg-sunken/60">
                  <p className="text-sm text-muted">
                    <time dateTime={v.dataHora}>{quandoVotacao(v)}</time>
                    {v.orgao && (
                      <>
                        {" · "}
                        <Orgao codigo={v.orgao} />
                      </>
                    )}
                    {" · "}
                    {v.secreta ? "secreta" : v.nominal ? "nominal" : "simbólica"}
                  </p>
                  <Link to={hrefVotacao(v.id)} className="stretched mt-0.5 block font-semibold hover:underline">
                    {v.descricao ?? "Votação nominal"}
                  </Link>
                  <div className="mt-1">
                    <ResultadoVotacao v={v} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </article>
    </>
  );
}
