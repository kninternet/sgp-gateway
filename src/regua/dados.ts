/** Dados que alimentam os e-mails: faturas em aberto (ao vivo no SGP) e contato do cliente (base própria). */
import { pool } from '../db.js';
import { chamarSgp } from '../sgp/client.js';
import { schemaDe, type Tenant } from '../tenants.js';
import { comoLista, comoObjeto, linkPublico } from '../util.js';

export interface FaturaEmail {
  fatura_id: number;
  vencimento: string; // AAAA-MM-DD
  valor: number;
  link_boleto: string | null; // já no domínio público do tenant
  linha_digitavel: string | null;
  pix: string | null; // PIX copia e cola
}

export interface ContatoContrato {
  contrato_id: number;
  cliente_id: number;
  nome: string;
  email: string | null;
  plano: string | null;
  vencimento_dia: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

export async function faturasAbertas(tenant: Tenant, contratoId: number): Promise<FaturaEmail[]> {
  const resp = comoObjeto(
    await chamarSgp(tenant, 'titulos', {
      contrato: contratoId,
      status: 'abertos',
      ordenar: 'data_vencimento',
      ordenar_ordem: 'asc',
      limit: 250,
      empresa_cnpj: tenant.empresa_cnpj,
    }),
  );
  return comoLista(resp.titulos)
    .map(comoObjeto)
    .filter((t) => Number(t.clienteContrato) === contratoId) // trava: só títulos deste contrato
    .map((t) => ({
      fatura_id: Number(t.id),
      vencimento: String(t.dataVencimento ?? '').slice(0, 10),
      valor: Number(t.valorCorrigido ?? t.valor ?? 0),
      link_boleto: linkPublico(tenant.link_boleto_base, t.link),
      linha_digitavel: typeof t.linhaDigitavel === 'string' && t.linhaDigitavel ? t.linhaDigitavel : null,
      pix: typeof t.codigoPix === 'string' && t.codigoPix.length > 20 ? t.codigoPix : null,
    }))
    .filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f.vencimento));
}

export async function contatoDoContrato(tenant: Tenant, contratoId: number): Promise<ContatoContrato | null> {
  const s = schemaDe(tenant);
  const { rows } = await pool.query(
    `SELECT ct.id AS contrato_id, ct.cliente_id, cl.nome, ct.plano, ct.vencimento AS vencimento_dia,
            (SELECT array_agg(valor ORDER BY valor) FROM ${s}.contatos co
              WHERE co.cliente_id = ct.cliente_id AND co.tipo = 'emails') AS emails
       FROM ${s}.contratos ct JOIN ${s}.clientes cl ON cl.id = ct.cliente_id
      WHERE ct.id = $1 AND ct.pop_id = ANY($2::int[])`,
    [contratoId, tenant.pops_permitidos],
  );
  const r = rows[0];
  if (!r) return null;
  const email = ((r.emails as string[] | null) ?? []).map((e) => e.trim()).find((e) => EMAIL_RE.test(e)) ?? null;
  return {
    contrato_id: Number(r.contrato_id), cliente_id: Number(r.cliente_id), nome: String(r.nome ?? ''),
    email, plano: r.plano, vencimento_dia: r.vencimento_dia,
  };
}

/** "joao@gmail.com" → "jo***@gmail.com" (para respostas e logs). */
export function mascararEmail(e: string): string {
  const [u, d] = e.split('@');
  return (u.length <= 2 ? u[0] + '*' : u.slice(0, 2) + '***') + '@' + d;
}
