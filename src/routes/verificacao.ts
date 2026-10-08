/**
 * Verificação de e-mail por código (formulário e Vitor). Não condiciona o cadastro:
 * o resultado só é registrado (cadastros.email_verificado) e aparece na cópia ao atendimento.
 */
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { emailCodigo } from '../regua/modelos.js';
import { enviarEmail, smtpConfigurado } from '../regua/smtp.js';
import { schemaDe, type Tenant } from '../tenants.js';

const VALIDADE_MIN = 15;
const MAX_TENTATIVAS = 5;
const MAX_ENVIOS_HORA = 3;

const Email = z.string().trim().toLowerCase().email().max(120).refine((e) => /^[\x20-\x7E]+$/.test(e), 'email_invalido');
const hash = (email: string, codigo: string) => createHash('sha256').update(`${email}:${codigo}`).digest('hex');

/** E-mail confirmado por código nos últimos 7 dias? */
export async function emailVerificado(tenant: Tenant, email: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM ${schemaDe(tenant)}.email_codigos WHERE email = $1 AND verificado_em > now() - interval '7 days' LIMIT 1`,
    [email.trim().toLowerCase()],
  );
  return Boolean(rowCount);
}

export async function rotaVerificacao(app: FastifyInstance) {
  app.post('/v1/email/codigo', async (req, reply) => {
    const { tenant, canal } = req.ctx!;
    if (!canal.permite_cadastro) return reply.code(403).send({ erro: 'nao_permitido_neste_canal' });
    if (!smtpConfigurado(tenant)) return reply.code(503).send({ erro: 'smtp_nao_configurado' });
    const parsed = z.object({ email: Email }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ erro: 'email_invalido' });
    const { email } = parsed.data;
    const s = schemaDe(tenant);

    const { rows: [{ n }] } = await pool.query(
      `SELECT count(*)::int AS n FROM ${s}.email_codigos WHERE email = $1 AND criado_em > now() - interval '1 hour'`, [email]);
    if (n >= MAX_ENVIOS_HORA) return reply.code(429).send({ erro: 'muitos_envios' });

    const codigo = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await pool.query(
      `INSERT INTO ${s}.email_codigos (email, codigo_hash, canal_id, expira_em) VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
      [email, hash(email, codigo), canal.id, VALIDADE_MIN],
    );
    const m = emailCodigo(codigo);
    await enviarEmail(tenant, email, m.assunto, m.html, m.texto);
    return { ok: true, validade_min: VALIDADE_MIN };
  });

  app.post('/v1/email/verificar', async (req, reply) => {
    const { tenant, canal } = req.ctx!;
    if (!canal.permite_cadastro) return reply.code(403).send({ erro: 'nao_permitido_neste_canal' });
    const parsed = z.object({ email: Email, codigo: z.string().trim().regex(/^\d{6}$/) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ verificado: false, erro: 'dados_invalidos' });
    const { email, codigo } = parsed.data;
    const s = schemaDe(tenant);

    const { rows } = await pool.query<{ id: string; codigo_hash: string; tentativas: number; verificado_em: Date | null }>(
      `SELECT id, codigo_hash, tentativas, verificado_em FROM ${s}.email_codigos
        WHERE email = $1 AND expira_em > now() ORDER BY criado_em DESC LIMIT 1`, [email]);
    const c = rows[0];
    if (!c) return { verificado: false, erro: 'codigo_expirado' };
    if (c.verificado_em) return { verificado: true };
    if (c.tentativas >= MAX_TENTATIVAS) return { verificado: false, erro: 'muitas_tentativas' };

    await pool.query(`UPDATE ${s}.email_codigos SET tentativas = tentativas + 1 WHERE id = $1`, [c.id]);
    const ok = timingSafeEqual(Buffer.from(c.codigo_hash, 'hex'), Buffer.from(hash(email, codigo), 'hex'));
    if (!ok) return { verificado: false, erro: 'codigo_incorreto', restantes: MAX_TENTATIVAS - c.tentativas - 1 };
    await pool.query(`UPDATE ${s}.email_codigos SET verificado_em = now() WHERE id = $1`, [c.id]);
    return { verificado: true };
  });
}
