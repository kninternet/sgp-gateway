/**
 * Sync da base própria: puxa os clientes de cada POP permitido de cada tenant
 * (Cliente – Listar, 100 por página), grava só contratos do POP e descarta senhas.
 * Faturas NÃO são gravadas — são sempre consultadas ao vivo.
 * Roda e encerra (PM2 cron diário, de madrugada). A identificação consulta o SGP
 * sob demanda e atualiza a base na hora; o sync diário cobre quem não conversou,
 * cancelamentos e mudanças de POP, e mantém a base de reserva para quando o SGP falhar.
 */
import { randomUUID } from 'node:crypto';
import { pool } from './db.js';
import { chamarSgp } from './sgp/client.js';
import { schemaDe, tenantsAtivos, type Tenant } from './tenants.js';
import { gravarCliente } from './base.js';
import { comoLista, comoObjeto } from './util.js';

const PAGINA = 100;

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
          const n = await gravarCliente(db, s, [pop], run, cli);
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
