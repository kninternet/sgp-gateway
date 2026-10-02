/**
 * Sync da base própria: puxa os clientes de cada POP permitido de cada tenant
 * (Cliente – Listar, 100 por página), grava só contratos do POP e descarta senhas.
 * Faturas NÃO são gravadas — são sempre consultadas ao vivo.
 * Roda e encerra (PM2 cron a cada hora).
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from './db.js';
import { chamarSgp } from './sgp/client.js';
import { schemaDe, tenantsAtivos, type Tenant } from './tenants.js';
import { comoLista, comoObjeto, normalizarTelefone, soDigitos } from './util.js';

const PAGINA = 100;
const TIPOS_TELEFONE = ['telefones', 'celulares', 'outros'];

async function gravarCliente(db: PoolClient, s: string, pop: number, run: string, cli: Record<string, unknown>) {
  const clienteId = Number(cli.id);
  if (!Number.isSafeInteger(clienteId)) return 0;

  // Só contratos do POP sendo sincronizado.
  const contratos = comoLista(cli.contratos).map(comoObjeto).filter((c) => Number(c.pop_id) === pop);
  if (contratos.length === 0) return 0;

  await db.query(
    `INSERT INTO ${s}.clientes (id, nome, cpfcnpj, tipo, sync_run, atualizado_em)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (id) DO UPDATE SET nome = EXCLUDED.nome, cpfcnpj = EXCLUDED.cpfcnpj,
       tipo = EXCLUDED.tipo, sync_run = EXCLUDED.sync_run, atualizado_em = now()`,
    [clienteId, String(cli.nome ?? ''), soDigitos(cli.cpfcnpj), cli.tipo ?? null, run],
  );

  for (const c of contratos) {
    const plano = comoObjeto(comoObjeto(comoLista(c.servicos)[0]).plano).descricao ?? null;
    await db.query(
      `INSERT INTO ${s}.contratos (id, cliente_id, pop_id, status, motivo_status, vencimento, forma_cobranca, plano, sync_run, atualizado_em)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (id) DO UPDATE SET cliente_id = EXCLUDED.cliente_id, pop_id = EXCLUDED.pop_id,
         status = EXCLUDED.status, motivo_status = EXCLUDED.motivo_status, vencimento = EXCLUDED.vencimento,
         forma_cobranca = EXCLUDED.forma_cobranca, plano = EXCLUDED.plano, sync_run = EXCLUDED.sync_run, atualizado_em = now()`,
      [
        Number(c.id), clienteId, pop, c.status ?? null, c.motivo_status || null,
        c.vencimento != null ? String(c.vencimento) : null,
        c.formaCobranca != null ? String(c.formaCobranca) : null,
        plano != null ? String(plano) : null, run,
      ],
    );
  }

  // Contatos: reescreve do zero a cada sync.
  await db.query(`DELETE FROM ${s}.contatos WHERE cliente_id = $1`, [clienteId]);
  const contatos = comoObjeto(cli.contatos);
  for (const [tipo, lista] of Object.entries(contatos)) {
    for (const valor of comoLista(lista)) {
      if (typeof valor !== 'string' || !valor.trim()) continue;
      const norm = tipo === 'emails' ? valor.trim().toLowerCase() : TIPOS_TELEFONE.includes(tipo) ? normalizarTelefone(valor) : null;
      if (!norm) continue;
      await db.query(`INSERT INTO ${s}.contatos (cliente_id, tipo, valor, valor_norm) VALUES ($1, $2, $3, $4)`, [
        clienteId, tipo, valor.trim(), norm,
      ]);
    }
  }
  return contratos.length;
}

async function sincronizarPop(tenant: Tenant, pop: number) {
  const s = schemaDe(tenant);
  const run = randomUUID();
  const log = await pool.query(`INSERT INTO ${s}.sync_log (pop_id, status) VALUES ($1, 'rodando') RETURNING id`, [pop]);
  const logId = log.rows[0].id;

  let offset = 0;
  let total = Infinity;
  let clientes = 0;
  let contratos = 0;

  try {
    while (offset < total) {
      const resp = comoObjeto(
        await chamarSgp(tenant, 'clientes', { pop, limit: PAGINA, offset, omitir_titulos: true }),
      );
      const pag = comoObjeto(resp.paginacao);
      total = Number(pag.total ?? 0);
      const lista = comoLista(resp.clientes).map(comoObjeto);
      if (lista.length === 0) break;

      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        for (const cli of lista) {
          const n = await gravarCliente(db, s, pop, run, cli);
          if (n > 0) {
            clientes++;
            contratos += n;
          }
        }
        await db.query('COMMIT');
      } catch (e) {
        await db.query('ROLLBACK');
        throw e;
      } finally {
        db.release();
      }
      offset += lista.length;
    }

    // Remoção do que saiu do POP — com proteção contra sync vazio/parcial.
    const antes = await pool.query(`SELECT count(*)::int AS n FROM ${s}.contratos WHERE pop_id = $1`, [pop]);
    const anterior: number = antes.rows[0].n;
    let removidos = 0;
    if (contratos === 0 || contratos < anterior * 0.5) {
      console.warn(`[${tenant.id}/POP ${pop}] sync trouxe ${contratos} contratos (antes: ${anterior}); remoção suspensa`);
    } else {
      const del = await pool.query(`DELETE FROM ${s}.contratos WHERE pop_id = $1 AND sync_run <> $2`, [pop, run]);
      removidos = del.rowCount ?? 0;
      await pool.query(
        `DELETE FROM ${s}.clientes cl WHERE NOT EXISTS (SELECT 1 FROM ${s}.contratos ct WHERE ct.cliente_id = cl.id)`,
      );
    }

    await pool.query(
      `UPDATE ${s}.sync_log SET finalizado_em = now(), clientes = $2, contratos = $3, removidos = $4, status = 'ok' WHERE id = $1`,
      [logId, clientes, contratos, removidos],
    );
    console.log(`[${tenant.id}/POP ${pop}] ok: ${clientes} clientes, ${contratos} contratos, ${removidos} removidos`);
  } catch (e) {
    await pool.query(`UPDATE ${s}.sync_log SET finalizado_em = now(), status = 'erro', erro = $2 WHERE id = $1`, [
      logId,
      (e as Error).message.slice(0, 500),
    ]);
    throw e;
  }
}

let falhou = false;
for (const tenant of await tenantsAtivos()) {
  for (const pop of tenant.pops_permitidos) {
    try {
      await sincronizarPop(tenant, pop);
    } catch (e) {
      falhou = true;
      console.error(`[${tenant.id}/POP ${pop}] falhou: ${(e as Error).message}`);
    }
  }
}
await pool.end();
process.exit(falhou ? 1 : 0);
