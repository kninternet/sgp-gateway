/**
 * Envio por SMTP, uma conexão por tenant. Configuração no .env, por tenant (ID em maiúsculas):
 *   SMTP_URL_VIVANET=smtp://usuario%40dominio:senha@mail.dominio:587   (a senha nunca é registrada)
 *   EMAIL_FROM_VIVANET="Viva Net Telecom <naoresponda@vivanettelecom.com.br>"
 *   EMAIL_REPLY_TO_VIVANET=atendimento@vivanettelecom.com.br
 */
import nodemailer, { type Transporter } from 'nodemailer';
import type { Tenant } from '../tenants.js';

const conexoes = new Map<string, Transporter>();

function env(nome: string, tenant: Tenant): string | undefined {
  const v = process.env[`${nome}_${tenant.id.toUpperCase()}`];
  return v && v.trim() ? v.trim() : undefined;
}

export function smtpConfigurado(tenant: Tenant): boolean {
  return Boolean(env('SMTP_URL', tenant) && env('EMAIL_FROM', tenant));
}

export async function enviarEmail(tenant: Tenant, para: string, assunto: string, html: string, texto: string) {
  const url = env('SMTP_URL', tenant);
  const from = env('EMAIL_FROM', tenant);
  if (!url || !from) throw new Error(`SMTP não configurado para o tenant ${tenant.id}`);
  let t = conexoes.get(tenant.id);
  if (!t) {
    // A URL traz host, porta e credenciais; na 587 a conexão sobe para TLS (STARTTLS).
    const u = new URL(url);
    t = nodemailer.createTransport({
      host: u.hostname,
      port: Number(u.port || 587),
      secure: u.protocol === 'smtps:',
      requireTLS: u.protocol !== 'smtps:',
      auth: { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) },
      pool: true,
      maxConnections: 1,
    });
    conexoes.set(tenant.id, t);
  }
  await t.sendMail({ from, to: para, replyTo: env('EMAIL_REPLY_TO', tenant), subject: assunto, html, text: texto });
}

export function fecharSmtp() {
  for (const t of conexoes.values()) t.close();
  conexoes.clear();
}
