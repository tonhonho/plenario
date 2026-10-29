import { describe, expect, it } from "bun:test";
import { render, screen } from "@testing-library/react";

describe("fumaca da infra de teste do web", () => {
  it("o preload registra o DOM e o render acha o texto", () => {
    render(<p>ola</p>);
    const el = screen.getByText("ola");
    expect(el.tagName).toBe("P");
    expect(el.textContent).toBe("ola");
    expect(document.body.contains(el)).toBe(true);
  });

  // Os dois `it` abaixo dependem da ordem: o segundo so prova o cleanup do preload porque o primeiro
  // renderizou o mesmo texto antes. Mantenha-os juntos e nesta ordem (sem `.only` em um so).
  it("cleanup entre testes: o texto de um teste nao sobra no seguinte", () => {
    render(<p>mesmo texto</p>);
    expect(screen.queryAllByText("mesmo texto")).toHaveLength(1);
  });

  it("cleanup entre testes: o segundo render do mesmo texto continua com um so", () => {
    render(<p>mesmo texto</p>);
    expect(screen.queryAllByText("mesmo texto")).toHaveLength(1);
  });

  it("env do preload: BASE_URL, VITE_MOCK e modo act do React", () => {
    expect(process.env.BASE_URL).toBe("/");
    expect(process.env.VITE_MOCK).toBe("1");
    expect((globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT).toBe(true);
  });
});
