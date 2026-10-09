/**
 * Régua de e-mails (roda todo dia de manhã pelo PM2 e encerra):
 *   1. Boas-vindas para contratos que aparecem ativos pela primeira vez (o sync das 3h atualiza os status).
 *      Na primeira execução, os contratos já ativos são só registrados ("semeados"), sem envio.
 *   2. Régua de cobrança: para cada fatura em aberto, a etapa do dia (D-5, D-1, D0, D+2, D+4).
 * Cada etapa de cada fatura sai uma única vez (índice único em regua_envios).
 *
 * Uso:
 *   node --env-file=.env dist/src/regua.js                         envia
 *   node --env-file=.env dist/src/regua.js --simular               mostra o que enviaria, sem enviar nem registrar
 *   node --env-file=.env dist/src/regua.js --teste eu@x.com --contrato 740508
 *                                                                  envia TODOS os modelos desse contrato para eu@x.com
 */
import { config } from './config.js';
import { pool } from './db.js';
import { schemaDe, tenantsAtivos, type Tenant } from './tenants.js';
import { contatoDoContrato, faturasAbertas, mascararEmail } from './regua/dados.js';
import { DIAS_DA_ETAPA, emailBoasVindas, emailFatura, emailLista, type EtapaRegua } from './regua/modelos.js';
import { enviarEmail, fecharSmtp, smtpConfigurado } from './regua/smtp.js';
import { hojeSP } from './util.js';

const args = process.argv.slice(2);
const SIMULAR = args.includes('--simular');
const valorArg = (nome: string) => { const i = args.indexOf(nome); return i >= 0 ? args[i + 1] : undefined; };
const TESTE_PARA = valorArg('--teste');
const TESTE_CONTRATO = Number(valorArg('--contrato') || 0);

// Data de corte (AAAA-MM-DD): faturas que vencem antes dela ficam fora da régua de cobrança.
const VENCIMENTO_MINIMO = /^\d{4}-\d{2}-\d{2}$/.test(process.env.REGUA_VENCIMENTO_MINIMO ?? '') ? process.env.REGUA_VENCIMENTO_MINIMO! : '';
const ATIVO = `trim(status) IN ('Ativo', 'Ativo V. Reduzida')`;
const COBRAVEL = `trim(status) IN ('Ativo', 'Ativo V. Reduzida', 'Suspenso')`;
const ETAPA_POR_DIA = new Map(Object.entries(DIAS_DA_ETAPA).map(([e, d]) => [d, e as EtapaRegua]));
const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));
const diasEntre = (de: string, ate: string) => Math.round((Date.parse(ate + 'T12:00:00Z') - Date.parse(de + 'T12:00:00Z')) / 86400000);

async function registrar(t: Tenant, etapa: string, contrato: number, fatura: number | null, email: string, status: string, erro?: string) {
  await pool.query(
    `INSERT INTO ${schemaDe(t)}.regua_envios (etapa, contrato_id, fatura_id, email, status, erro) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING`,
    [etapa, contrato, fatura, email, status, erro ?? null],
  );
}

async function enviar(t: Tenant, para: string, m: { assunto: string; html: string; texto: string }) {
  await enviarEmail(t, para, m.assunto, m.html, m.texto);
  await pausa(config.REGUA_INTERVALO_MS);
}

async function boasVindas(t: Tenant, resumo: Record<string, number>) {
  const s = schemaDe(t);
  const { rows: ativos } = await pool.query<{ id: string }>(
    `SELECT ct.id FROM ${s}.contratos ct WHERE ct.pop_id = ANY($1::int[]) AND ${ATIVO}
       AND NOT EXISTS (SELECT 1 FROM ${s}.regua_ativos ra WHERE ra.contrato_id = ct.id)`,
    [t.pops_permitidos],
  );
  const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int AS n FROM ${s}.regua_ativos`);
  if (n === 0) {
    // Primeira execução: a base atual não recebe boas-vindas.
    if (!SIMULAR) {
      await pool.query(
        `INSERT INTO ${s}.regua_ativos (contrato_id, boas_vindas) SELECT unnest($1::bigint[]), 'semeado' ON CONFLICT DO NOTHING`,
        [ativos.map((a) => a.id)],
      );
    }
    resumo.semeados = ativos.length;
    return;
  }
  for (const a of ativos) {
    const id = Number(a.id);
    const c = await contatoDoContrato(t, id);
    let status = 'sem_email';
    if (c?.email) {
      if (SIMULAR) { resumo.BOAS_VINDAS = (resumo.BOAS_VINDAS ?? 0) + 1; continue; }
      try {
        await enviar(t, c.email, emailBoasVindas(c));
        await registrar(t, 'BOAS_VINDAS', id, null, c.email, 'enviado');
        status = 'enviado';
        resumo.BOAS_VINDAS = (resumo.BOAS_VINDAS ?? 0) + 1;
      } catch (e) {
        status = 'erro';
        await registrar(t, 'BOAS_VINDAS', id, null, c.email, 'erro', (e as Error).message.slice(0, 300));
        resumo.erros = (resumo.erros ?? 0) + 1;
      }
    } else if (SIMULAR) { resumo.sem_email = (resumo.sem_email ?? 0) + 1; continue; }
    if (status !== 'erro') {
      await pool.query(`INSERT INTO ${s}.regua_ativos (contrato_id, boas_vindas) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, status]);
    }
    if (status === 'sem_email') resumo.sem_email = (resumo.sem_email ?? 0) + 1;
  }
}

async function cobranca(t: Tenant, resumo: Record<string, number>) {
  const s = schemaDe(t);
  const hoje = hojeSP();
  const { rows } = await pool.query<{ id: string }>(
    `SELECT DISTINCT ct.id FROM ${s}.contratos ct
       JOIN ${s}.contatos co ON co.cliente_id = ct.cliente_id AND co.tipo = 'emails'
      WHERE ct.pop_id = ANY($1::int[]) AND ${COBRAVEL} ORDER BY ct.id`,
    [t.pops_permitidos],
  );
  for (const r of rows) {
    const id = Number(r.id);
    let faturas;
    try { faturas = await faturasAbertas(t, id); } catch { resumo.erros_sgp = (resumo.erros_sgp ?? 0) + 1; continue; }
    const doDia = faturas
      .filter((f) => !VENCIMENTO_MINIMO || f.vencimento >= VENCIMENTO_MINIMO)
      .map((f) => ({ f, etapa: ETAPA_POR_DIA.get(diasEntre(f.vencimento, hoje)) }))
      .filter((x) => x.etapa);
    if (!doDia.length) continue;
    const c = await contatoDoContrato(t, id);
    if (!c?.email) continue;
    for (const { f, etapa } of doDia) {
      const ja = await pool.query(
        `SELECT 1 FROM ${s}.regua_envios WHERE origem = 'regua' AND status = 'enviado' AND etapa = $1 AND contrato_id = $2 AND fatura_id = $3`,
        [etapa, id, f.fatura_id],
      );
      if (ja.rowCount) continue;
      resumo[etapa!] = (resumo[etapa!] ?? 0) + 1;
      if (SIMULAR) continue;
      try {
        await enviar(t, c.email, emailFatura(etapa!, c, f));
        await registrar(t, etapa!, id, f.fatura_id, c.email, 'enviado');
      } catch (e) {
        await registrar(t, etapa!, id, f.fatura_id, c.email, 'erro', (e as Error).message.slice(0, 300));
        resumo.erros = (resumo.erros ?? 0) + 1;
      }
    }
  }
}

async function teste(t: Tenant) {
  const c = await contatoDoContrato(t, TESTE_CONTRATO);
  if (!c) throw new Error(`contrato ${TESTE_CONTRATO} não está na base deste tenant`);
  const faturas = await faturasAbertas(t, TESTE_CONTRATO);
  if (!faturas.length) throw new Error('contrato sem faturas em aberto para montar os modelos');
  const para = TESTE_PARA!;
  const modelos = [
    ...(['PRE_FATURA_D5', 'VENCE_AMANHA', 'VENCE_HOJE', 'ATRASO_D2', 'PRE_BLOQUEIO_D4', 'FATURA'] as const).map((e) => emailFatura(e, c, faturas[0])),
    emailLista(c, faturas.slice(0, 3)),
    emailBoasVindas(c),
  ];
  for (const m of modelos) {
    await enviar(t, para, { ...m, assunto: '[TESTE] ' + m.assunto });
    console.log(`enviado para ${mascararEmail(para)}: ${m.assunto}`);
  }
}

async function main() {
  for (const t of await tenantsAtivos()) {
    if (!smtpConfigurado(t) && !SIMULAR) { console.log(`[${t.id}] SMTP não configurado; pulando`); continue; }
    if (TESTE_PARA) { await teste(t); continue; }
    const resumo: Record<string, number> = {};
    await boasVindas(t, resumo);
    await cobranca(t, resumo);
    console.log(`[${t.id}] ${SIMULAR ? 'SIMULAÇÃO ' : ''}${hojeSP()}${VENCIMENTO_MINIMO ? ` (vencimentos a partir de ${VENCIMENTO_MINIMO})` : ''}`, JSON.stringify(resumo));
  }
}

main()
  .catch((e) => { console.error('régua falhou:', (e as Error).message); process.exitCode = 1; })
  .finally(async () => { fecharSmtp(); await pool.end(); });
