/**
 * Status do funil do CRM, lido direto do banco do SGP (somente leitura).
 * A API do SGP só ALTERA esse status; não há rota para consultá-lo.
 *
 * Tabela crm_clientestatus: uma linha por mudança de status; o atual é a mais recente.
 * Única consulta permitida aqui: status atual por cliente_id. Nada de dados pessoais.
 *
 * Opcional: sem SGP_DB_URL, ou se o banco falhar, devolve vazio e o chamador usa a dedução.
 */
import pg from 'pg';
import { config } from '../config.js';

/** Códigos do funil (os mesmos da rota "Status CRM - Alterar" da API). */
export const STATUS_CRM: Record<number, string> = {
  1: 'Em análise',
  2: 'Aprovado',
  3: 'Reprovado',
  4: 'Aguardando Contato',
  5: 'Tentando Contato',
  6: 'Contrato realizado no SGP',
  7: 'Inviabilidade técnica',
  8: 'Contrato em Prospecção',
  9: 'Reprovado - SPC SERASA',
  10: 'Análise de Viabilidade técnica',
};

export interface StatusCrm {
  status_id: number;
  status: string;
  motivo: string | null;
  desde: string | null;
}

const pool = config.SGP_DB_URL
  ? new pg.Pool({
      connectionString: config.SGP_DB_URL,
      max: 2,
      // Somente leitura e consulta curta: o banco é do SGP, não nosso.
      options: '-c default_transaction_read_only=on -c statement_timeout=3000',
      connectionTimeoutMillis: 3000,
    })
  : null;

pool?.on('error', () => {
  /* conexão ociosa caiu; a próxima consulta reconecta */
});

export async function statusCrm(clienteIds: number[]): Promise<Map<number, StatusCrm>> {
  const ids = [...new Set(clienteIds.filter((n) => Number.isSafeInteger(n) && n > 0))].slice(0, 20);
  const mapa = new Map<number, StatusCrm>();
  if (!pool || ids.length === 0) return mapa;
  try {
    const { rows } = await pool.query<{ cliente_id: number; status: number; motivo: string | null; data_cadastro: Date }>(
      `SELECT DISTINCT ON (cliente_id) cliente_id::int AS cliente_id, status::int AS status, motivo, data_cadastro
         FROM crm_clientestatus
        WHERE cliente_id = ANY($1::int[])
        ORDER BY cliente_id, id DESC`,
      [ids],
    );
    for (const r of rows) {
      mapa.set(r.cliente_id, {
        status_id: r.status,
        status: STATUS_CRM[r.status] ?? `Status ${r.status}`,
        motivo: r.motivo?.trim() || null,
        desde: r.data_cadastro ? new Date(r.data_cadastro).toISOString() : null,
      });
    }
  } catch {
    // Banco do SGP indisponível: sem status do CRM nesta resposta.
  }
  return mapa;
}

export async function encerrarCrm() {
  await pool?.end();
}
