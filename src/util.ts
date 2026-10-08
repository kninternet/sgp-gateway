export const soDigitos = (v: unknown): string => String(v ?? '').replace(/\D/g, '');

/** Telefone BR em dígitos, sem DDI 55. Retorna null se não parecer telefone. */
export function normalizarTelefone(v: unknown): string | null {
  let d = soDigitos(v);
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  return d.length === 10 || d.length === 11 ? d : null;
}

/**
 * Formas do mesmo celular com e sem o nono dígito: o WhatsApp às vezes entrega
 * o número antigo (DDD + 8 dígitos) e o SGP guarda o novo, ou o contrário.
 */
export function variantesTelefone(tel: string): string[] {
  const d = soDigitos(tel);
  if (d.length === 11 && d[2] === '9') return [d, d.slice(0, 2) + d.slice(3)];
  if (d.length === 10 && /[6-9]/.test(d[2])) return [d, d.slice(0, 2) + '9' + d.slice(2)];
  return [d];
}

export function cnpjValido(v: string): boolean {
  const d = soDigitos(v);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const calc = (n: number) => {
    let soma = 0, pos = n - 7;
    for (let i = n; i >= 1; i--) { soma += Number(d[n - i]) * pos--; if (pos < 2) pos = 9; }
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
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
