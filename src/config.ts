import { z } from 'zod';

const ligado = z.string().optional().transform((v) => ['1', 'true', 'sim', 'yes'].includes(String(v ?? '').trim().toLowerCase()));

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().default(3200),
  ALLOWED_IPS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
  LOG_LEVEL: z.string().default('info'),
  SGP_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  // Banco do SGP, somente leitura (status do funil do CRM). Opcional.
  SGP_DB_URL: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),
  // Tempo máximo da consulta sob demanda antes de cair para a base própria.
  SGP_IDENTIFICAR_TIMEOUT_MS: z.coerce.number().int().positive().default(6000),
  // Intervalo entre e-mails da régua (respeita o limite de envio do SMTP).
  REGUA_INTERVALO_MS: z.coerce.number().int().nonnegative().default(4000),
  // Dia do mês da reativação (e-mail e SMS para todos os contratos suspensos).
  REATIVACAO_DIA: z.coerce.number().int().min(1).max(28).default(20),

  // SMS (Loca Plataforma). Sem SMS_ATIVO=true, a régua por SMS só simula: nada é enviado.
  SMS_ATIVO: ligado,
  LOCA_URL: z.string().url().default('https://api.locaplataforma.com.br'),
  LOCA_TOKEN: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),
  LOCA_TIPO: z.string().default('SHORTCODE'),
  SMS_INTERVALO_MS: z.coerce.number().int().nonnegative().default(500),
  // Dias de validade do link pessoal da Área enviado por SMS.
  LINK_AREA_DIAS: z.coerce.number().int().min(1).max(60).default(10),
});

export const config = schema.parse(process.env);

/** Lê o token SGP do tenant a partir do nome da variável de ambiente. Nunca logar o retorno. */
export function tokenDoTenant(envName: string): string {
  const v = process.env[envName];
  if (!v) throw new Error(`Variável de token SGP ausente: ${envName}`);
  return v;
}
