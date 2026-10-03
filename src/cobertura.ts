import { pool } from './db.js';
import { schemaDe, type Canal, type Tenant } from './tenants.js';
import { normalizarTexto, soDigitos } from './util.js';

export interface Endereco {
  cep: string;
  logradouro: string;
  bairro: string;
  cidade: string;
  uf: string;
}

export type ResultadoCobertura =
  | { atende: false; motivo: 'cep_invalido' | 'cep_nao_encontrado' | 'viacep_indisponivel' | 'fora_da_area'; endereco?: Endereco }
  | {
      atende: true;
      pop_id: number;
      endereco: Endereco;
      planos: { nome: string; valor: number; sgp_plano_id: number | null }[];
      vencimentos: number[];
      taxa_instalacao: number;
    };

async function buscarCep(cep: string): Promise<Endereco | 'nao_encontrado' | 'indisponivel'> {
  try {
    const base = process.env.VIACEP_BASE || 'https://viacep.com.br';
    const r = await fetch(`${base}/ws/${cep}/json/`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return 'indisponivel';
    const d = (await r.json()) as Record<string, string | boolean>;
    if (d.erro) return 'nao_encontrado';
    return {
      cep,
      logradouro: String(d.logradouro || ''),
      bairro: String(d.bairro || ''),
      cidade: String(d.localidade || ''),
      uf: String(d.uf || ''),
    };
  } catch {
    return 'indisponivel';
  }
}

/** CEP → ViaCEP → bairro/cidade na cobertura de um dos POPs do canal. */
export async function consultarCobertura(tenant: Tenant, canal: Canal, cepBruto: unknown): Promise<ResultadoCobertura> {
  const cep = soDigitos(cepBruto);
  if (cep.length !== 8) return { atende: false, motivo: 'cep_invalido' };

  const end = await buscarCep(cep);
  if (end === 'nao_encontrado') return { atende: false, motivo: 'cep_nao_encontrado' };
  if (end === 'indisponivel') return { atende: false, motivo: 'viacep_indisponivel' };

  const s = schemaDe(tenant);
  const { rows } = await pool.query<{ pop_id: number; cidade: string; bairro: string }>(
    `SELECT pop_id, cidade, bairro FROM ${s}.cobertura WHERE ativo AND pop_id = ANY($1::int[])`,
    [canal.pops],
  );
  const cidade = normalizarTexto(end.cidade);
  const bairro = normalizarTexto(end.bairro);
  const achou = rows.find((r) => normalizarTexto(r.cidade) === cidade && normalizarTexto(r.bairro) === bairro);
  if (!achou) return { atende: false, motivo: 'fora_da_area', endereco: end };

  const [cfg, planos] = await Promise.all([
    pool.query<{ vencimentos: number[]; taxa_instalacao: string }>(
      `SELECT vencimentos, taxa_instalacao FROM ${s}.pops_venda WHERE pop_id = $1`, [achou.pop_id]),
    pool.query<{ nome: string; valor: string; sgp_plano_id: number | null }>(
      `SELECT nome, valor, sgp_plano_id FROM ${s}.planos_venda WHERE ativo AND pop_id = $1 ORDER BY valor`, [achou.pop_id]),
  ]);
  const c = cfg.rows[0];
  if (!c || planos.rows.length === 0) return { atende: false, motivo: 'fora_da_area', endereco: end };

  return {
    atende: true,
    pop_id: achou.pop_id,
    endereco: end,
    planos: planos.rows.map((p) => ({ nome: p.nome, valor: Number(p.valor), sgp_plano_id: p.sgp_plano_id })),
    vencimentos: c.vencimentos,
    taxa_instalacao: Number(c.taxa_instalacao),
  };
}
