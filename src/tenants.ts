import { pool } from './db.js';

export interface Tenant {
  id: string;
  nome: string;
  sgp_base_url: string;
  sgp_app: string;
  sgp_token_env: string;
  schema_name: string;
  pops_permitidos: number[];
  empresa_cnpj: string | null;
  gerar_os_2via: boolean;
  link_boleto_base: string | null;
  sgp_write_app: string | null;
  sgp_write_token_env: string | null;
}

export interface Canal {
  id: number;
  tenant_id: string;
  nome: string;
  pops: number[];
  permite_telefone: boolean;
  permite_cadastro: boolean;
  permite_email: boolean;
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,40}$/;

/** Identificador SQL do schema do tenant, validado (nunca vem do usuário). */
export function schemaDe(t: Pick<Tenant, 'schema_name'>): string {
  if (!SCHEMA_RE.test(t.schema_name)) throw new Error(`schema inválido: ${t.schema_name}`);
  return `"${t.schema_name}"`;
}

export async function tenantsAtivos(): Promise<Tenant[]> {
  const { rows } = await pool.query<Tenant>(
    `SELECT id, nome, sgp_base_url, sgp_app, sgp_token_env, schema_name,
            pops_permitidos, empresa_cnpj, gerar_os_2via, link_boleto_base,
            sgp_write_app, sgp_write_token_env
       FROM gateway.tenants WHERE ativo ORDER BY id`,
  );
  return rows;
}
