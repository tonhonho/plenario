// Contrato HTTP entre apps/api e apps/web. A API devolve exatamente estes formatos;
// a web importa estes tipos de "@plenario/core/api". Campos de data são ISO-8601 em UTC.

export type Casa = "camara" | "senado";

export type VotoTipo = "sim" | "nao" | "abstencao" | "obstrucao" | "art17" | "ausente" | "outro";

export interface ParlamentarResumo {
  id: string; // "camara:204379"
  casa: Casa;
  nome: string;
  partido: string | null;
  uf: string | null;
  fotoUrl: string | null;
  emExercicio: boolean;
}

export interface Parlamentar extends ParlamentarResumo {
  nomeCivil: string | null;
  email: string | null;
  urlOficial: string; // perfil na página da casa
  estatisticas: {
    // votações nominais de Plenário da casa ocorridas dentro dos períodos de `exercicio` dele
    votacoesNominais: number;
    // votos registrados (não ausente) / votacoesNominais (0–100); null se sem base
    presencaPct: number | null;
    proposicoesAutor: number;
    despesasAnoCorrente: number | null; // soma CEAP do ano, em reais; null no Senado (v1)
  };
}

export interface ProposicaoResumo {
  id: string;
  casa: Casa;
  siglaTipo: string;
  numero: number | null;
  ano: number | null;
  rotulo: string; // "PL 1234/2026"
  ementa: string | null;
  url: string | null;
}

export interface Placar {
  sim: number;
  nao: number;
  outros: number;
}

export interface VotacaoResumo {
  id: string;
  casa: Casa;
  dataHora: string;
  // no Senado é o início da Ordem do Dia da sessão: votações da mesma sessão empatam no horário
  dataHoraAproximada: boolean;
  orgao: string | null; // código da fonte: "PLEN", "CCJC"...
  descricao: string | null;
  aprovada: boolean | null;
  nominal: boolean;
  secreta: boolean; // secreta tem placar e não tem voto individual; simbólica não tem nenhum dos dois
  urlOficial: string | null; // página HTML da votação/sessão na casa
  placar: Placar | null;
  proposicao: ProposicaoResumo | null;
}

interface FeedItemBase {
  id: string; // evento.id como string
  ocorridoEm: string;
  parlamentar: ParlamentarResumo;
  // link para a página oficial que comprova o card. Nunca nulo: se não houver página do item,
  // cai na página mais específica que houver (votação → proposição → sessão; gasto → cota do deputado)
  urlFonte: string;
}

export interface FeedItemVoto extends FeedItemBase {
  tipo: "voto";
  voto: VotoTipo;
  votacao: VotacaoResumo;
  // o parlamentar votou com a maioria do próprio partido? null quando não dá pra dizer
  comOPartido: boolean | null;
}

export interface FeedItemProposicao extends FeedItemBase {
  tipo: "proposicao";
  papel: "autor" | "coautor";
  proposicao: ProposicaoResumo;
}

export interface FeedItemDespesaMensal extends FeedItemBase {
  tipo: "despesa_mensal";
  ano: number;
  mes: number;
  total: number;
  porCategoria: { categoria: string; valor: number }[]; // ordenado desc, no máx. 5
}

export interface FeedItemConsulta extends FeedItemBase {
  tipo: "consulta_publica";
  proposicao: ProposicaoResumo;
  votosSim: number;
  votosNao: number;
  apuradoEm: string; // ISO-8601 UTC
}

export type FeedItem = FeedItemVoto | FeedItemProposicao | FeedItemDespesaMensal | FeedItemConsulta;
export type FeedItemTipo = FeedItem["tipo"];

export interface Pagina<T> {
  itens: T[];
  proximo: string | null; // cursor opaco; null = fim
}

export interface VotacaoDetalhe extends VotacaoResumo {
  // outros = abstenção + obstrução + art17 + outro; ausente não entra
  porPartido: { partido: string; sim: number; nao: number; outros: number }[];
  votos: { parlamentar: ParlamentarResumo; voto: VotoTipo }[];
}

// Placar da consulta pública do e-Cidadania (Senado). Leitura de `consulta_publica`, a mais recente.
export interface ConsultaPlacar {
  votosSim: number;
  votosNao: number;
  apuradoEm: string; // ISO-8601 UTC
  urlFonte: string; // página oficial da consulta (e-Cidadania)
}

export interface ProposicaoDetalhe extends ProposicaoResumo {
  dataApresentacao: string | null;
  autores: { parlamentar: ParlamentarResumo; proponente: boolean; ordem: number | null }[];
  votacoes: VotacaoResumo[];
  // linha de `consulta_publica` com `apurado_em` mais recente; null = proposição sem consulta lida
  consulta: ConsultaPlacar | null;
}

export interface ErroApi {
  erro: string;
}

export interface Health {
  ok: true;
  versao: string;
  dadosAte: string | null;
}

export interface PartidoResumo {
  sigla: string;
  total: number;
}

// Rotas (todas GET, públicas, sem autenticação):
//
//   GET /health                          -> Health
//   GET /parlamentares?q=&casa=&partido=&uf=&cursor=&limite=   -> Pagina<ParlamentarResumo>
//        q: busca por nome sem acento (pg_trgm); limite padrão 30, máx. 100
//   GET /parlamentares?ids=id1,id2       -> Pagina<ParlamentarResumo> (até 200, na ordem pedida,
//        id inexistente é omitido; ignora os outros filtros; proximo sempre null)
//   GET /parlamentares/:id               -> Parlamentar
//   GET /parlamentares/:id/feed?tipos=&cursor=                 -> Pagina<FeedItem>
//   GET /feed?parlamentares=id1,id2&tipos=voto,proposicao&cursor=  -> Pagina<FeedItem>
//        até 200 ids; sem `parlamentares` = feed geral (todas as casas)
//        tipos: lista separada por vírgula de voto, proposicao, despesa_mensal, consulta_publica;
//        ausente = todos os tipos; valor fora da lista = 400
//   GET /votacoes/:id                    -> VotacaoDetalhe
//   GET /proposicoes/:id                 -> ProposicaoDetalhe (campo `consulta`: ConsultaPlacar | null)
//   GET /partidos                        -> PartidoResumo[]
//
// Paginação: cursor por (ocorridoEm desc, id desc), página de 30.
// Erros: status HTTP + ErroApi.
