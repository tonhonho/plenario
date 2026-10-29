import { describe, expect, it } from "bun:test";
import { render, screen } from "@testing-library/react";
import type { FeedItemConsulta } from "@plenario/core/api";
import { MemoryRouter } from "react-router";
import { feed } from "../api/mock/fixtures";
import { FeedCard } from "./FeedCard";
import { AVISO_CONSULTA } from "./PlacarConsulta";

const NOME_CTA_COMPLETO = "Opine no e-Cidadania — site do Senado (abre em nova aba)";

/** Item `consulta_publica` do mock cuja urlFonte comeca com `prefixo` (fixtures.ts, ordem do feed). */
function consultaCom(prefixo: string): FeedItemConsulta {
  const item = feed.find(
    (f): f is FeedItemConsulta => f.tipo === "consulta_publica" && f.urlFonte.startsWith(prefixo),
  );
  if (!item) throw new Error(`fixture de consulta com urlFonte ${prefixo} ausente`);
  return item;
}

function renderizar(item: FeedItemConsulta) {
  return render(
    <MemoryRouter>
      <FeedCard item={item} />
    </MemoryRouter>,
  );
}

describe("FeedCard: card de consulta publica (CTA)", () => {
  it("C131 nome acessivel completo do CTA da consulta", () => {
    renderizar(consultaCom("https://www12.senado.leg.br/"));
    const link = screen.getByRole("link", { name: NOME_CTA_COMPLETO });
    const srOnly = Array.from(link.querySelectorAll(".sr-only"), (s) => s.textContent);
    expect(srOnly).toEqual([" — site do Senado", "(abre em nova aba)"]);
  });

  it("C132 o link do CTA aponta para a urlFonte, abre em nova aba e tem rel noopener", () => {
    const item = consultaCom("https://www12.senado.leg.br/");
    renderizar(item);
    const link = screen.getByRole("link", { name: NOME_CTA_COMPLETO });
    expect(link.getAttribute("href")).toBe(item.urlFonte);
    expect(link.getAttribute("target")).toBe("_blank");
    expect((link.getAttribute("rel") ?? "").includes("noopener")).toBe(true);
  });

  it("C132 degenerado: url com http nao gera link do CTA, mas o aviso segue no card", () => {
    renderizar(consultaCom("http://www12.senado.leg.br/"));
    expect(screen.queryByRole("link", { name: /Opine no e-Cidadania/ })).toBeNull();
    expect(screen.getByText(AVISO_CONSULTA)).toBeTruthy();
  });
});
