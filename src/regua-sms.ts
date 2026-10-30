/**
 * Régua de cobrança por SMS (roda todo dia às 9h pelo PM2 e encerra).
 *   VENCE_HOJE         D0  fatura em aberto
 *   PRE_BLOQUEIO_D4    D+4 fatura em aberto
 *   SUSPENSO_D6        D+6 contrato Suspenso (não sai se a reativação foi enviada nos 3 dias anteriores)
 *   REATIVACAO_AAAAMM  todo dia REATIVACAO_DIA (20), contrato Suspenso, uma vez por mês
 * Um SMS por contrato por dia (a etapa mais forte do dia). Cada etapa de cada fatura sai uma única vez.
 * Mesmo público da régua de e-mail: POPs do tenant e faturas a partir de REGUA_VENCIMENTO_MINIMO.
 * Celular: contatos do tipo "celulares", DDD + 9 + 8 dígitos. Cada SMS leva um link pessoal da Área.
 *
 * Sem SMS_ATIVO=true no .env, nada é enviado: a execução só simula e mostra o resumo.
 *
 * Uso:
 *   node --env-file=.env dist/src/regua-sms.js                          envia (se SMS_ATIVO=true)
 *   node --env-file=.env dist/src/regua-sms.js --simular                mostra o que enviaria
 *   node --env-file=.env dist/src/regua-sms.js --teste 21999999999 --contrato 740508
 *                                                                        envia os 4 modelos desse contrato para o número
 */
import { config } from './config.js';
import { pool } from './db.js';
import { schemaDe, tenantsAtivos, type Tenant } from './tenants.js';
import { faturasAbertas, type FaturaEmail } from './regua/dados.js';
import { brl, primeiroNome } from './regua/modelos.js';
import { criarLinkArea } from './regua/links.js';
import { LIMITE_SMS, enviarSms, saldoSms, semAcento, statusSms } from './regua/sms.js';
import { hojeSP } from './util.js';

const args = process.argv.slice(2);
const valorArg = (nome: string) => { const i = args.indexOf(nome); return i >= 0 ? args[i + 1] : undefined; };
const TESTE_PARA = valorArg('--teste');
const TESTE_CONTRATO = Number(valorArg('--contrato') || 0);
const SIMULAR = args.includes('--simular') || (!config.SMS_ATIVO && !TESTE_PARA);

const VENCIMENTO_MINIMO = /^\d{4}-\d{2}-\d{2}$/.test(process.env.REGUA_VENCIMENTO_MINIMO ?? '') ? process.env.REGUA_VENCIMENTO_MINIMO! : '';
const COBRAVEL = `trim(ct.status) IN ('Ativo', 'Ativo V. Reduzida', 'Suspenso')`;
const CELULAR_RE = '^[1-9][0-9]9[0-9]{8}$';
const DIAS_SMS: Record<number, EtapaSms> = { 0: 'VENCE_HOJE', 4: 'PRE_BLOQUEIO_D4', 6: 'SUSPENSO_D6' };
const PRIORIDADE = ['REATIVACAO', 'SUSPENSO_D6', 'PRE_BLOQUEIO_D4', 'VENCE_HOJE'] as const;

type EtapaSms = 'VENCE_HOJE' | 'PRE_BLOQUEIO_D4' | 'SUSPENSO_D6' | 'REATIVACAO';
interface Candidato { etapa: EtapaSms; chave: string; fatura: FaturaEmail | null }

const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));
const diasEntre = (de: string, ate: string) => Math.round((Date.parse(ate + 'T12:00:00Z') - Date.parse(de + 'T12:00:00Z')) / 86400000);
const somarDias = (iso: string, d: number) => new Date(Date.parse(iso + 'T12:00:00Z') + d * 86400000).toISOString().slice(0, 10);

/** O contrato pode ter etapa de SMS hoje? Evita consultar o SGP para quem certamente não tem. */
function podeTerEtapaHoje(diaVencimento: string | null, hoje: string, suspenso: boolean): boolean {
  if (suspenso && Number(hoje.slice(8, 10)) === config.REATIVACAO_DIA) return true;
  const dia = Number(String(diaVencimento ?? '').replace(/\D/g, ''));
  if (!dia || dia > 31) return true; // sem o dia no cadastro: consulta o SGP
  const [a, m] = hoje.split('-').map(Number);
  for (const desloc of [0, -1]) {
    const d = new Date(Date.UTC(a, m - 1 + desloc, 1, 12));
    const venc = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
    if ([0, 4, 6].includes(diasEntre(venc, hoje))) return true;
  }
  return false;
}

/** Nome para o SMS: primeiro nome, sem acento, até `max` letras. */
const nomeSms = (nome: string, max = 12) => semAcento(primeiroNome(nome)).slice(0, max) || 'cliente';

/** Monta o texto da etapa dentro de 160 caracteres (encurta o nome e, no D+6, tira a frase final se preciso). */
export function textoSms(etapa: EtapaSms, nomeCompleto: string, valor: number, link: string): string {
  const montar = (n: string, completo: boolean) => {
    switch (etapa) {
      case 'VENCE_HOJE': return `VIVA NET: Ola ${n}, sua fatura de ${brl(valor)} vence hoje. Pague com PIX em 1 toque: ${link}`;
      case 'PRE_BLOQUEIO_D4': return `VIVA NET: ${n}, sua internet sera bloqueada amanha. Fatura de ${brl(valor)} em aberto. Pague no PIX: ${link}`;
      case 'SUSPENSO_D6': return `VIVA NET: ${n}, sua internet esta suspensa. Pague no PIX e religa na hora: ${link}${completo ? ' Ja pagou? Desconsidere.' : ''}`;
      case 'REATIVACAO': return `VIVA NET: ${n}, regularize sua internet e volte a navegar hoje mesmo! Pague no PIX e religa na hora: ${link}`;
    }
  };
  for (const [max, completo] of [[12, true], [8, true], [12, false], [8, false], [0, false]] as const) {
    const t = semAcento(montar(max ? nomeSms(nomeCompleto, max) : 'cliente', completo));
    if (t.length <= LIMITE_SMS) return t;
  }
  throw new Error(`texto da etapa ${etapa} passa de ${LIMITE_SMS} caracteres`);
}

async function jaEnviado(t: Tenant, chave: string, contrato: number, fatura: number | null): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM ${schemaDe(t)}.sms_envios WHERE status = 'enviado' AND etapa = $1 AND contrato_id = $2 AND coalesce(fatura_id, 0) = $3`,
    [chave, contrato, fatura ?? 0],
  );
  return (r.rowCount ?? 0) > 0;
}

async function reativacaoRecente(t: Tenant, contrato: number): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM ${schemaDe(t)}.sms_envios WHERE status = 'enviado' AND etapa LIKE 'REATIVACAO_%' AND contrato_id = $1
        AND enviado_em > now() - interval '3 days'`,
    [contrato],
  );
  return (r.rowCount ?? 0) > 0;
}

async function registrar(t: Tenant, chave: string, contrato: number, fatura: number | null, numero: string,
  link: string | null, ref: string | null, status: string, erro?: string) {
  await pool.query(
    `INSERT INTO ${schemaDe(t)}.sms_envios (etapa, contrato_id, fatura_id, numero, link_codigo, ref_id, status, erro)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
    [chave, contrato, fatura, numero, link, ref, status, erro ?? null],
  );
}

/** Atualiza a entrega dos SMS do dia anterior (uma consulta por execução, como a Loca exige). */
async function atualizarEntregas(t: Tenant, resumo: Record<string, number>) {
  const hoje = hojeSP();
  try {
    const itens = await statusSms(`${somarDias(hoje, -1)}T00:00:00`, `${hoje}T00:00:00`);
    for (const it of itens) {
      if (!it.ref) continue;
      const r = await pool.query(
        `UPDATE ${schemaDe(t)}.sms_envios SET entrega = $2, entrega_desc = $3, entrega_em = now() WHERE ref_id = $1`,
        [it.ref, it.status.slice(0, 5), it.descricao.slice(0, 200)],
      );
      if (r.rowCount) resumo['entrega_' + (it.status || '?')] = (resumo['entrega_' + (it.status || '?')] ?? 0) + 1;
    }
  } catch (e) {
    console.log(`[${t.id}] status de entrega indisponível: ${(e as Error).message}`);
  }
}

async function cobranca(t: Tenant, resumo: Record<string, number>) {
  const s = schemaDe(t);
  const hoje = hojeSP();
  const mes = hoje.slice(0, 7).replace('-', '');
  const diaReativacao = Number(hoje.slice(8, 10)) === config.REATIVACAO_DIA;
  const { rows } = await pool.query<{ id: string; status: string; nome: string; vencimento: string | null; celular: string | null }>(
    `SELECT ct.id, trim(ct.status) AS status, cl.nome, ct.vencimento,
            (SELECT min(co.valor_norm) FROM ${s}.contatos co
              WHERE co.cliente_id = ct.cliente_id AND co.tipo = 'celulares' AND co.valor_norm ~ '${CELULAR_RE}') AS celular
       FROM ${s}.contratos ct JOIN ${s}.clientes cl ON cl.id = ct.cliente_id
      WHERE ct.pop_id = ANY($1::int[]) AND ${COBRAVEL} ORDER BY ct.id`,
    [t.pops_permitidos],
  );
  const exemplos = new Set<string>();
  for (const r of rows) {
    const id = Number(r.id);
    const suspenso = r.status === 'Suspenso';
    if (!r.celular) { resumo.sem_celular = (resumo.sem_celular ?? 0) + 1; continue; }
    if (!podeTerEtapaHoje(r.vencimento, hoje, suspenso)) continue;

    let faturas: FaturaEmail[];
    try { faturas = await faturasAbertas(t, id); } catch { resumo.erros_sgp = (resumo.erros_sgp ?? 0) + 1; continue; }
    faturas = faturas.filter((f) => !VENCIMENTO_MINIMO || f.vencimento >= VENCIMENTO_MINIMO);
    if (!faturas.length) continue;

    // Etapas possíveis hoje; fica só a mais forte (um SMS por contrato por dia).
    const candidatos: Candidato[] = [];
    if (diaReativacao && suspenso) candidatos.push({ etapa: 'REATIVACAO', chave: `REATIVACAO_${mes}`, fatura: null });
    for (const f of faturas) {
      const etapa = DIAS_SMS[diasEntre(f.vencimento, hoje)];
      if (!etapa) continue;
      if (etapa === 'SUSPENSO_D6' && !suspenso) continue;
      candidatos.push({ etapa, chave: etapa, fatura: f });
    }
    candidatos.sort((a, b) => PRIORIDADE.indexOf(a.etapa) - PRIORIDADE.indexOf(b.etapa));

    let escolhido: Candidato | null = null;
    for (const c of candidatos) {
      if (await jaEnviado(t, c.chave, id, c.fatura?.fatura_id ?? null)) continue;
      if (c.etapa === 'SUSPENSO_D6' && await reativacaoRecente(t, id)) { resumo.d6_pulado_reativacao = (resumo.d6_pulado_reativacao ?? 0) + 1; continue; }
      escolhido = c;
      break;
    }
    if (!escolhido) continue;

    const valor = escolhido.fatura ? escolhido.fatura.valor : faturas.reduce((soma, f) => soma + f.valor, 0);
    resumo[escolhido.etapa] = (resumo[escolhido.etapa] ?? 0) + 1;
    if (SIMULAR) {
      if (!exemplos.has(escolhido.etapa)) {
        exemplos.add(escolhido.etapa);
        console.log(`  exemplo ${escolhido.etapa}: ${textoSms(escolhido.etapa, r.nome, valor, 'https://area.vivanettelecom.com.br/p/XXXXXXXX')}`);
      }
      continue;
    }
    let link: { codigo: string; url: string } | null = null;
    try {
      link = await criarLinkArea(t, id, escolhido.chave, 'sms', config.LINK_AREA_DIAS);
      const ref = await enviarSms(r.celular, textoSms(escolhido.etapa, r.nome, valor, link.url), `Regua ${escolhido.chave}`);
      await registrar(t, escolhido.chave, id, escolhido.fatura?.fatura_id ?? null, r.celular, link.codigo, ref, 'enviado');
      resumo.enviados = (resumo.enviados ?? 0) + 1;
    } catch (e) {
      await registrar(t, escolhido.chave, id, escolhido.fatura?.fatura_id ?? null, r.celular, link?.codigo ?? null, null, 'erro', (e as Error).message.slice(0, 300));
      resumo.erros = (resumo.erros ?? 0) + 1;
    }
    await pausa(config.SMS_INTERVALO_MS);
  }
}

async function teste(t: Tenant) {
  const numero = String(TESTE_PARA).replace(/\D/g, '');
  const { rows } = await pool.query<{ nome: string }>(
    `SELECT cl.nome FROM ${schemaDe(t)}.contratos ct JOIN ${schemaDe(t)}.clientes cl ON cl.id = ct.cliente_id
      WHERE ct.id = $1 AND ct.pop_id = ANY($2::int[])`,
    [TESTE_CONTRATO, t.pops_permitidos],
  );
  if (!rows[0]) throw new Error(`contrato ${TESTE_CONTRATO} não está na base deste tenant`);
  const faturas = await faturasAbertas(t, TESTE_CONTRATO);
  const valor = faturas[0]?.valor ?? 99.9;
  for (const etapa of ['VENCE_HOJE', 'PRE_BLOQUEIO_D4', 'SUSPENSO_D6', 'REATIVACAO'] as const) {
    const link = await criarLinkArea(t, TESTE_CONTRATO, 'TESTE', 'sms', 1);
    const texto = textoSms(etapa, rows[0].nome, valor, link.url);
    const ref = await enviarSms(numero, texto, `Teste ${etapa}`);
    console.log(`enviado ${etapa} (${texto.length} caracteres, ref ${ref}): ${texto}`);
    await pausa(1500);
  }
}

async function main() {
  if (TESTE_PARA && !TESTE_CONTRATO) throw new Error('use --contrato junto com --teste');
  for (const t of await tenantsAtivos()) {
    if (!t.area_link_base) { console.log(`[${t.id}] sem area_link_base; pulando`); continue; }
    if (TESTE_PARA) { await teste(t); continue; }
    const resumo: Record<string, number> = {};
    if (!SIMULAR) {
      const saldo = await saldoSms();
      console.log(`[${t.id}] saldo Loca: ${saldo ?? 'indisponível'}`);
      if (saldo !== null && saldo <= 0) { console.log(`[${t.id}] sem saldo na Loca; nada enviado`); continue; }
      await atualizarEntregas(t, resumo);
    }
    await cobranca(t, resumo);
    const modo = SIMULAR ? (config.SMS_ATIVO ? 'SIMULAÇÃO ' : 'SIMULAÇÃO (SMS_ATIVO desligado) ') : '';
    console.log(`[${t.id}] SMS ${modo}${hojeSP()}${VENCIMENTO_MINIMO ? ` (vencimentos a partir de ${VENCIMENTO_MINIMO})` : ''}`, JSON.stringify(resumo));
  }
}

main()
  .catch((e) => { console.error('régua SMS falhou:', (e as Error).message); process.exitCode = 1; })
  .finally(async () => { await pool.end(); });
