/**
 * Área do Cliente (site): login por CPF/CNPJ + código enviado ao e-mail DO CADASTRO.
 * O cliente nunca informa o e-mail: é isso que impede acessar as faturas de outra pessoa só com o CPF.
 * Depois do login, as telas usam /v1/faturas, /v1/pix e /v1/segunda-via apenas para os contratos
 * devolvidos aqui (a trava fica no app area-vivanet, na sessão assinada).
 */
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { contatoDoContrato, mascararEmail } from '../regua/dados.js';
import { emailCodigoArea } from '../regua/modelos.js';
import { enviarEmail, smtpConfigurado } from '../regua/smtp.js';
import { schemaDe, type Canal, type Tenant } from '../tenants.js';
import { soDigitos } from '../util.js';
import { atualizarBase, clientesNoSgp, docFormatado } from './identificar.js';

const VALIDADE_MIN = 15;
const MAX_TENTATIVAS = 5;
const MAX_ENVIOS_HORA = 3;

const Doc = z
  .string()
  .transform((v) => soDigitos(v))
  .refine((d) => d.length === 11 || d.length === 14, 'documento_invalido');
const hash = (email: string, codigo: string) => createHash('sha256').update(`${email}:${codigo}`).digest('hex');

interface Titular {
  cliente_id: number;
  nome: string;
  contratos: number[];
  email: string | null;
}

async function contratosNaBase(tenant: Tenant, canal: Canal, doc: string) {
  const s = schemaDe(tenant);
  const { rows } = await pool.query<{ contrato_id: string; cliente_id: string; nome: string }>(
    `SELECT ct.id AS contrato_id, cl.id AS cliente_id, cl.nome
       FROM ${s}.clientes cl JOIN ${s}.contratos ct ON ct.cliente_id = cl.id
      WHERE cl.cpfcnpj = $1 AND ct.pop_id = ANY($2::int[])
      ORDER BY ct.id`,
    [doc, canal.pops],
  );
  return rows;
}

/**
 * Contratos do documento nos POPs do canal e o e-mail do cadastro.
 * Com atualizarDoSgp, relê o cliente no SGP antes (e-mail e contratos do momento); se o SGP falhar, usa a base.
 */
async function titular(tenant: Tenant, canal: Canal, doc: string, atualizarDoSgp: boolean): Promise<Titular | null> {
  if (atualizarDoSgp) {
    try {
      const clientes = await clientesNoSgp(tenant, 'cpfcnpj', [doc, docFormatado(doc)]);
      if (clientes.length > 0) await atualizarBase(tenant, clientes);
    } catch {
      // SGP indisponível: segue com o que estiver na base própria.
    }
  }
  const rows = await contratosNaBase(tenant, canal, doc);
  if (rows.length === 0) return null;

  let email: string | null = null;
  for (const r of rows) {
    const c = await contatoDoContrato(tenant, Number(r.contrato_id));
    if (c?.email) { email = c.email.trim().toLowerCase(); break; }
  }
  return {
    cliente_id: Number(rows[0].cliente_id),
    nome: String(rows[0].nome ?? ''),
    contratos: rows.map((r) => Number(r.contrato_id)),
    email,
  };
}

const primeiroNome = (nome: string) => {
  const p = nome.trim().split(/\s+/)[0] ?? '';
  return p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : '';
};

export async function rotaArea(app: FastifyInstance) {
  app.post('/v1/area/codigo', async (req, reply) => {
    const { tenant, canal } = req.ctx!;
    if (!canal.permite_area) return reply.code(403).send({ ok: false, erro: 'nao_permitido_neste_canal' });
    if (!smtpConfigurado(tenant)) return reply.code(503).send({ ok: false, erro: 'indisponivel' });
    const p = z.object({ cpfcnpj: Doc }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ ok: false, erro: 'documento_invalido' });

    const t = await titular(tenant, canal, p.data.cpfcnpj, true);
    if (!t) return reply.code(404).send({ ok: false, erro: 'nao_encontrado' });
    req.auditoria!.cliente_id = t.cliente_id;
    if (!t.email) return reply.code(422).send({ ok: false, erro: 'sem_email' });

    const s = schemaDe(tenant);
    const { rows: [{ n }] } = await pool.query(
      `SELECT count(*)::int AS n FROM ${s}.email_codigos WHERE email = $1 AND criado_em > now() - interval '1 hour'`,
      [t.email],
    );
    if (n >= MAX_ENVIOS_HORA) return reply.code(429).send({ ok: false, erro: 'muitas_tentativas' });

    const codigo = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await pool.query(
      `INSERT INTO ${s}.email_codigos (email, codigo_hash, canal_id, expira_em)
       VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
      [t.email, hash(t.email, codigo), canal.id, VALIDADE_MIN],
    );
    const m = emailCodigoArea(codigo);
    await enviarEmail(tenant, t.email, m.assunto, m.html, m.texto);
    return { ok: true, email_mascarado: mascararEmail(t.email), validade_min: VALIDADE_MIN };
  });

  app.post('/v1/area/verificar', async (req, reply) => {
    const { tenant, canal } = req.ctx!;
    if (!canal.permite_area) return reply.code(403).send({ ok: false, erro: 'nao_permitido_neste_canal' });
    const p = z.object({ cpfcnpj: Doc, codigo: z.string().trim().regex(/^\d{6}$/) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ ok: false, erro: 'codigo_invalido' });

    const t = await titular(tenant, canal, p.data.cpfcnpj, false);
    if (!t?.email) return reply.code(401).send({ ok: false, erro: 'codigo_invalido' });
    req.auditoria!.cliente_id = t.cliente_id;

    const s = schemaDe(tenant);
    // Só códigos emitidos POR ESTE CANAL (um código do formulário de cadastro não abre a Área).
    const { rows } = await pool.query<{ id: string; codigo_hash: string; tentativas: number; verificado_em: Date | null }>(
      `SELECT id, codigo_hash, tentativas, verificado_em FROM ${s}.email_codigos
        WHERE email = $1 AND canal_id = $2 AND expira_em > now()
        ORDER BY criado_em DESC LIMIT 1`,
      [t.email, canal.id],
    );
    const c = rows[0];
    if (!c || c.verificado_em) return reply.code(401).send({ ok: false, erro: 'codigo_invalido' }); // uso único
    if (c.tentativas >= MAX_TENTATIVAS) return reply.code(429).send({ ok: false, erro: 'muitas_tentativas' });

    await pool.query(`UPDATE ${s}.email_codigos SET tentativas = tentativas + 1 WHERE id = $1`, [c.id]);
    const ok = timingSafeEqual(Buffer.from(c.codigo_hash, 'hex'), Buffer.from(hash(t.email, p.data.codigo), 'hex'));
    if (!ok) return reply.code(401).send({ ok: false, erro: 'codigo_invalido' });
    await pool.query(`UPDATE ${s}.email_codigos SET verificado_em = now() WHERE id = $1`, [c.id]);

    return { ok: true, nome: primeiroNome(t.nome), contratos: t.contratos };
  });
}
