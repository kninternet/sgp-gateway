/**
 * Gravação na base própria, compartilhada pelo sync diário e pela consulta sob demanda.
 * Grava SOMENTE campos da lista abaixo: senhas (PPPoE, Wi-Fi, ONU, VoIP, central)
 * nunca são lidas, gravadas, logadas nem devolvidas.
 */
import type { PoolClient } from 'pg';
import { comoLista, comoObjeto, normalizarTelefone, soDigitos } from './util.js';

const TIPOS_TELEFONE = ['telefones', 'celulares', 'outros'];

/** Campos de contrato que podem sair do gateway (nada de senha, IP, MAC, ONU). */
export interface ContratoPublico {
  contrato_id: number;
  pop_id: number;
  status: string | null;
  motivo_status: string | null;
  plano: string | null;
  vencimento: string | null;
  conexao: 'online' | 'offline' | null;
  conexao_desde: string | null;
  /** Endereço de instalação (do serviço; se não houver, o do cliente). Só para o painel da equipe. */
  endereco: string | null;
  servicos_online: number;
  servicos_offline: number;
  /** Data do último pagamento deste contrato (AAAA-MM-DD), quando os títulos vierem na consulta. */
  ultimo_pagamento: string | null;
}

/** Dados do cliente que podem sair do gateway, além do nome. */
export interface ClientePublico {
  tipo_cliente: 'Pessoa Física' | 'Pessoa Jurídica' | null;
  data_cadastro: string | null;
}

const texto = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
};

/** Status da conexão do 1º serviço de internet (vem só com exibir_conexao). */
function conexaoDoContrato(c: Record<string, unknown>): Pick<ContratoPublico, 'conexao' | 'conexao_desde'> {
  for (const sv of comoLista(c.servicos).map(comoObjeto)) {
    const cx = comoObjeto(sv.conexao ?? comoObjeto(sv.onu).conexao);
    const st = texto(cx.status)?.toLowerCase();
    if (st === 'online' || st === 'offline') {
      return {
        conexao: st,
        conexao_desde: texto(st === 'online' ? cx.data_conexao : cx.data_desconexao),
      };
    }
  }
  return { conexao: null, conexao_desde: null };
}

/** "Rua X, 10 - apto 2 - Bairro, Cidade/UF". */
function enderecoTexto(e: Record<string, unknown>): string | null {
  const rua = [texto(e.logradouro), texto(e.numero)].filter(Boolean).join(', ');
  const local = [texto(e.bairro), [texto(e.cidade), texto(e.uf)].filter(Boolean).join('/')].filter(Boolean).join(', ');
  const partes = [rua, texto(e.complemento), local].filter(Boolean);
  return partes.length ? partes.join(' - ') : null;
}

function contagemServicos(c: Record<string, unknown>) {
  let online = 0, offline = 0;
  for (const sv of comoLista(c.servicos).map(comoObjeto)) {
    const st = texto(comoObjeto(sv.conexao ?? comoObjeto(sv.onu).conexao).status)?.toLowerCase();
    if (st === 'online') online++;
    else if (st === 'offline') offline++;
  }
  return { servicos_online: online, servicos_offline: offline };
}

/** Último pagamento entre os títulos do contrato (se a consulta trouxe títulos). */
function ultimoPagamento(cli: Record<string, unknown>, contratoId: number): string | null {
  let ultimo: string | null = null;
  for (const t of comoLista(cli.titulos).map(comoObjeto)) {
    if (Number(t.contrato ?? t.clienteContrato) !== contratoId) continue;
    const d = texto(t.dataPagamento)?.slice(0, 10) ?? null;
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d) && (!ultimo || d > ultimo)) ultimo = d;
  }
  return ultimo;
}

export function clientePublico(cli: Record<string, unknown>): ClientePublico {
  const tipo = texto(cli.tipo)?.toLowerCase() ?? '';
  return {
    tipo_cliente: !tipo ? null : /^j|jur/.test(tipo) ? 'Pessoa Jurídica' : 'Pessoa Física',
    data_cadastro: texto(cli.dataCadastro ?? cli.data_cadastro),
  };
}

/** Contratos do cliente nos POPs informados, só com campos públicos. */
export function contratosPublicos(cli: Record<string, unknown>, pops: number[]): ContratoPublico[] {
  return comoLista(cli.contratos)
    .map(comoObjeto)
    .filter((c) => pops.includes(Number(c.pop_id)))
    .map((c) => ({
      contrato_id: Number(c.id),
      pop_id: Number(c.pop_id),
      status: texto(c.status),
      motivo_status: texto(c.motivo_status),
      plano: texto(comoObjeto(comoObjeto(comoLista(c.servicos)[0]).plano).descricao),
      vencimento: texto(c.vencimento),
      ...conexaoDoContrato(c),
      endereco: enderecoTexto(comoObjeto(comoObjeto(comoLista(c.servicos)[0]).endereco)) ?? enderecoTexto(comoObjeto(cli.endereco)),
      ...contagemServicos(c),
      ultimo_pagamento: ultimoPagamento(cli, Number(c.id)),
    }))
    .filter((c) => Number.isSafeInteger(c.contrato_id));
}

/**
 * Grava cliente + contratos dos POPs informados + contatos.
 * Devolve quantos contratos foram gravados (0 = cliente sem contrato nesses POPs, nada gravado).
 */
export async function gravarCliente(
  db: PoolClient,
  s: string,
  pops: number[],
  run: string,
  cli: Record<string, unknown>,
): Promise<number> {
  const clienteId = Number(cli.id);
  if (!Number.isSafeInteger(clienteId)) return 0;

  const contratos = comoLista(cli.contratos).map(comoObjeto).filter((c) => pops.includes(Number(c.pop_id)));
  if (contratos.length === 0) return 0;

  await db.query(
    `INSERT INTO ${s}.clientes (id, nome, cpfcnpj, tipo, sync_run, atualizado_em)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (id) DO UPDATE SET nome = EXCLUDED.nome, cpfcnpj = EXCLUDED.cpfcnpj,
       tipo = EXCLUDED.tipo, sync_run = EXCLUDED.sync_run, atualizado_em = now()`,
    [clienteId, String(cli.nome ?? ''), soDigitos(cli.cpfcnpj), cli.tipo ?? null, run],
  );

  for (const c of contratos) {
    const plano = comoObjeto(comoObjeto(comoLista(c.servicos)[0]).plano).descricao ?? null;
    await db.query(
      `INSERT INTO ${s}.contratos (id, cliente_id, pop_id, status, motivo_status, vencimento, forma_cobranca, plano, sync_run, atualizado_em)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (id) DO UPDATE SET cliente_id = EXCLUDED.cliente_id, pop_id = EXCLUDED.pop_id,
         status = EXCLUDED.status, motivo_status = EXCLUDED.motivo_status, vencimento = EXCLUDED.vencimento,
         forma_cobranca = EXCLUDED.forma_cobranca, plano = EXCLUDED.plano, sync_run = EXCLUDED.sync_run, atualizado_em = now()`,
      [
        Number(c.id), clienteId, Number(c.pop_id), c.status ?? null, c.motivo_status || null,
        c.vencimento != null ? String(c.vencimento) : null,
        c.formaCobranca != null ? String(c.formaCobranca) : null,
        plano != null ? String(plano) : null, run,
      ],
    );
  }

  // Contatos: reescreve do zero a cada gravação.
  await db.query(`DELETE FROM ${s}.contatos WHERE cliente_id = $1`, [clienteId]);
  for (const [tipo, lista] of Object.entries(comoObjeto(cli.contatos))) {
    for (const valor of comoLista(lista)) {
      if (typeof valor !== 'string' || !valor.trim()) continue;
      const norm = tipo === 'emails' ? valor.trim().toLowerCase() : TIPOS_TELEFONE.includes(tipo) ? normalizarTelefone(valor) : null;
      if (!norm) continue;
      await db.query(`INSERT INTO ${s}.contatos (cliente_id, tipo, valor, valor_norm) VALUES ($1, $2, $3, $4)`, [
        clienteId, tipo, valor.trim(), norm,
      ]);
    }
  }
  return contratos.length;
}
