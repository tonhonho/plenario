// Validacao pura da url_fonte de consulta publica. Unica regra usada por ingest (gravacao), API e export
// (leitura): o dado so sai se a url for https no host oficial, sem userinfo.
export const HOST_FONTE = "www12.senado.leg.br";

export function urlFonteConsultaValida(u: string): boolean {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.host === HOST_FONTE && url.username === "" && url.password === "";
}
