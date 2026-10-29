import { describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { proposicoes } from "../api/mock/fixtures";
import { idParaUrl } from "../lib/ids";
import { Proposicao } from "../pages/Proposicao";
import { AVISO_CONSULTA, CTA_CONSULTA, PlacarConsulta } from "./PlacarConsulta";

const URL_OFICIAL = "https://www12.senado.leg.br/ecidadania/visualizacaomateria?id=123";
const APURADO_EM = "2026-10-20T15:00:00.000Z";

function renderPlacar(urlFonte: string) {
  return render(<PlacarConsulta votosSim={412876} votosNao={198043} apuradoEm={APURADO_EM} urlFonte={urlFonte} />);
}

function renderPagina(id: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/p/${idParaUrl(id)}`]}>
        <Routes>
          <Route path="/p/:id" element={<Proposicao />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PlacarConsulta", () => {
  it("url oficial valida: totais pt-BR, data de apuracao, aviso e link do CTA", () => {
    renderPlacar(URL_OFICIAL);
    expect(screen.getByText("412.876")).toBeTruthy();
    expect(screen.getByText("198.043")).toBeTruthy();
    expect(screen.getByText(/Votos apurados até/)).toBeTruthy();
    expect(screen.getByText(AVISO_CONSULTA)).toBeTruthy();
    const link = screen.getByRole("link");
    expect(link.textContent).toContain(CTA_CONSULTA);
    expect(link.getAttribute("href")).toBe(URL_OFICIAL);
  });

  it("url http no host oficial: placar e aviso visiveis, sem link", () => {
    renderPlacar(URL_OFICIAL.replace("https:", "http:"));
    expect(screen.getByText("412.876")).toBeTruthy();
    expect(screen.getByText(AVISO_CONSULTA)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("host fora do oficial com https: placar visivel, sem link", () => {
    renderPlacar("https://example.org/x");
    expect(screen.getByText("198.043")).toBeTruthy();
    expect(screen.getByText(AVISO_CONSULTA)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("pagina Proposicao e o bloco de consulta", () => {
  it("proposicao sem consulta: sem bloco #consulta nem aviso, depois de carregar", async () => {
    const p = proposicoes.find((x) => x.consulta === null && x.ementa);
    if (!p?.ementa) throw new Error("fixture sem proposicao sem consulta");
    const { container } = renderPagina(p.id);
    await screen.findByText(p.ementa, {}, { timeout: 3000 });
    expect(container.querySelector("#consulta")).toBeNull();
    expect(screen.queryByText(AVISO_CONSULTA)).toBeNull();
  });

  it("proposicao com consulta: bloco #consulta e aviso presentes depois de carregar", async () => {
    const p = proposicoes.find((x) => x.consulta !== null);
    if (!p?.consulta) throw new Error("fixture sem proposicao com consulta");
    const { container } = renderPagina(p.id);
    await screen.findByRole("heading", { name: "Consulta pública" }, { timeout: 3000 });
    expect(screen.getByText(AVISO_CONSULTA)).toBeTruthy();
    const bloco = container.querySelector("#consulta");
    expect(bloco).not.toBeNull();
    expect(bloco?.textContent).toBe("Consulta pública");
    expect(bloco?.parentElement?.textContent).toContain(`${p.consulta.votosSim.toLocaleString("pt-BR")}`);
  });
});
