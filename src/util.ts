export const soDigitos = (v: unknown): string => String(v ?? '').replace(/\D/g, '');

/** Telefone BR em dígitos, sem DDI 55. Retorna null se não parecer telefone. */
export function normalizarTelefone(v: unknown): string | null {
  let d = soDigitos(v);
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  return d.length === 10 || d.length === 11 ? d : null;
}

/** Data de hoje em America/Sao_Paulo, formato AAAA-MM-DD. */
export function hojeSP(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

/** Dias de atraso a partir da data de vencimento (0 se ainda não venceu). */
export function diasAtraso(vencimento: string, hoje = hojeSP()): number {
  const v = Date.parse(`${vencimento}T00:00:00Z`);
  const h = Date.parse(`${hoje}T00:00:00Z`);
  if (Number.isNaN(v)) return 0;
  return Math.max(0, Math.round((h - v) / 86_400_000));
}

export const comoObjeto = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export const comoLista = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
