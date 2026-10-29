# Plenário

Acompanhe o que seus parlamentares fazem: como votaram, o que propuseram e quanto gastaram,
num feed cronológico. Siga quem quiser, sem criar conta.

**Site:** https://tonhonho.github.io/plenario

Projeto de **código aberto e sem fins lucrativos**. Todo dado vem das fontes oficiais da
Câmara dos Deputados e do Senado Federal, e todo item leva link para a página de origem.

## O que dá pra fazer

- Buscar qualquer deputado federal ou senador da legislatura atual, por nome, partido ou UF.
- Ver no perfil cada votação nominal, cada projeto apresentado e o gasto mensal da cota parlamentar.
- Seguir parlamentares e ver tudo num feed só. A lista fica no seu navegador e pode ser
  exportada ou compartilhada por link.
- Abrir uma votação e ver o placar por partido e o voto de cada parlamentar.
- Ver no feed e na página do projeto as consultas públicas do e-Cidadania sobre projetos do
  Senado: total de sim e de não até a data da apuração, com link para a enquete oficial. É uma
  enquete aberta, não uma votação.

## O que o projeto não faz

Não dá nota, não ranqueia, não diz se um voto foi bom ou ruim. Mostra o fato, com a fonte.

## Rodar local

Requisitos: [Bun](https://bun.sh) 1.2+ e PostgreSQL 16 (local ou via `docker compose up -d`).

```sh
bun install
cp .env.example .env
createdb plenario
bun run db:push
bun run ingest camara --desde 2026-09-01   # recorte curto pra começar rápido
bun run ingest senado --desde 2026-09-01
bun run dev:api    # http://localhost:8787
bun run dev:web    # http://localhost:5173
```

Para mexer só no front sem banco: `VITE_MOCK=1 bun run dev:web`.

## Como o site é publicado

Não há servidor. Todo dia às 03:00 (Brasília) o workflow `.github/workflows/pages.yml` restaura o
banco da véspera, roda o ingest incremental, exporta tudo como JSON estático (`bun run export`,
formato em `packages/core/src/estatico.ts`) e publica no GitHub Pages. A busca e o feed de quem
você segue rodam no navegador sobre esses arquivos. A API (`apps/api`) continua servindo para
desenvolvimento local e para quem quiser hospedar uma versão com servidor.

## Como está organizado

Veja [docs/ARQUITETURA.md](docs/ARQUITETURA.md). Em uma linha: `apps/ingest` puxa as fontes
públicas para o Postgres, `apps/api` serve em JSON e `apps/web` mostra. O contrato entre eles
fica em `packages/core`.

## Contribuir

Veja [CONTRIBUTING.md](CONTRIBUTING.md).

## Licença

[AGPL-3.0](LICENSE). Pode usar, estudar, modificar e hospedar. Quem hospedar uma versão
modificada para o público tem que publicar o código dela também.

## Fontes de dados

- Câmara dos Deputados — [Dados Abertos](https://dadosabertos.camara.leg.br)
- Senado Federal — [Dados Abertos](https://www12.senado.leg.br/dados-abertos)
