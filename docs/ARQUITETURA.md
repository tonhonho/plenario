# Arquitetura

## O que é

Consulta pública da atuação de parlamentares federais: como votaram, o que propuseram e o que
gastaram, num feed cronológico. Você segue quem quiser e acompanha. Código aberto, sem fins
lucrativos, só dado oficial.

## Princípios (não negociáveis)

1. **Só fato com fonte.** Todo card leva link para a página oficial da casa. O produto não
   classifica, não pontua e não chama voto de "bom" ou "ruim". "Votou com o partido" é aritmética
   sobre o placar, não juízo de valor.
2. **Neutralidade visual.** Nenhuma cor de partido. Sim/Não sempre com texto e ícone, nunca só cor.
3. **Bom vizinho das fontes.** Carga pesada vem dos arquivos em lote; a API só no incremental,
   com concorrência baixa e backoff (`apps/ingest/src/http.ts`).
4. **Sem dado pessoal no v1.** "Seguir" fica no navegador (`localStorage`). Não existe conta,
   então não há o que vazar nem LGPD a cumprir. Conta só entra quando houver notificação.

## Componentes

```
fontes públicas ──► apps/ingest ──► Postgres ──► apps/api (Hono) ──► apps/web (React)
 Câmara (API v2 + arquivos)   normaliza e           só leitura,          feed, busca,
 Senado (dadosabertos)        materializa o feed    JSON público         perfil, seguir
```

| Pasta | Papel |
|---|---|
| `packages/core` | **Contrato.** `schema.ts` (banco, Drizzle) e `api.ts` (tipos HTTP). Mudança aqui é só aditiva. |
| `apps/ingest` | CLI que puxa Câmara e Senado, normaliza no schema e grava `evento` (o feed). |
| `apps/api` | API HTTP somente-leitura sobre o banco. |
| `apps/web` | SPA mobile-first. |

## Modelo

- Id é `"<casa>:<id-na-fonte>"` em toda tabela (`camara:204379`, `senado:5672`).
- `evento` é o feed **materializado**: uma linha por card, com dedupe por
  `(parlamentar, tipo, ref)`. O ingest escreve; a API pagina por `(ocorrido_em desc, id desc)`.
- Tipos de card no v1: `voto` (só votação nominal; simbólica não tem voto individual),
  `proposicao` (autoria/coautoria), `despesa_mensal` (cota parlamentar, só Câmara no v1) e
  `consulta_publica` (placar da consulta pública do e-Cidadania, ligado ao primeiro signatário; só
  Senado, ver `docs/consultas-publicas.md`).

## Fontes

| Dado | Câmara | Senado |
|---|---|---|
| Parlamentares | `api/v2/deputados` | `dadosabertos/senador/lista/atual` |
| Votações + votos | arquivos `votacoes-AAAA.json`, `votacoesVotos-AAAA.json`; API `api/v2/votacoes` no incremental | `dadosabertos/votacao?dataInicio&dataFim` (o antigo `senador/{id}/votacoes` está **descontinuado**) |
| Proposições + autores | arquivos `proposicoes-AAAA.json`, `proposicoesAutores-AAAA.json` | `dadosabertos/processo` / `materia` |
| Despesas | arquivo CEAP `Ano-AAAA.json` | fora do v1 |
| Consultas públicas | — | página HTML do e-Cidadania `www12.senado.leg.br/ecidadania/visualizacaomateria?id=<codigoMateria>` (sem API) |

Consultas públicas: a página não tem API, então o ingest lê o HTML com o mesmo User-Agent, 1
requisição por intervalo (`INGEST_CONSULTAS_INTERVALO_MS`, padrão 1000) e um teto de matérias por
execução (`INGEST_CONSULTAS_MAX`, padrão 500), a de leitura mais antiga primeiro. Leitura que falha
é pulada e logada, nunca vira zero.

No `ingest senado`, cada fonte (parlamentares, votações, proposições, consultas) roda isolada: a
falha de uma é logada e as demais seguem, exceto votações e proposições, que dependem da lista de
senadores e são puladas se parlamentares falhar. Com qualquer falha, o processo termina com erro
depois de rodar o resto.

Escopo inicial: legislatura atual (Câmara 57ª, desde 01/02/2023).

## Rodar local

```sh
bun install
createdb plenario            # ou: docker compose up -d (ver docker-compose.yml)
bun run db:push
bun run ingest camara --desde 2026-09-01
bun run ingest senado --desde 2026-09-01
bun run dev:api              # :8787
bun run dev:web              # :5173
```

## Depois do v1 (fora do escopo agora)

Conta + notificação (e-mail/push), despesas do Senado (CEAPS), discursos, presença em comissões,
assembleias estaduais e câmaras municipais (cada uma é uma fonte nova com formato próprio).
