// Contrato do site estático (GitHub Pages). apps/export gera estes arquivos a partir do banco;
// apps/web os lê quando VITE_DADOS=estatico. Tudo é JSON, servido em <base>/data/.
//
// Por que este formato: não há servidor, então cada tela lê arquivos prontos. O que precisa de
// "consulta" vira trabalho do navegador sobre arquivos pequenos: busca sobre o índice de
// parlamentares (755 linhas) e feed de quem a pessoa segue = merge, no navegador, dos feeds
// paginados de cada um. Card de voto guarda só o id da votação; o resumo das votações nominais
// vem num arquivo único (votacoes.json), baixado uma vez. Sem isso cada voto repetiria a
// votação inteira e o site passaria de 400 MB.

import type {
  Parlamentar,
  ParlamentarResumo,
  ProposicaoDetalhe,
  ProposicaoResumo,
  VotacaoDetalhe,
  VotacaoResumo,
  VotoTipo,
  FeedItemTipo,
} from "./api";

export const ESTATICO_VERSAO = 1;
export const TAMANHO_PAGINA = 50;
// Feed geral (quem não segue ninguém) guarda só os N mais recentes de cada tipo.
export const LIMITE_FEED_GERAL = 6000;

export const TIPOS_FEED: FeedItemTipo[] = ["voto", "proposicao", "despesa_mensal", "consulta_publica"];

// ":" não é aceito em nome de arquivo em todo lugar (Windows, artifacts do Actions).
export function arquivoId(id: string): string {
  return id.replace(":", "-");
}

// Caminhos relativos a <base>/data/. Páginas começam em 1.
export const caminhos = {
  meta: () => "meta.json",
  parlamentares: () => "parlamentares.json",
  votacoes: () => "votacoes.json",
  parlamentar: (id: string) => `p/${arquivoId(id)}.json`,
  feed: (id: string, tipo: FeedItemTipo, pagina: number) => `feed/${arquivoId(id)}/${tipo}/${pagina}.json`,
  feedGeral: (tipo: FeedItemTipo, pagina: number) => `feed/geral/${tipo}/${pagina}.json`,
  votacao: (id: string) => `votacao/${arquivoId(id)}.json`,
  proposicao: (id: string) => `proposicao/${arquivoId(id)}.json`,
};

// meta.json
export interface Meta {
  versao: number; // ESTATICO_VERSAO
  geradoEm: string; // ISO UTC
  dadosAte: string | null; // maior ocorridoEm do feed
  tamanhoPagina: number;
}

// parlamentares.json: todos, ordenados por nome. `busca` = normalizarBusca(nome, nomeCivil).
export interface ParlamentarIndice extends ParlamentarResumo {
  busca: string;
}
export type ArquivoParlamentares = ParlamentarIndice[];

// votacoes.json: resumo de TODA votação que aparece em algum card de voto (as nominais).
export type ArquivoVotacoes = Record<string, VotacaoResumo>;

// Card compacto. O navegador remonta o FeedItem do contrato da API: `parlamentar` vem do
// índice e `votacao` de votacoes.json. Os campos têm o mesmo significado de api.ts.
interface CompactoBase {
  id: string;
  parlamentarId: string;
  ocorridoEm: string;
  urlFonte: string;
}
export interface CompactoVoto extends CompactoBase {
  tipo: "voto";
  votacaoId: string;
  voto: VotoTipo;
  comOPartido: boolean | null;
}
export interface CompactoProposicao extends CompactoBase {
  tipo: "proposicao";
  papel: "autor" | "coautor";
  proposicao: ProposicaoResumo;
}
export interface CompactoDespesa extends CompactoBase {
  tipo: "despesa_mensal";
  ano: number;
  mes: number;
  total: number;
  porCategoria: { categoria: string; valor: number }[];
}
// Números do card vêm de evento.resumo, que o ingest atualiza a cada releitura da consulta.
export interface CompactoConsulta extends CompactoBase {
  tipo: "consulta_publica";
  proposicao: ProposicaoResumo;
  votosSim: number;
  votosNao: number;
  apuradoEm: string; // ISO UTC
}
export type FeedItemCompacto = CompactoVoto | CompactoProposicao | CompactoDespesa | CompactoConsulta;

// feed/<id>/<tipo>/<n>.json e feed/geral/<tipo>/<n>.json
// Um fluxo por (parlamentar, tipo), em ordem (ocorridoEm desc, id desc). "Tudo" = merge dos
// quatro fluxos no navegador. Todo fluxo tem pelo menos a página 1, mesmo vazia (sem 404).
export interface PaginaFeed {
  itens: FeedItemCompacto[];
  proxima: number | null;
  total: number; // itens no fluxo inteiro
}

// p/<id>.json, votacao/<id>.json, proposicao/<id>.json: exatamente o que a API devolve.
export type ArquivoParlamentar = Parlamentar;
export type ArquivoVotacao = VotacaoDetalhe;
export type ArquivoProposicao = ProposicaoDetalhe;
