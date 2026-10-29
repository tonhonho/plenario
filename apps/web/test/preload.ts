import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Bun nao e Vite: import.meta.env nao existe, entao o que o cliente le via import.meta.env vem de process.env.
// VITE_MOCK tem de estar setado antes do import de src/api/client.ts (os testes importam depois deste preload).
GlobalRegistrator.register();

process.env.BASE_URL = "/";
process.env.VITE_MOCK = "1";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// RTL tem de ser importado so depois do register: o `screen` liga no document no momento do import.
// Desliga o auto-cleanup do RTL: o dono do cleanup entre testes e o afterEach abaixo, nao um registro implicito.
process.env.RTL_SKIP_AUTO_CLEANUP = "true";
const { cleanup } = await import("@testing-library/react");
afterEach(cleanup);
