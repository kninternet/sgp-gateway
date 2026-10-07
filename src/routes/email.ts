/**
 * Envio manual de e-mail ao cliente (botões "enviar fatura" e "enviar faturas em aberto").
 * O destino é SEMPRE o e-mail do cadastro do cliente; a chamada não escolhe destinatário.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { contatoDoContrato, faturasAbertas, mascararEmail } from '../regua/dados.js';
import { emailFatura, emailLista } from '../regua/modelos.js';
import { enviarEmail, smtpConfigurado } from '../regua/smtp.js';
import { schemaDe } from '../tenants.js';
import { contratoPermitido } from '../trava.js';

const Fatura = z.object({ contrato_id: z.coerce.number().int().positive(), fatura_id: z.coerce.number().int().positive() });
const Lista = z.object({ contrato_id: z.coerce.number().int().positive() });

export async function rotaEmail(app: FastifyInstance) {
  async function preparar(req: any, reply: any, contratoId: number) {
    const { tenant, canal } = req.ctx!;
    if (!canal.permite_email) { reply.code(403).send({ erro: 'email_nao_permitido_neste_canal' }); return null; }
    if (!smtpConfigurado(tenant)) { reply.code(503).send({ erro: 'smtp_nao_configurado' }); return null; }
    const permitido = await contratoPermitido(tenant, canal, contratoId);
    if (!permitido) { reply.code(404).send({ erro: 'contrato_nao_encontrado' }); return null; }
    req.auditoria!.cliente_id = permitido.cliente_id;
    const c = await contatoDoContrato(tenant, contratoId);
    if (!c?.email) { reply.code(422).send({ erro: 'cliente_sem_email' }); return null; }
    return { tenant, c };
  }

  async function registrar(tenant: any, etapa: string, contrato: number, fatura: number | null, email: string) {
    await pool.query(
      `INSERT INTO ${schemaDe(tenant)}.regua_envios (etapa, contrato_id, fatura_id, email, status, origem) VALUES ($1, $2, $3, $4, 'enviado', 'manual')`,
      [etapa, contrato, fatura, email],
    );
  }

  app.post('/v1/email/fatura', async (req, reply) => {
    const b = Fatura.parse(req.body);
    const ok = await preparar(req, reply, b.contrato_id);
    if (!ok) return reply;
    const f = (await faturasAbertas(ok.tenant, b.contrato_id)).find((x) => x.fatura_id === b.fatura_id);
    if (!f) return reply.code(404).send({ erro: 'fatura_nao_encontrada' });
    const m = emailFatura('FATURA', ok.c, f);
    await enviarEmail(ok.tenant, ok.c.email!, m.assunto, m.html, m.texto);
    await registrar(ok.tenant, 'FATURA', b.contrato_id, b.fatura_id, ok.c.email!);
    return { ok: true, email: mascararEmail(ok.c.email!) };
  });

  app.post('/v1/email/lista', async (req, reply) => {
    const b = Lista.parse(req.body);
    const ok = await preparar(req, reply, b.contrato_id);
    if (!ok) return reply;
    const faturas = await faturasAbertas(ok.tenant, b.contrato_id);
    if (!faturas.length) return reply.code(404).send({ erro: 'sem_faturas_em_aberto' });
    const m = emailLista(ok.c, faturas);
    await enviarEmail(ok.tenant, ok.c.email!, m.assunto, m.html, m.texto);
    await registrar(ok.tenant, 'LISTA', b.contrato_id, null, ok.c.email!);
    return { ok: true, email: mascararEmail(ok.c.email!), faturas: faturas.length };
  });
}
