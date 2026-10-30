/**
 * Link pessoal da Área do Cliente: https://area.vivanettelecom.com.br/p/<código>.
 * Um código por envio, ligado a um contrato e com validade. Ao abrir, a Área entra direto
 * nas faturas daquele contrato, sem pedir CPF (rota /v1/area/link). Vencido, cai no login por CPF.
 */
import { randomBytes } from 'node:crypto';
import { pool } from '../db.js';
import { schemaDe, type Tenant } from '../tenants.js';

// Sem caracteres que se confundem na tela do celular (0/O, 1/l/I).
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export function novoCodigo(tamanho = 8): string {
  let s = '';
  for (const b of randomBytes(tamanho)) s += ALFABETO[b % ALFABETO.length];
  return s;
}

/** Cria o link e devolve { codigo, url }. Erro se o tenant não tiver area_link_base. */
export async function criarLinkArea(
  t: Tenant, contratoId: number, etapa: string, canal: 'sms' | 'email', dias: number,
): Promise<{ codigo: string; url: string }> {
  if (!t.area_link_base) throw new Error(`tenant ${t.id} sem area_link_base`);
  const base = t.area_link_base.replace(/\/+$/, '');
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    const codigo = novoCodigo();
    const r = await pool.query(
      `INSERT INTO ${schemaDe(t)}.links_area (codigo, contrato_id, etapa, canal, expira_em)
       VALUES ($1, $2, $3, $4, now() + make_interval(days => $5)) ON CONFLICT (codigo) DO NOTHING`,
      [codigo, contratoId, etapa, canal, dias],
    );
    if (r.rowCount) return { codigo, url: `${base}/p/${codigo}` };
  }
  throw new Error('não foi possível gerar um código de link único');
}
