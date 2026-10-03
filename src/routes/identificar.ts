import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { schemaDe } from '../tenants.js';
import { normalizarTelefone, soDigitos } from '../util.js';

const Body = z
  .object({ cpfcnpj: z.string().optional(), telefone: z.string().optional() })
  .refine((b) => b.cpfcnpj || b.telefone, { message: 'informe cpfcnpj ou telefone' });

/**
 * Identifica o cliente pela BASE PRÓPRIA (não chama o SGP).
 * Só devolve contratos dos POPs do canal.
 * Telefone só é aceito em canal com telefone verificado (permite_telefone);
 * no webchat qualquer um digita qualquer número, então lá só vale CPF/CNPJ.
 */
export async function rotaIdentificar(app: FastifyInstance) {
  app.post('/v1/identificar', async (req, reply) => {
    const { tenant, canal } = req.ctx!;
    const body = Body.parse(req.body);
    const s = schemaDe(tenant);

    let filtro: string;
    let valor: string;
    if (body.cpfcnpj) {
      valor = soDigitos(body.cpfcnpj);
      if (valor.length !== 11 && valor.length !== 14) {
        return reply.code(400).send({ erro: 'cpfcnpj_invalido' });
      }
      filtro = 'cl.cpfcnpj = $1';
    } else {
      if (!canal.permite_telefone) return reply.code(403).send({ erro: 'telefone_nao_permitido_neste_canal' });
      const tel = normalizarTelefone(body.telefone);
      if (!tel) return reply.code(400).send({ erro: 'telefone_invalido' });
      valor = tel;
      filtro = `cl.id IN (SELECT cliente_id FROM ${s}.contatos WHERE valor_norm = $1)`;
    }

    const { rows } = await pool.query(
      `SELECT cl.id AS cliente_id, cl.nome, ct.id AS contrato_id, ct.status, ct.plano, ct.vencimento
         FROM ${s}.clientes cl
         JOIN ${s}.contratos ct ON ct.cliente_id = cl.id AND ct.pop_id = ANY($2::int[])
        WHERE ${filtro}
        ORDER BY cl.id, ct.id
        LIMIT 20`,
      [valor, canal.pops],
    );

    const porCliente = new Map<number, { cliente_id: number; nome: string; contratos: unknown[] }>();
    for (const r of rows) {
      if (!porCliente.has(r.cliente_id)) porCliente.set(r.cliente_id, { cliente_id: r.cliente_id, nome: r.nome, contratos: [] });
      porCliente.get(r.cliente_id)!.contratos.push({
        contrato_id: r.contrato_id,
        status: r.status,
        plano: r.plano,
        vencimento: r.vencimento,
      });
    }
    const clientes = [...porCliente.values()];
    if (clientes.length === 1) req.auditoria!.cliente_id = clientes[0].cliente_id;

    return { encontrado: clientes.length > 0, clientes };
  });
}
