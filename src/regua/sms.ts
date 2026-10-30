/**
 * Envio de SMS pela Loca Plataforma (https://api.locaplataforma.com.br).
 * O token fica só no .env (LOCA_TOKEN) e nunca é registrado em log.
 * Limite da Loca: 160 caracteres por mensagem, sem mensagens em várias partes.
 */
import { config } from '../config.js';

export const LIMITE_SMS = 160;

/** Tira acentos e qualquer caractere fora do ASCII básico (emoji, aspas curvas). */
export function semAcento(texto: string): string {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
}

function token(): string {
  if (!config.LOCA_TOKEN) throw new Error('LOCA_TOKEN ausente no .env');
  return config.LOCA_TOKEN;
}

async function lerJson(r: Response): Promise<any> {
  try { return await r.json(); } catch { return null; }
}

/** Envia um SMS e devolve o REF_ID da Loca. O número é DDD + telefone (11 dígitos). */
export async function enviarSms(numero: string, texto: string, assunto: string): Promise<string> {
  const conteudo = semAcento(texto);
  if (conteudo.length > LIMITE_SMS) throw new Error(`SMS com ${conteudo.length} caracteres (limite ${LIMITE_SMS})`);
  if (!/^\d{11}$/.test(numero)) throw new Error('número fora do formato DDD + 9 + 8 dígitos');
  const r = await fetch(`${config.LOCA_URL}/servicesms/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: token(), numbers: numero, content: conteudo, type_service: config.LOCA_TIPO, subject: assunto }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await lerJson(r);
  if (!r.ok || j?.status !== 'success' || j?.data === null || j?.data === undefined) {
    throw new Error(`Loca recusou: ${String(j?.message ?? 'HTTP ' + r.status).slice(0, 200)}`);
  }
  return String(Array.isArray(j.data) ? j.data[0] : j.data);
}

/** Saldo da conta (consulta permitida a cada 1 minuto). Null se não der para consultar. */
export async function saldoSms(): Promise<number | null> {
  try {
    const r = await fetch(`${config.LOCA_URL}/servicesms/getbalance/${encodeURIComponent(token())}`, { signal: AbortSignal.timeout(15000) });
    const j = await lerJson(r);
    return j?.status === 'success' && Number.isFinite(Number(j.data)) ? Number(j.data) : null;
  } catch {
    return null;
  }
}

export interface StatusSms { ref: string; numero: string; status: string; descricao: string }

/**
 * Status das mensagens de um intervalo (AAAA-MM-DDTHH:mm:ss). A Loca aceita 1 consulta a cada 5 minutos;
 * a régua consulta uma vez por execução, o dia anterior inteiro, com paginação por cursor.
 */
export async function statusSms(inicio: string, fim: string): Promise<StatusSms[]> {
  const itens: StatusSms[] = [];
  let depois = '';
  for (let pagina = 0; pagina < 20; pagina++) {
    const q = new URLSearchParams({ start: inicio, end: fim, limit: '5000' });
    if (depois) q.set('afterId', depois);
    const r = await fetch(`${config.LOCA_URL}/servicesms/getstatus/${encodeURIComponent(token())}?${q}`, { signal: AbortSignal.timeout(30000) });
    const j = await lerJson(r);
    if (j?.status !== 'success' || !j.data) throw new Error(`status da Loca indisponível: ${String(j?.message ?? 'HTTP ' + r.status).slice(0, 200)}`);
    for (const it of Array.isArray(j.data.items) ? j.data.items : []) {
      if (it?.tipo_envio && it.tipo_envio !== 'S') continue; // só mensagens de saída
      itens.push({ ref: String(it.codigo_campanha ?? ''), numero: String(it.celular ?? ''), status: String(it.status_envio ?? ''), descricao: String(it.status_desc ?? '') });
    }
    if (!j.data.hasMore) break;
    depois = String(j.data.nextAfterCodigo ?? '');
    if (!depois) break;
  }
  return itens;
}
