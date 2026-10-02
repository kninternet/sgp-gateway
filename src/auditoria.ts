import type { FastifyReply, FastifyRequest } from 'fastify';
import { pool } from './db.js';

/** Registra toda chamada autenticada. Falha de auditoria não derruba a resposta. */
export async function registrarAuditoria(req: FastifyRequest, reply: FastifyReply) {
  if (!req.ctx) return;
  const a = req.auditoria ?? {};
  try {
    await pool.query(
      `INSERT INTO gateway.auditoria (tenant_id, canal_id, rota, cliente_id, contrato_id, status, duracao_ms, erro)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        req.ctx.tenant.id,
        req.ctx.canal.id,
        req.routeOptions.url ?? req.url,
        a.cliente_id ?? null,
        a.contrato_id ?? null,
        reply.statusCode,
        Math.round(reply.elapsedTime),
        a.erro ?? null,
      ],
    );
  } catch (e) {
    req.log.error({ err: e }, 'falha ao gravar auditoria');
  }
}
