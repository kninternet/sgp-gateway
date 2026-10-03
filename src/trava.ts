import { pool } from './db.js';
import { schemaDe, type Canal, type Tenant } from './tenants.js';

export interface ContratoPermitido {
  contrato_id: number;
  cliente_id: number;
}

/**
 * Trava de POP: o contrato só é aceito se estiver na base própria do tenant
 * E em um dos POPs do canal. Toda rota que recebe contrato passa por aqui antes do SGP.
 */
export async function contratoPermitido(
  tenant: Tenant,
  canal: Canal,
  contratoId: number,
): Promise<ContratoPermitido | null> {
  const s = schemaDe(tenant);
  const { rows } = await pool.query<ContratoPermitido>(
    `SELECT id AS contrato_id, cliente_id FROM ${s}.contratos WHERE id = $1 AND pop_id = ANY($2::int[])`,
    [contratoId, canal.pops],
  );
  return rows[0] ?? null;
}
