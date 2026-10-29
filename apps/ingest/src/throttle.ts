// Throttle de taxa para as consultas publicas (e-Cidadania). Garante um intervalo minimo entre
// chamadas consecutivas. Nao e aplicado dentro de buscarJson/buscarTexto: as outras fontes nao mudam.
// O chamador (modulo de consultas) chama `esperar()` antes de cada pagina.

export const VAR_INTERVALO_CONSULTAS = "INGEST_CONSULTAS_INTERVALO_MS";
export const INTERVALO_CONSULTAS_PADRAO_MS = 1000;

export type Relogio = () => number;
export type Dormir = (ms: number) => Promise<void>;

export interface OpcoesThrottle {
  agora?: Relogio;
  dormir?: Dormir;
}

export interface Throttle {
  esperar(): Promise<void>;
}

// Valor ausente = padrao. Vazio, nao numerico, infinito ou negativo tambem caem no padrao.
// Zero e valido (sem espera). Le so o que recebe: nao guarda nada em nivel de modulo.
export function lerIntervaloConsultas(env: Readonly<Record<string, string | undefined>>): number {
  const bruto = env[VAR_INTERVALO_CONSULTAS];
  if (bruto === undefined) return INTERVALO_CONSULTAS_PADRAO_MS;
  const texto = bruto.trim();
  if (texto === "") return INTERVALO_CONSULTAS_PADRAO_MS;
  const valor = Number(texto);
  if (!Number.isFinite(valor) || valor < 0) return INTERVALO_CONSULTAS_PADRAO_MS;
  return valor;
}

// `intervalo` pode ser um numero fixo ou uma funcao lida a cada espera (para o env ser lido na chamada).
// Chamadas concorrentes sao serializadas: nenhum par de esperas fica a menos de `intervalo` ms.
export function criarThrottle(
  intervalo: number | (() => number),
  opcoes: OpcoesThrottle = {},
): Throttle {
  const agora: Relogio = opcoes.agora ?? (() => Date.now());
  const dormir: Dormir = opcoes.dormir ?? ((ms) => Bun.sleep(ms));
  const intervaloAtual = typeof intervalo === "number" ? () => intervalo : intervalo;

  let ultimo: number | null = null;
  let fila: Promise<void> = Promise.resolve();

  return {
    esperar(): Promise<void> {
      const vez = fila.then(async () => {
        if (ultimo !== null) {
          const falta = ultimo + intervaloAtual() - agora();
          if (falta > 0) await dormir(falta);
        }
        ultimo = agora();
      });
      // A fila segue mesmo se uma espera falhar; o erro continua indo para quem chamou `esperar()`.
      fila = vez.catch(() => undefined);
      return vez;
    },
  };
}

// Throttle para o modulo de consultas. Cria-se uma instancia por execucao e ela e compartilhada entre paginas.
export function criarThrottleConsultas(opcoes: OpcoesThrottle = {}): Throttle {
  return criarThrottle(() => lerIntervaloConsultas(process.env), opcoes);
}
