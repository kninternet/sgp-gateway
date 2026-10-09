import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientePublico, contratosPublicos, gravarCliente, type ClientePublico, type ContratoPublico } from '../base.js';
import { nomesDosPops } from '../pops.js';
import { config } from '../config.js';
import { pool } from '../db.js';
import { chamarSgp } from '../sgp/client.js';
import { statusCrm, type StatusCrm } from '../sgp/crm.js';
import { schemaDe, type Canal, type Tenant } from '../tenants.js';
import { comoLista, comoObjeto, normalizarTelefone, soDigitos, variantesTelefone } from '../util.js';

const Body = z
  .object({ cpfcnpj: z.string().optional(), telefone: z.string().optional() })
  .refine((b) => b.cpfcnpj || b.telefone, { message: 'informe cpfcnpj ou telefone' });

interface ClienteResposta extends Partial<ClientePublico> {
  cliente_id: number;
  nome: string;
  contratos: Array<Partial<ContratoPublico> & { contrato_id: number; pop_nome?: string | null }>;
  crm: StatusCrm | null;
}

/** 11 dígitos → NNN.NNN.NNN-NN; 14 → NN.NNN.NNN/NNNN-NN. */
export function docFormatado(d: string): string {
  return d.length === 11
    ? d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')
    : d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
}

/**
 * Clientes do SGP pelo filtro informado, testando cada forma do valor até achar.
 * Os títulos vêm junto (só para calcular o último pagamento; nunca são gravados).
 */
export async function clientesNoSgp(tenant: Tenant, campo: 'cpfcnpj' | 'telefone', valores: string[]): Promise<Record<string, unknown>[]> {
  for (const valor of valores) {
    const resp = comoObjeto(
      await chamarSgp(tenant, 'clientes', { [campo]: valor, exibir_conexao: true }, undefined, config.SGP_IDENTIFICAR_TIMEOUT_MS),
    );
    const lista = comoLista(resp.clientes).map(comoObjeto);
    if (lista.length > 0) return lista;
  }
  return [];
}

/**
 * Atualiza a base própria com o que veio do SGP: grava os contratos dos POPs do tenant
 * e remove, só deste cliente, os contratos que saíram desses POPs.
 */
export async function atualizarBase(tenant: Tenant, clientes: Record<string, unknown>[]) {
  const s = schemaDe(tenant);
  const pops = tenant.pops_permitidos;
  const run = randomUUID();
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    for (const cli of clientes) {
      const clienteId = Number(cli.id);
      if (!Number.isSafeInteger(clienteId)) continue;
      await gravarCliente(db, s, pops, run, cli);
      const ids = comoLista(cli.contratos)
        .map(comoObjeto)
        .filter((c) => pops.includes(Number(c.pop_id)))
        .map((c) => Number(c.id))
        .filter(Number.isSafeInteger);
      await db.query(
        `DELETE FROM ${s}.contratos WHERE cliente_id = $1 AND pop_id = ANY($2::int[]) AND NOT (id = ANY($3::bigint[]))`,
        [clienteId, pops, ids],
      );
      await db.query(
        `DELETE FROM ${s}.clientes cl WHERE cl.id = $1
            AND NOT EXISTS (SELECT 1 FROM ${s}.contratos ct WHERE ct.cliente_id = cl.id)`,
        [clienteId],
      );
    }
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }
}

/** Busca na base própria (telefone, ou reserva quando o SGP falha). */
async function clientesNaBase(
  tenant: Tenant,
  canal: Canal,
  filtro: string,
  valores: string[],
): Promise<ClienteResposta[]> {
  const s = schemaDe(tenant);
  const { rows } = await pool.query(
    `SELECT cl.id AS cliente_id, cl.nome, ct.id AS contrato_id, ct.pop_id, ct.status, ct.motivo_status, ct.plano, ct.vencimento
       FROM ${s}.clientes cl
       JOIN ${s}.contratos ct ON ct.cliente_id = cl.id AND ct.pop_id = ANY($2::int[])
      WHERE ${filtro}
      ORDER BY cl.id, ct.id
      LIMIT 20`,
    [valores, canal.pops],
  );
  const porCliente = new Map<number, ClienteResposta>();
  for (const r of rows) {
    if (!porCliente.has(r.cliente_id)) {
      porCliente.set(r.cliente_id, { cliente_id: r.cliente_id, nome: r.nome, contratos: [], crm: null });
    }
    porCliente.get(r.cliente_id)!.contratos.push({
      contrato_id: r.contrato_id,
      pop_id: r.pop_id,
      status: r.status,
      motivo_status: r.motivo_status,
      plano: r.plano,
      vencimento: r.vencimento,
      conexao: null,
      conexao_desde: null,
      endereco: null,
      servicos_online: 0,
      servicos_offline: 0,
      ultimo_pagamento: null,
    });
  }
  return [...porCliente.values()];
}

/**
 * Identifica o cliente.
 * - CPF/CNPJ: consulta o SGP NA HORA (só aquele documento), aplica a trava de POP,
 *   atualiza a base própria e responde. Se o SGP falhar ou demorar, responde pela base.
 * - Telefone: só pela base própria, e só em canal com telefone verificado.
 * Em ambos, anexa o status do funil do CRM (banco do SGP, somente leitura) quando disponível,
 * e o último cadastro feito pelo Vitor para o documento (lead).
 */
export async function rotaIdentificar(app: FastifyInstance) {
  app.post('/v1/identificar', async (req, reply) => {
    const { tenant, canal } = req.ctx!;
    const body = Body.parse(req.body);
    const s = schemaDe(tenant);

    let clientes: ClienteResposta[] = [];
    let fonte: 'sgp' | 'base' = 'sgp';
    let doc: string | null = null;
    let telefones: string[] = [];

    // Busca ao vivo no SGP; se ele falhar, ou não conhecer o valor, usa a base própria.
    const buscar = async (campo: 'cpfcnpj' | 'telefone', valores: string[], filtroBase: string) => {
      try {
        const doSgp = await clientesNoSgp(tenant, campo, valores);
        if (doSgp.length > 0) await atualizarBase(tenant, doSgp);
        const pops = await nomesDosPops(tenant);
        clientes = doSgp
          .map((cli) => ({
            cliente_id: Number(cli.id),
            nome: String(cli.nome ?? ''),
            ...clientePublico(cli),
            contratos: contratosPublicos(cli, canal.pops).map((c) => ({ ...c, pop_nome: pops.get(c.pop_id) ?? null })),
            crm: null,
          }))
          .filter((c) => Number.isSafeInteger(c.cliente_id) && c.contratos.length > 0);
        fonte = 'sgp';
        if (doSgp.length === 0) {
          const daBase = await clientesNaBase(tenant, canal, filtroBase, valores);
          if (daBase.length > 0) { clientes = daBase; fonte = 'base'; }
        }
      } catch (e) {
        req.log.warn({ err: (e as Error).message }, 'identificação: SGP indisponível, usando a base');
        clientes = await clientesNaBase(tenant, canal, filtroBase, valores);
        fonte = 'base';
      }
    };

    if (body.cpfcnpj) {
      doc = soDigitos(body.cpfcnpj);
      if (doc.length !== 11 && doc.length !== 14) return reply.code(400).send({ erro: 'cpfcnpj_invalido' });
      await buscar('cpfcnpj', [doc, docFormatado(doc)], 'cl.cpfcnpj = ANY($1::text[])');
    } else {
      // Telefone só em canal com número verificado (WhatsApp); no site qualquer um digita qualquer número.
      if (!canal.permite_telefone) return reply.code(403).send({ erro: 'telefone_nao_permitido_neste_canal' });
      const tel = normalizarTelefone(body.telefone);
      if (!tel) return reply.code(400).send({ erro: 'telefone_invalido' });
      telefones = variantesTelefone(tel);
      await buscar('telefone', telefones, `cl.id IN (SELECT cliente_id FROM ${s}.contatos WHERE valor_norm = ANY($1::text[]))`);
    }

    // Último cadastro feito pelo Vitor para este documento (lead no CRM, ainda sem contrato ou não).
    let cadastro: { lead_id: number; cliente_id: number; nome: string | null; criado_em: string; crm: StatusCrm | null } | null = null;
    if (doc || telefones.length) {
      const { rows } = await pool.query<{ lead_id: number; cliente_id: number; nome: string | null; criado_em: Date }>(
        `SELECT id AS lead_id, cliente_id, nome, criado_em FROM ${s}.cadastros
          WHERE ${doc ? 'cpfcnpj = $1' : 'celular_norm = ANY($1::text[])'}
            AND status = 'ok' AND cliente_id IS NOT NULL ORDER BY id DESC LIMIT 1`,
        [doc ?? telefones],
      );
      if (rows[0]) {
        cadastro = {
          lead_id: rows[0].lead_id, cliente_id: rows[0].cliente_id, nome: rows[0].nome,
          criado_em: rows[0].criado_em.toISOString(), crm: null,
        };
      }
    }

    // Status do funil do CRM (somente leitura; vazio se o banco do SGP não estiver configurado ou falhar).
    const crm = await statusCrm([...clientes.map((c) => c.cliente_id), ...(cadastro ? [cadastro.cliente_id] : [])]);
    for (const c of clientes) c.crm = crm.get(c.cliente_id) ?? null;
    if (cadastro) cadastro.crm = crm.get(cadastro.cliente_id) ?? null;

    if (clientes.length === 1) req.auditoria!.cliente_id = clientes[0].cliente_id;
    else if (clientes.length === 0 && cadastro) req.auditoria!.cliente_id = cadastro.cliente_id;

    return { encontrado: clientes.length > 0, fonte, clientes, cadastro };
  });
}
