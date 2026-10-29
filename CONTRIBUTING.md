# Contribuindo

Obrigado pelo interesse. Algumas regras para o projeto continuar confiável:

## Princípios

1. **Só fato com fonte.** Nada de nota, ranking ou adjetivo sobre voto ou parlamentar. Se a
   métrica nova envolve juízo de valor, abra uma issue para discutir antes do código.
2. **Neutralidade visual.** Nenhuma cor de partido. Informação nunca só por cor.
3. **Bom vizinho das fontes.** Carga pesada usa os arquivos em lote; chamadas à API passam por
   `apps/ingest/src/http.ts` (concorrência baixa, backoff).
4. **Sem dado pessoal de usuário** enquanto não houver uma decisão explícita sobre contas.

## Fluxo

- Abra uma issue descrevendo o problema ou a ideia antes de PR grande.
- Um PR por assunto. Rode `bun run typecheck` antes de abrir.
- Mudança em `packages/core` (schema do banco ou contrato HTTP) afeta todo mundo: descreva no
  PR o que muda para o ingest, a API e a web.

## Testes

- Web (`apps/web`): `cd apps/web` e `bun test`. Roda com DOM de teste (happy-dom) e Testing Library, e nao
  precisa de Postgres.
- O `bun test` da raiz nao inclui o web: o `bunfig.toml` da raiz ignora `apps/web/**`, porque o web depende
  do preload de DOM dele (`apps/web/bunfig.toml`).
- Convencao: o teste de componente fica ao lado do arquivo, como `NomeDoComponente.test.tsx`, e usa `bun:test`.
- CI: `.github/workflows/testes.yml` roda em todo pull request e em push na main. Sobe um Postgres 16
  descartavel (`plenario_test`), aplica o schema (`bun run db:push`) e roda `bun run typecheck` e o `bun test`
  de `apps/api`, `apps/ingest`, `apps/export` e `apps/web`, um workspace por vez. Nao usa segredos.

## Boas primeiras tarefas

- Nova fonte: despesas do Senado (CEAPS), discursos, presença em comissões.
- Assembleias estaduais e câmaras municipais (cada uma é um adaptador novo em `apps/ingest`).
- Acessibilidade e performance do front.
