// Ordem do feed da API: `ocorrido_em desc, id desc`, com ocorrido_em em microssegundos.
// O ISO dos arquivos exportados so tem ms; o instante em us vem do banco (mapa id -> us).
type Item = { id: string; ocorridoEm: string };

function comparador(usPorId: ReadonlyMap<string, bigint>) {
  const us = (i: Item): bigint => usPorId.get(i.id) ?? BigInt(Date.parse(i.ocorridoEm)) * 1000n;
  return (a: Item, b: Item): number => {
    const ua = us(a);
    const ub = us(b);
    if (ua !== ub) return ua < ub ? 1 : -1;
    const ia = BigInt(a.id);
    const ib = BigInt(b.id);
    return ia === ib ? 0 : ia < ib ? 1 : -1;
  };
}

export function ordenarPorMicrossegundo<T extends Item>(
  itens: readonly T[],
  usPorId: ReadonlyMap<string, bigint>,
): T[] {
  return [...itens].sort(comparador(usPorId));
}

// Primeiro indice cujo item deveria vir antes do anterior; null se a lista ja esta na ordem da API.
export function primeiraQuebraDeOrdem(
  itens: readonly Item[],
  usPorId: ReadonlyMap<string, bigint>,
): number | null {
  const cmp = comparador(usPorId);
  for (let i = 1; i < itens.length; i++) {
    if (cmp(itens[i - 1]!, itens[i]!) > 0) return i;
  }
  return null;
}
