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

/**
 * Troca o domínio da central do SGP pelo domínio público do tenant.
 * Sem link_boleto_base configurado, devolve o link original.
 * Com ele configurado, só /boleto/ é repassado; qualquer outro caminho vira null
 * (o proxy público só serve /boleto/, e nada do domínio original chega ao cliente).
 */
export function linkPublico(base: string | null | undefined, link: unknown): string | null {
  if (typeof link !== 'string' || !link) return null;
  if (!base) return link;
  try {
    const u = new URL(link);
    if (!u.pathname.startsWith('/boleto/')) return null;
    return base.replace(/\/+$/, '') + u.pathname + u.search;
  } catch {
    return null;
  }
}

/** Texto para comparação: sem acento, minúsculo, espaços simples. */
export const normalizarTexto = (v: unknown): string =>
  String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

export function cpfValido(c: string): boolean {
  if (!/^\d{11}$/.test(c) || /^(\d)\1{10}$/.test(c)) return false;
  for (const n of [9, 10]) {
    let s = 0;
    for (let i = 0; i < n; i++) s += Number(c[i]) * (n + 1 - i);
    if (((s * 10) % 11) % 10 !== Number(c[n])) return false;
  }
  return true;
}

/** Celular no formato que o SGP aceita: DDD + 9 + 8 dígitos. Null se não der. */
export function celularParaSgp(v: unknown): string | null {
  const d = normalizarTelefone(v);
  return d && d.length === 11 && d[2] === '9' ? d : null;
}
