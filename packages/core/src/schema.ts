// Contrato do banco. Todo app (ingest, api) lê e escreve por aqui.
// Mudança aqui é mudança de contrato: só aditiva (coluna nullable, tabela nova) sem combinar antes.
//
// Convenção de id: "<casa>:<id-na-fonte>" — ex.: "camara:204379", "senado:5672".
// Assim a mesma tabela guarda as duas casas sem colisão e o id é estável entre cargas.

import {
  pgTable,
  pgEnum,
  text,
  integer,
  boolean,
  timestamp,
  date,
  numeric,
  bigserial,
  jsonb,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const casaEnum = pgEnum("casa", ["camara", "senado"]);

export const votoEnum = pgEnum("voto_tipo", [
  "sim",
  "nao",
  "abstencao",
  "obstrucao",
  "art17", // presidente da sessão (Câmara) / "Presidente" (Senado): não vota
  "ausente",
  "outro",
]);

export const eventoTipoEnum = pgEnum("evento_tipo", ["voto", "proposicao", "despesa_mensal", "consulta_publica"]);

export const parlamentar = pgTable(
  "parlamentar",
  {
    id: text("id").primaryKey(),
    casa: casaEnum("casa").notNull(),
    idExterno: text("id_externo").notNull(),
    nome: text("nome").notNull(), // nome parlamentar (o que aparece na urna/plenário)
    nomeCivil: text("nome_civil"),
    partido: text("partido"), // sigla atual
    uf: text("uf"),
    fotoUrl: text("foto_url"),
    email: text("email"),
    emExercicio: boolean("em_exercicio").notNull().default(true),
    // texto normalizado (sem acento, minúsculo) de nome + nome civil, pra busca com pg_trgm
    busca: text("busca").notNull(),
    atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("parlamentar_casa_externo_uq").on(t.casa, t.idExterno),
    index("parlamentar_partido_idx").on(t.partido),
    index("parlamentar_uf_idx").on(t.uf),
    // o índice trigram (gin_trgm_ops) em `busca` é criado em sql/extra.sql
  ],
);

// Períodos em que o parlamentar esteve de fato no cargo (titular ou suplente em exercício).
// É o denominador honesto da presença: licença e suplência não contam como falta.
export const exercicio = pgTable(
  "exercicio",
  {
    parlamentarId: text("parlamentar_id")
      .notNull()
      .references(() => parlamentar.id, { onDelete: "cascade" }),
    inicio: date("inicio").notNull(),
    fim: date("fim"), // null = em exercício hoje
    motivoFim: text("motivo_fim"), // texto da fonte: "Licença", "Afastamento", "Renúncia"...
  },
  (t) => [primaryKey({ columns: [t.parlamentarId, t.inicio] })],
);

export const proposicao = pgTable(
  "proposicao",
  {
    id: text("id").primaryKey(), // "camara:2645127" | "senado:174386" (codigoMateria)
    casa: casaEnum("casa").notNull(),
    idExterno: text("id_externo").notNull(),
    siglaTipo: text("sigla_tipo").notNull(), // PL, PEC, MPV, PLP, REQ...
    numero: integer("numero"),
    ano: integer("ano"),
    ementa: text("ementa"),
    dataApresentacao: timestamp("data_apresentacao", { withTimezone: true }),
    url: text("url"), // página pública da proposição na casa
    atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("proposicao_casa_externo_uq").on(t.casa, t.idExterno)],
);

export const proposicaoAutor = pgTable(
  "proposicao_autor",
  {
    proposicaoId: text("proposicao_id")
      .notNull()
      .references(() => proposicao.id, { onDelete: "cascade" }),
    parlamentarId: text("parlamentar_id")
      .notNull()
      .references(() => parlamentar.id, { onDelete: "cascade" }),
    ordem: integer("ordem"), // 1 = primeiro signatário
    proponente: boolean("proponente").notNull().default(true),
  },
  (t) => [
    primaryKey({ columns: [t.proposicaoId, t.parlamentarId] }),
    index("proposicao_autor_parl_idx").on(t.parlamentarId),
  ],
);

// Apuracao de consulta publica do e-Cidadania (enquete aberta). Os numeros sao da fonte, no instante `apuradoEm`.
export const consultaPublica = pgTable(
  "consulta_publica",
  {
    materiaCod: text("materia_cod").primaryKey(),
    proposicaoId: text("proposicao_id")
      .notNull()
      .references(() => proposicao.id, { onDelete: "cascade" }),
    votosSim: integer("votos_sim").notNull(),
    votosNao: integer("votos_nao").notNull(),
    apuradoEm: timestamp("apurado_em", { withTimezone: true }).notNull(), // instante da fonte, nao now()
    urlFonte: text("url_fonte").notNull(),
    atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("consulta_publica_apurado_idx").on(t.apuradoEm)],
);

export const votacao = pgTable(
  "votacao",
  {
    id: text("id").primaryKey(), // "camara:2487836-50" | "senado:<codigoSessaoVotacao>"
    casa: casaEnum("casa").notNull(),
    idExterno: text("id_externo").notNull(),
    dataHora: timestamp("data_hora", { withTimezone: true }).notNull(),
    // Senado: a fonte só dá a data; o horário é o início da Ordem do Dia da sessão
    dataHoraAproximada: boolean("data_hora_aproximada").notNull().default(false),
    orgao: text("orgao"), // PLEN, CCJC...
    descricao: text("descricao"),
    proposicaoId: text("proposicao_id").references(() => proposicao.id, { onDelete: "set null" }),
    aprovada: boolean("aprovada"),
    nominal: boolean("nominal").notNull().default(false), // simbólica não tem voto individual
    secreta: boolean("secreta").notNull().default(false), // secreta: placar sim, voto individual não
    url: text("url"), // página pública da votação ou da sessão (HTML, nunca o recurso JSON)
    placarSim: integer("placar_sim"),
    placarNao: integer("placar_nao"),
    placarOutros: integer("placar_outros"),
    atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("votacao_casa_externo_uq").on(t.casa, t.idExterno),
    index("votacao_data_idx").on(t.dataHora),
    index("votacao_plen_nominal_idx")
      .on(t.casa, t.dataHora)
      .where(sql`nominal and orgao = 'PLEN'`),
    index("votacao_proposicao_idx").on(t.proposicaoId),
  ],
);

export const voto = pgTable(
  "voto",
  {
    votacaoId: text("votacao_id")
      .notNull()
      .references(() => votacao.id, { onDelete: "cascade" }),
    parlamentarId: text("parlamentar_id")
      .notNull()
      .references(() => parlamentar.id, { onDelete: "cascade" }),
    voto: votoEnum("voto").notNull(),
    votoOriginal: text("voto_original"), // texto cru da fonte, pra auditoria
    partidoNaHora: text("partido_na_hora"), // partido no momento do voto (muda com o tempo)
  },
  (t) => [
    primaryKey({ columns: [t.votacaoId, t.parlamentarId] }),
    index("voto_parl_idx").on(t.parlamentarId),
  ],
);

export const despesa = pgTable(
  "despesa",
  {
    // "camara:<idDocumento>-<hash do conteúdo>": o idDocumento da CEAP vem 0/nulo e se repete
    // (uma linha por tarifa nas passagens), então sozinho ele sobrescreveria linhas.
    id: text("id").primaryKey(),
    parlamentarId: text("parlamentar_id")
      .notNull()
      .references(() => parlamentar.id, { onDelete: "cascade" }),
    ano: integer("ano").notNull(),
    mes: integer("mes").notNull(),
    categoria: text("categoria").notNull(), // tipoDespesa
    fornecedor: text("fornecedor"),
    documentoFornecedor: text("documento_fornecedor"), // CNPJ/CPF do fornecedor (dado público da CEAP)
    valor: numeric("valor", { precision: 12, scale: 2 }).notNull(), // valorLiquido
    data: date("data"),
    urlDocumento: text("url_documento"),
  },
  (t) => [
    index("despesa_parl_mes_idx").on(t.parlamentarId, t.ano, t.mes),
    index("despesa_mes_idx").on(t.ano, t.mes),
  ],
);

// Feed materializado. Cada linha é um card. O ingest escreve aqui depois de gravar a fonte;
// a API só lê. `refId` aponta pra linha de origem conforme o tipo:
//   voto              -> votacao.id
//   proposicao        -> proposicao.id
//   despesa_mensal    -> "<ano>-<mes2>" (ex.: "2026-09"), totalizado de `despesa`
//   consulta_publica  -> "<proposicao_id>:<AAAA-MM>" (mes da apresentacao; um por proposicao, `resumo` com o placar da ultima leitura)
export const evento = pgTable(
  "evento",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    parlamentarId: text("parlamentar_id")
      .notNull()
      .references(() => parlamentar.id, { onDelete: "cascade" }),
    tipo: eventoTipoEnum("tipo").notNull(),
    ocorridoEm: timestamp("ocorrido_em", { withTimezone: true }).notNull(),
    refId: text("ref_id").notNull(),
    // dados desnormalizados mínimos pra montar o card sem join pesado (opcional)
    resumo: jsonb("resumo"),
    criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("evento_dedupe_uq").on(t.parlamentarId, t.tipo, t.refId),
    // nullsFirst() deixa o índice como DESC puro, que é o que um `order by ... desc` comum casa.
    // O padrão do Drizzle (DESC NULLS LAST) faz o Postgres ignorar o índice e varrer a tabela.
    index("evento_feed_idx").on(t.parlamentarId, t.ocorridoEm.desc().nullsFirst(), t.id.desc().nullsFirst()),
    index("evento_global_idx").on(t.ocorridoEm.desc().nullsFirst(), t.id.desc().nullsFirst()),
  ],
);

// Estado de cada fonte de ingestão, pra carga incremental retomar de onde parou.
export const ingestCursor = pgTable("ingest_cursor", {
  fonte: text("fonte").primaryKey(), // "camara:votacoes", "senado:votacoes", ...
  ultimoSync: timestamp("ultimo_sync", { withTimezone: true }),
  estado: jsonb("estado"),
});
