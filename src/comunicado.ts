/**
 * Comunicado de bloqueio (envio avulso, POP 100072 / Tribobó), por e-mail.
 *
 * Para cada contrato cobrável do POP, busca no SGP as faturas VENCIDAS (as mesmas da régua, com a mesma data de corte
 * REGUA_VENCIMENTO_MINIMO) e separa em:
 *   suspenso  → contrato Suspenso: "seu serviço está suspenso, regularize para religar"
 *   aviso     → contrato ativo, dentro dos 5 dias após o vencimento: "a suspensão está prevista para DD/MM"
 *   borda     → contrato ativo com mais de 5 dias de atraso: NÃO recebe nada; só aparece no relatório
 *
 * Cada contrato recebe o comunicado uma única vez (histórico em regua_envios), mesmo rodando de novo.
 * O envio para sozinho nos horários da régua (5h–6h59 e 15h–16h59, horário de São Paulo); basta rodar de novo depois.
 *
 * Uso:
 *   node --env-file=.env dist/src/comunicado.js                          simula: conta, gera CSV, não envia
 *   node --env-file=.env dist/src/comunicado.js --teste eu@x.com --contrato 740508
 *                                                                        envia os 2 modelos desse contrato para eu@x.com
 *   node --env-file=.env dist/src/comunicado.js --enviar [--limite 50]   envia de verdade
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { pool } from './db.js';
import { schemaDe, tenantsAtivos, type Tenant } from './tenants.js';
import { contatoDoContrato, faturasAbertas, mascararEmail, type FaturaEmail } from './regua/dados.js';
import { emailComunicadoAviso, emailComunicadoSuspenso } from './regua/modelos.js';
import { enviarEmail, fecharSmtp, smtpConfigurado } from './regua/smtp.js';
import { hojeSP } from './util.js';

const POP = 100072;
const DIAS_ATE_SUSPENDER = 5;
const ETAPAS = { suspenso: 'COMUNICADO_SUSPENSO', aviso: 'COMUNICADO_AVISO' } as const;

const args = process.argv.slice(2);
const valorArg = (nome: string) => { const i = args.indexOf(nome); return i >= 0 ? args[i + 1] : undefined; };
const ENVIAR = args.includes('--enviar');
const TESTE_PARA = valorArg('--teste');
const TESTE_CONTRATO = Number(valorArg('--contrato') || 0);
const LIMITE = Number(valorArg('--limite') || 0) || Infinity;
const VENCIMENTO_MINIMO = /^\d{4}-\d{2}-\d{2}$/.test(process.env.REGUA_VENCIMENTO_MINIMO ?? '') ? process.env.REGUA_VENCIMENTO_MINIMO! : '';

const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));
const somarDias = (iso: string, d: number) => new Date(Date.parse(iso + 'T12:00:00Z') + d * 86400000).toISOString().slice(0, 10);
const horaSP = () => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
const janelaDaRegua = () => args.includes('--agora') ? false : [5, 6, 15, 16].includes(horaSP());
const brl = (v: number) => v.toFixed(2).replace('.', ',');

type Grupo = 'suspenso' | 'aviso' | 'borda';
interface Item {
  contrato: number; status: string; grupo: Grupo; faturas: FaturaEmail[]; total: number;
  suspensao: string; foraDoCorte: number; email: string | null;
}

async function etapasAceitas(t: Tenant, contrato: number, fatura: number): Promise<void> {
  // Garante que o histórico aceita as etapas novas ANTES de enviar. Tudo é desfeito (ROLLBACK): nada fica gravado.
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    for (const e of Object.values(ETAPAS)) {
      await db.query(`INSERT INTO ${schemaDe(t)}.regua_envios (etapa, contrato_id, fatura_id, email, status) VALUES ($1, $2, $3, 'teste@teste.invalid', 'enviado')`, [e, contrato, fatura]);
    }
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }
}

async function jaRecebeu(t: Tenant, contrato: number): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM ${schemaDe(t)}.regua_envios WHERE contrato_id = $1 AND etapa = ANY($2::text[]) AND status = 'enviado' LIMIT 1`,
    [contrato, Object.values(ETAPAS)],
  );
  return rows.length > 0;
}

async function registrar(t: Tenant, etapa: string, contrato: number, fatura: number, email: string) {
  await pool.query(
    `INSERT INTO ${schemaDe(t)}.regua_envios (etapa, contrato_id, fatura_id, email, status) VALUES ($1, $2, $3, $4, 'enviado') ON CONFLICT DO NOTHING`,
    [etapa, contrato, fatura, email],
  );
}

async function levantar(t: Tenant, hoje: string): Promise<{ itens: Item[]; erros: number; soForaDoCorte: number }> {
  const { rows } = await pool.query<{ id: string; status: string }>(
    `SELECT id, trim(status) AS status FROM ${schemaDe(t)}.contratos
      WHERE pop_id = $1 AND trim(status) IN ('Ativo', 'Ativo V. Reduzida', 'Suspenso') ORDER BY id`,
    [POP],
  );
  const itens: Item[] = [];
  let erros = 0, soForaDoCorte = 0, n = 0;
  for (const r of rows) {
    if (++n % 100 === 0) console.log(`  ... ${n}/${rows.length} contratos consultados no SGP`);
    const contrato = Number(r.id);
    let abertas: FaturaEmail[];
    try { abertas = await faturasAbertas(t, contrato); } catch { erros++; continue; }
    const vencidas = abertas.filter((f) => f.vencimento < hoje);
    const consideradas = vencidas.filter((f) => !VENCIMENTO_MINIMO || f.vencimento >= VENCIMENTO_MINIMO);
    const foraDoCorte = vencidas.length - consideradas.length;
    if (!consideradas.length) { if (foraDoCorte) soForaDoCorte++; continue; }
    const suspensao = somarDias(consideradas[0].vencimento, DIAS_ATE_SUSPENDER);
    const grupo: Grupo = r.status === 'Suspenso' ? 'suspenso' : suspensao >= hoje ? 'aviso' : 'borda';
    const c = await contatoDoContrato(t, contrato);
    itens.push({
      contrato, status: r.status, grupo, faturas: consideradas, foraDoCorte, suspensao,
      total: consideradas.reduce((s, f) => s + f.valor, 0), email: c?.email ?? null,
    });
  }
  return { itens, erros, soForaDoCorte };
}

function relatorio(itens: Item[], erros: number, soForaDoCorte: number, hoje: string) {
  console.log(`\nComunicado de bloqueio · POP ${POP} · ${hoje}${VENCIMENTO_MINIMO ? ` · faturas vencidas a partir de ${VENCIMENTO_MINIMO}` : ''}`);
  for (const g of ['suspenso', 'aviso', 'borda'] as Grupo[]) {
    const gi = itens.filter((i) => i.grupo === g);
    const comEmail = gi.filter((i) => i.email).length;
    const total = gi.reduce((s, i) => s + i.total, 0);
    const rotulo = { suspenso: 'Suspensos (recebem)', aviso: 'Aviso de suspensão (recebem)', borda: 'Ativos com +5 dias de atraso (NÃO recebem)' }[g];
    console.log(`  ${rotulo.padEnd(44)} ${String(gi.length).padStart(4)} contratos · ${String(comEmail).padStart(4)} com e-mail · R$ ${brl(total)}`);
  }
  const vaoReceber = itens.filter((i) => i.grupo !== 'borda' && i.email).length;
  console.log(`  ${'Total de e-mails a enviar'.padEnd(44)} ${String(vaoReceber).padStart(4)} (≈ ${Math.ceil((vaoReceber * config.REGUA_INTERVALO_MS) / 3600000)} h de envio)`);
  if (soForaDoCorte) console.log(`  Contratos com dívida SÓ antes da data de corte (fora do envio): ${soForaDoCorte}`);
  if (erros) console.log(`  Contratos não consultados (erro no SGP): ${erros}`);

  const arq = join(process.env.HOME ?? '.', `comunicado-${POP}-${hoje}.csv`);
  const linhas = ['contrato;status;grupo;faturas;total;vencimento_mais_antigo;suspensao;email;faturas_fora_do_corte'];
  for (const i of itens) {
    linhas.push([i.contrato, i.status, i.grupo, i.faturas.length, brl(i.total), i.faturas[0].vencimento, i.suspensao,
      i.email ? mascararEmail(i.email) : 'sem e-mail', i.foraDoCorte].join(';'));
  }
  writeFileSync(arq, linhas.join('\n') + '\n', { mode: 0o600 });
  console.log(`  Lista completa: ${arq}`);
}

async function teste(t: Tenant, hoje: string) {
  const c = await contatoDoContrato(t, TESTE_CONTRATO);
  if (!c) throw new Error(`contrato ${TESTE_CONTRATO} não está na base`);
  const abertas = await faturasAbertas(t, TESTE_CONTRATO);
  const vencidas = abertas.filter((f) => f.vencimento < hoje);
  const fs = vencidas.length ? vencidas : abertas;
  if (!fs.length) throw new Error('contrato sem faturas em aberto para montar os modelos');
  const susp = somarDias(fs[0].vencimento, DIAS_ATE_SUSPENDER);
  for (const m of [emailComunicadoSuspenso(c, fs), emailComunicadoAviso(c, fs, susp >= hoje ? susp : hoje)]) {
    await enviarEmail(t, TESTE_PARA!, '[TESTE] ' + m.assunto, m.html, m.texto);
    console.log(`enviado para ${mascararEmail(TESTE_PARA!)}: ${m.assunto}`);
  }
}

async function enviar(t: Tenant, itens: Item[]) {
  const primeiro = itens.find((i) => i.grupo !== 'borda');
  if (!primeiro) { console.log('Nada a enviar.'); return; }
  await etapasAceitas(t, primeiro.contrato, primeiro.faturas[0].fatura_id);
  let enviados = 0, pulados = 0, erros = 0;
  for (const i of itens) {
    if (i.grupo === 'borda' || !i.email) continue;
    if (enviados >= LIMITE) { console.log(`Limite de ${LIMITE} atingido.`); break; }
    if (janelaDaRegua()) { console.log('Horário da régua de cobrança: parei aqui. Rode de novo depois das 7h ou das 17h; continua de onde parou.'); break; }
    if (await jaRecebeu(t, i.contrato)) { pulados++; continue; }
    const c = await contatoDoContrato(t, i.contrato);
    if (!c?.email) continue;
    const etapa = ETAPAS[i.grupo];
    const m = i.grupo === 'suspenso' ? emailComunicadoSuspenso(c, i.faturas) : emailComunicadoAviso(c, i.faturas, i.suspensao);
    try {
      await enviarEmail(t, c.email, m.assunto, m.html, m.texto);
      await registrar(t, etapa, i.contrato, i.faturas[0].fatura_id, c.email);
      enviados++;
      if (enviados % 10 === 0) console.log(`  ${enviados} enviados...`);
    } catch (e) {
      // Falha não vai para o histórico: o contrato é tentado de novo na próxima rodada.
      console.log(`  erro no contrato ${i.contrato}: ${(e as Error).message.slice(0, 160)}`);
      erros++;
    }
    await pausa(config.REGUA_INTERVALO_MS);
  }
  console.log(`\nEnvio: ${enviados} enviados · ${pulados} já tinham recebido · ${erros} erros`);
}

async function main() {
  const t = (await tenantsAtivos()).find((x) => x.id === 'vivanet');
  if (!t) throw new Error('tenant vivanet não encontrado');
  if (!t.pops_permitidos.includes(POP)) throw new Error(`POP ${POP} não pertence ao tenant`);
  const hoje = hojeSP();
  if ((ENVIAR || TESTE_PARA) && !smtpConfigurado(t)) throw new Error('SMTP não configurado');
  if (TESTE_PARA) { if (!TESTE_CONTRATO) throw new Error('use --contrato junto com --teste'); await teste(t, hoje); return; }
  if (ENVIAR && janelaDaRegua()) throw new Error('horário da régua de cobrança (5h–6h59 e 15h–16h59): rode fora dele');
  console.log(`Consultando o SGP (pode levar alguns minutos)...`);
  const { itens, erros, soForaDoCorte } = await levantar(t, hoje);
  relatorio(itens, erros, soForaDoCorte, hoje);
  if (ENVIAR) await enviar(t, itens);
  else console.log('\nSIMULAÇÃO: nada foi enviado. Para enviar, rode com --enviar.');
}

main()
  .catch((e) => { console.error('comunicado falhou:', (e as Error).message); process.exitCode = 1; })
  .finally(async () => { fecharSmtp(); await pool.end(); });
