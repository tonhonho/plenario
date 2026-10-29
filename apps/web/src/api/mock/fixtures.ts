import type {
  Casa,
  FeedItem,
  Parlamentar,
  ParlamentarResumo,
  ProposicaoDetalhe,
  ProposicaoResumo,
  VotacaoDetalhe,
  VotacaoResumo,
  VotoTipo,
} from "@plenario/core/api";

// Fixtures FICTÍCIAS, tipadas pelo contrato, para desenvolver o front sem a API.
// Nomes, partidos (siglas PX*) e votos são inventados; geração determinística
// (mesma semente, mesmos dados) com datas relativas a "agora".

let semente = 20260201;
function aleatorio(): number {
  // mulberry32
  semente |= 0;
  semente = (semente + 0x6d2b79f5) | 0;
  let t = Math.imul(semente ^ (semente >>> 15), 1 | semente);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function escolher<T>(lista: readonly T[]): T {
  return lista[Math.floor(aleatorio() * lista.length)] as T;
}
function inteiro(min: number, max: number): number {
  return min + Math.floor(aleatorio() * (max - min + 1));
}

const PRIMEIROS = [
  "Ana", "Bruno", "Carla", "Daniel", "Elisa", "Fábio", "Gabriela", "Heitor", "Iara", "João",
  "Karina", "Luís", "Marta", "Nelson", "Olívia", "Paulo", "Quitéria", "Rafael", "Sônia", "Tiago",
  "Úrsula", "Vânia", "Wagner", "Yasmin", "Zeca", "Beatriz", "Caio", "Débora", "Emílio", "Fernanda",
  "Gustavo", "Helena", "Igor", "Joana", "Lúcia", "Marcos", "Nádia", "Otávio", "Patrícia", "Renato",
];
const SOBRENOMES = [
  "Albuquerque", "Barbosa", "Cardoso", "Duarte", "Esteves", "Figueiredo", "Guimarães", "Holanda",
  "Itaboraí", "Junqueira", "Lacerda", "Machado", "Nogueira", "Oliveira", "Prado", "Queiroz",
  "Rezende", "Siqueira", "Teixeira", "Uchôa", "Vasconcelos", "Xavier", "Zanetti", "Bittencourt",
];
const PARTIDOS = ["PXA", "PXB", "PXC", "PXD", "PXE", "PXF"] as const;
const UFS = ["SP", "RJ", "MG", "BA", "RS", "PR", "PE", "CE", "PA", "GO", "AM", "SC", "DF", "MA", "PB"];

const CATEGORIAS = [
  "Divulgação da atividade parlamentar",
  "Passagem aérea",
  "Locação ou fretamento de veículos",
  "Manutenção de escritório de apoio",
  "Combustíveis e lubrificantes",
  "Consultorias, pesquisas e trabalhos técnicos",
  "Telefonia",
  "Hospedagem",
];

const EMENTAS = [
  "Altera a Lei nº 9.394, de 20 de dezembro de 1996, para dispor sobre a oferta de educação em tempo integral nas escolas públicas de ensino fundamental.",
  "Dispõe sobre a transparência na divulgação de tarifas de serviços públicos concedidos e dá outras providências.",
  "Institui o Dia Nacional de Conscientização sobre Doenças Raras.",
  "Altera o Código de Trânsito Brasileiro para tratar da renovação da Carteira Nacional de Habilitação por meio eletrônico.",
  "Estabelece normas gerais para a gestão de resíduos sólidos em municípios com até cinquenta mil habitantes.",
  "Dispõe sobre a obrigatoriedade de informação nutricional simplificada na parte frontal das embalagens de alimentos.",
  "Altera a Consolidação das Leis do Trabalho para dispor sobre o trabalho em regime de teletrabalho.",
  "Cria o Programa Nacional de Apoio à Agricultura Familiar em regiões semiáridas.",
  "Dispõe sobre o compartilhamento de dados entre órgãos públicos para fins de políticas de saúde, observada a Lei Geral de Proteção de Dados Pessoais.",
  "Aprova o texto do Acordo de Cooperação em Ciência, Tecnologia e Inovação firmado entre a República Federativa do Brasil e outro Estado.",
  "Altera a Lei de Licitações e Contratos Administrativos para dispor sobre critérios de sustentabilidade nas compras públicas.",
  "Dispõe sobre a acessibilidade em sítios eletrônicos de órgãos e entidades da administração pública.",
  "Acrescenta dispositivo à Constituição Federal para tratar do financiamento do transporte público coletivo.",
  "Dispõe sobre a prevenção de enchentes e a drenagem urbana sustentável.",
  "Institui a Política Nacional de Cuidados para pessoas idosas e com deficiência.",
  "Altera o Estatuto da Criança e do Adolescente para dispor sobre a proteção de crianças em ambientes digitais.",
  "Regulamenta o exercício da profissão de cuidador de pessoa idosa.",
  "Dispõe sobre a renegociação de dívidas rurais de pequenos produtores.",
];

const DESCRICOES = [
  "Votação do projeto, ressalvados os destaques.",
  "Requerimento de urgência para apreciação da matéria.",
  "Emenda de Plenário nº 3.",
  "Destaque para votação em separado do art. 4º.",
  "Votação em primeiro turno.",
  "Requerimento de retirada de pauta.",
];

const AGORA = Date.now();
const DIA = 86_400_000;
function diasAtras(d: number, horas = 15): string {
  const t = new Date(AGORA - d * DIA);
  t.setUTCHours(horas, inteiro(0, 59), 0, 0);
  // nada no futuro: o "hoje" das fixtures é no máximo uma hora atrás
  return new Date(Math.min(t.getTime(), AGORA - 3_600_000)).toISOString();
}

// ---- parlamentares ----

export const parlamentares: Parlamentar[] = [];
const usados = new Set<string>();
for (let i = 0; i < 42; i++) {
  const casa: Casa = i < 32 ? "camara" : "senado";
  let nome = "";
  do {
    nome = `${escolher(PRIMEIROS)} ${escolher(SOBRENOMES)}`;
  } while (usados.has(nome));
  usados.add(nome);
  const idFonte = casa === "camara" ? String(204000 + i * 7) : String(5000 + i * 3);
  const emExercicio = aleatorio() > 0.08;
  parlamentares.push({
    id: `${casa}:${idFonte}`,
    casa,
    nome,
    partido: i === 7 ? null : escolher(PARTIDOS),
    uf: escolher(UFS),
    fotoUrl: null,
    emExercicio,
    nomeCivil: `${nome} ${escolher(SOBRENOMES)}`,
    email: casa === "camara" ? `dep.exemplo${i}@example.org` : null,
    urlOficial: `https://example.org/${casa}/parlamentar/${idFonte}`,
    estatisticas: {
      votacoesNominais: 0,
      presencaPct: null,
      proposicoesAutor: 0,
      despesasAnoCorrente: casa === "camara" ? 0 : null,
    },
  });
}

export function resumo(p: Parlamentar) {
  const { id, casa, nome, partido, uf, fotoUrl, emExercicio } = p;
  return { id, casa, nome, partido, uf, fotoUrl, emExercicio };
}

// ---- proposições ----

export const proposicoes: ProposicaoDetalhe[] = [];
const SIGLAS = ["PL", "PL", "PL", "PLP", "PEC", "PDL"] as const;
EMENTAS.forEach((ementa, i) => {
  const casa: Casa = i % 4 === 3 ? "senado" : "camara";
  const daCasa = parlamentares.filter((p) => p.casa === casa);
  const siglaTipo = ementa.startsWith("Aprova o texto") ? "PDL" : escolher(SIGLAS);
  const numero = inteiro(100, 4999);
  const ano = 2026;
  const n = inteiro(1, 4);
  const autores = Array.from(new Set(Array.from({ length: n }, () => escolher(daCasa)))).map(
    (p, ordem) => ({ parlamentar: resumo(p), proponente: ordem === 0, ordem: ordem + 1 }),
  );
  proposicoes.push({
    id: `${casa}:${3000000 + i * 13}`,
    casa,
    siglaTipo,
    numero,
    ano,
    rotulo: `${siglaTipo} ${numero}/${ano}`,
    ementa,
    url: `https://example.org/${casa}/proposicao/${3000000 + i * 13}`,
    dataApresentacao: diasAtras(inteiro(1, 75), 13),
    autores,
    votacoes: [],
    consulta: null,
  });
});

export function proposicaoResumo(p: ProposicaoDetalhe): ProposicaoResumo {
  const { id, casa, siglaTipo, numero, ano, rotulo, ementa, url } = p;
  return { id, casa, siglaTipo, numero, ano, rotulo, ementa, url };
}

// ---- votações ----

export const votacoes: VotacaoDetalhe[] = [];

interface OpcoesVotacao {
  secreta?: boolean; // placar público, sem voto individual
  simbolica?: boolean; // sem placar e sem voto individual
  aprovada?: boolean | null; // força o resultado (ex.: PLP rejeitado por falta de quórum)
  orgao?: string;
}

function criarVotacao(i: number, prop: ProposicaoDetalhe, o: OpcoesVotacao = {}) {
  const casa = prop.casa;
  const daCasa = parlamentares.filter((p) => p.casa === casa);
  // tendência por partido nesta votação, para que "com o partido" faça sentido
  const tendencia = new Map<string, number>(PARTIDOS.map((s) => [s, aleatorio()]));
  const votos: { parlamentar: ReturnType<typeof resumo>; voto: VotoTipo }[] = daCasa.map((p) => {
    const r = aleatorio();
    let voto: VotoTipo;
    if (!p.emExercicio || r < 0.07) voto = "ausente";
    else if (r < 0.1) voto = "abstencao";
    else if (r < 0.115) voto = "obstrucao";
    else {
      const t = tendencia.get(p.partido ?? "") ?? 0.5;
      voto = aleatorio() < 0.15 ? (t > 0.5 ? "nao" : "sim") : t > 0.5 ? "sim" : "nao";
    }
    return { parlamentar: resumo(p), voto };
  });
  if (i === 2) votos[0] = { ...votos[0]!, voto: "art17" };
  const sim = votos.filter((v) => v.voto === "sim").length;
  const nao = votos.filter((v) => v.voto === "nao").length;
  const outros = votos.filter((v) => v.voto !== "sim" && v.voto !== "nao" && v.voto !== "ausente")
    .length;
  const porPartidoMapa = new Map<string, { sim: number; nao: number; outros: number }>();
  for (const v of votos) {
    if (v.voto === "ausente") continue;
    const k = v.parlamentar.partido ?? "Sem partido";
    const atual = porPartidoMapa.get(k) ?? { sim: 0, nao: 0, outros: 0 };
    if (v.voto === "sim") atual.sim++;
    else if (v.voto === "nao") atual.nao++;
    else atual.outros++;
    porPartidoMapa.set(k, atual);
  }
  const id = `${casa}:${2400000 + votacoes.length * 31}-${inteiro(10, 99)}`;
  // Senado: a fonte só dá o início da Ordem do Dia da sessão (14h de Brasília)
  const aproximada = casa === "senado";
  const individual = !o.secreta && !o.simbolica;
  const vot: VotacaoDetalhe = {
    id,
    casa,
    dataHora: diasAtras(i * 3 + inteiro(0, 2), aproximada ? 17 : inteiro(14, 22)),
    dataHoraAproximada: aproximada,
    orgao: o.orgao ?? "PLEN",
    descricao: o.simbolica ? "Aprovado em votação simbólica." : escolher(DESCRICOES),
    aprovada: o.aprovada !== undefined ? o.aprovada : i === 5 ? null : sim > nao,
    nominal: !o.simbolica,
    secreta: !!o.secreta,
    urlOficial: i === 7 ? null : `https://example.org/${casa}/votacao/${id.split(":")[1]}`,
    placar: o.simbolica ? null : { sim, nao, outros },
    proposicao: i === 9 ? null : proposicaoResumo(prop),
    porPartido: individual
      ? [...porPartidoMapa.entries()]
          .map(([partido, c]) => ({ partido, ...c }))
          .sort((a, b) => a.partido.localeCompare(b.partido))
      : [],
    votos: individual ? votos : [],
  };
  votacoes.push(vot);
  if (vot.proposicao) prop.votacoes.push(votacaoResumo(vot));
}

for (let i = 0; i < 16; i++) criarVotacao(i, proposicoes[i % proposicoes.length]!);

// casos especiais do contrato: secreta (Senado), simbólica, e PLP rejeitado com maioria simples
const propSenado = proposicoes.find((p) => p.casa === "senado")!;
criarVotacao(16, propSenado, { secreta: true, aprovada: true });
criarVotacao(17, proposicoes[1]!, { simbolica: true, aprovada: true, orgao: "CCJC" });
const plp: ProposicaoDetalhe = {
  ...proposicoes[0]!,
  id: "camara:3999001",
  siglaTipo: "PLP",
  numero: 281,
  ano: 2019,
  rotulo: "PLP 281/2019",
  ementa:
    "Dispõe sobre os regimes de resolução das instituições autorizadas a funcionar pelo Banco Central do Brasil.",
  url: "https://example.org/camara/proposicao/3999001",
  votacoes: [],
};
proposicoes.push(plp);
criarVotacao(1, plp, { aprovada: false });
const ultimaPlp = votacoes[votacoes.length - 1]!;
if (ultimaPlp.placar && ultimaPlp.placar.sim <= ultimaPlp.placar.nao) {
  // garante a contradição com a maioria simples, que é o caso que a nota de quórum explica
  ultimaPlp.placar = { ...ultimaPlp.placar, sim: ultimaPlp.placar.nao + 3 };
  plp.votacoes[0] = votacaoResumo(ultimaPlp);
}

export function votacaoResumo(v: VotacaoDetalhe): VotacaoResumo {
  const { porPartido: _p, votos: _v, ...resumoVotacao } = v;
  return resumoVotacao;
}

// ---- feed materializado ----

export const feed: FeedItem[] = [];
let seq = 1;

for (const v of votacoes) {
  const maioria = new Map<string, VotoTipo | null>();
  for (const pp of v.porPartido) {
    maioria.set(pp.partido, pp.sim > pp.nao ? "sim" : pp.nao > pp.sim ? "nao" : null);
  }
  for (const voto of v.votos) {
    const m = voto.parlamentar.partido ? maioria.get(voto.parlamentar.partido) : null;
    const comOPartido =
      m && (voto.voto === "sim" || voto.voto === "nao") ? voto.voto === m : null;
    feed.push({
      id: String(seq++),
      tipo: "voto",
      ocorridoEm: v.dataHora,
      parlamentar: voto.parlamentar,
      voto: voto.voto,
      votacao: votacaoResumo(v),
      comOPartido,
      urlFonte: v.urlOficial ?? v.proposicao?.url ?? `https://example.org/${v.casa}/sessao`,
    });
  }
}

for (const p of proposicoes) {
  for (const a of p.autores) {
    feed.push({
      id: String(seq++),
      tipo: "proposicao",
      ocorridoEm: p.dataApresentacao!,
      parlamentar: a.parlamentar,
      papel: a.proponente ? "autor" : "coautor",
      proposicao: proposicaoResumo(p),
      urlFonte: p.url ?? `https://example.org/${p.casa}/proposicoes`,
    });
  }
}

const hoje = new Date(AGORA);
for (const p of parlamentares.filter((x) => x.casa === "camara")) {
  for (let k = 1; k <= 3; k++) {
    const ref = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - k + 1, 0, 15));
    const cats = [...CATEGORIAS]
      .sort(() => aleatorio() - 0.5)
      .slice(0, inteiro(2, 5))
      .map((categoria) => ({ categoria, valor: Math.round(aleatorio() * 1800000) / 100 }))
      .sort((a, b) => b.valor - a.valor);
    const total = Math.round(cats.reduce((s, c) => s + c.valor, 0) * 100) / 100;
    feed.push({
      id: String(seq++),
      tipo: "despesa_mensal",
      // o mês fecha no último dia; o evento aparece alguns dias depois, quando a Câmara publica
      ocorridoEm: new Date(ref.getTime() + 5 * DIA).toISOString(),
      parlamentar: resumo(p),
      urlFonte: `https://example.org/camara/deputado/${p.id.split(":")[1]}/cota`,
      ano: ref.getUTCFullYear(),
      mes: ref.getUTCMonth() + 1,
      total,
      porCategoria: cats,
    });
  }
}

// ---- consultas públicas (e-Cidadania) ----
// Sem sorteio: não desloca a semente dos dados acima. Proposições do Senado; o autor é o proponente.
// Enquete aberta (cada pessoa cadastrada vota uma vez): o mock só traz os totais, sem juízo.
const senado = proposicoes.filter((p) => p.casa === "senado");
const instanteConsulta = (diasAtras: number): string =>
  new Date(AGORA - diasAtras * DIA - 3_600_000).toISOString();
// Falha com mensagem clara se a semente/ordem dos dados mudar (sem `!` solto).
function senadoEm(i: number): ProposicaoDetalhe {
  const p = senado[i];
  if (!p) throw new Error(`fixtures de consulta: proposicao do Senado #${i} ausente`);
  return p;
}
const proponente = (p: ProposicaoDetalhe): ParlamentarResumo => {
  const autor = p.autores[0];
  if (!autor) throw new Error(`fixtures de consulta: proposicao ${p.rotulo} sem autor`);
  return autor.parlamentar;
};
const comAutor = (
  base: ProposicaoDetalhe,
  id: string,
  numero: number,
  autor: ParlamentarResumo,
): ProposicaoDetalhe => ({
  ...base,
  id,
  numero,
  rotulo: `${base.siglaTipo} ${numero}/${base.ano}`,
  url: `https://example.org/senado/proposicao/${id.split(":")[1]}`,
  autores: [{ parlamentar: autor, proponente: true, ordem: 1 }],
});

const autorDoPerfil = proponente(senadoEm(3));
const consultas: { prop: ProposicaoDetalhe; dias: number; sim: number; nao: number; urlInvalida?: true }[] = [
  { prop: senadoEm(0), dias: 4, sim: 412876, nao: 198043 }, // números grandes (overflow e pt-BR)
  { prop: senadoEm(1), dias: 9, sim: 37, nao: 12, urlInvalida: true }, // números pequenos; url http: = placar sem link
  { prop: senadoEm(2), dias: 20, sim: 0, nao: 58 }, // zero no Sim
  // dois do mesmo autor, para o filtro "Consultas" no Perfil
  { prop: comAutor(senadoEm(3), "senado:3900101", 1101, autorDoPerfil), dias: 2, sim: 5120, nao: 1877 },
  { prop: comAutor(senadoEm(3), "senado:3900102", 1102, autorDoPerfil), dias: 13, sim: 301, nao: 0 },
];
for (const c of consultas) {
  const apuradoEm = instanteConsulta(c.dias);
  // host oficial: o PlacarConsulta só mostra o link se a url passar em urlFonteConsultaValida
  const urlFonte = `${c.urlInvalida ? "http" : "https"}://www12.senado.leg.br/ecidadania/visualizacaomateria?id=${c.prop.id.split(":")[1]}`;
  // placar também na página da proposição (senadoEm(3) e as demais sem consulta ficam com null)
  c.prop.consulta = { votosSim: c.sim, votosNao: c.nao, apuradoEm, urlFonte };
  feed.push({
    id: String(seq++),
    tipo: "consulta_publica",
    ocorridoEm: apuradoEm,
    parlamentar: proponente(c.prop),
    proposicao: proposicaoResumo(c.prop),
    votosSim: c.sim,
    votosNao: c.nao,
    apuradoEm,
    urlFonte,
  });
}

feed.sort((a, b) =>
  a.ocorridoEm === b.ocorridoEm ? Number(b.id) - Number(a.id) : a.ocorridoEm < b.ocorridoEm ? 1 : -1,
);

// ---- estatísticas derivadas ----

const anoCorrente = hoje.getUTCFullYear();
for (const p of parlamentares) {
  const vots = votacoes.filter((v) => v.casa === p.casa);
  const registrados = vots.filter((v) =>
    v.votos.some((x) => x.parlamentar.id === p.id && x.voto !== "ausente"),
  ).length;
  p.estatisticas.votacoesNominais = vots.length;
  p.estatisticas.presencaPct = vots.length ? (registrados / vots.length) * 100 : null;
  p.estatisticas.proposicoesAutor = proposicoes.filter((x) =>
    x.autores.some((a) => a.parlamentar.id === p.id && a.proponente),
  ).length;
  if (p.casa === "camara") {
    p.estatisticas.despesasAnoCorrente = feed
      .filter(
        (f) => f.tipo === "despesa_mensal" && f.parlamentar.id === p.id && f.ano === anoCorrente,
      )
      .reduce((s, f) => s + (f.tipo === "despesa_mensal" ? f.total : 0), 0);
  }
}

export const partidos = (() => {
  const c = new Map<string, number>();
  for (const p of parlamentares) if (p.partido) c.set(p.partido, (c.get(p.partido) ?? 0) + 1);
  return [...c.entries()]
    .map(([sigla, total]) => ({ sigla, total }))
    .sort((a, b) => b.total - a.total || a.sigla.localeCompare(b.sigla));
})();
