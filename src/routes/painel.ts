/**
 * Painel do atendente (Dashboard App do Chatwoot): ficha completa de um contrato em uma chamada.
 * Mesmas travas de sempre: só contratos dos POPs do canal, lista fechada de campos, nenhuma senha
 * (PPPoE, Wi-Fi, ONU) e, no banco do SGP, só a tabela radacct.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientePublico, contratosPublicos } from '../base.js';
import { pool } from '../db.js';
import { nomesDosPops } from '../pops.js';
import { faturasAbertas } from '../regua/dados.js';
import { chamarSgp, pdfContrato, TIPOS_DOCUMENTO } from '../sgp/client.js';
import { sessoesRadius, statusCrm } from '../sgp/crm.js';
import { schemaDe } from '../tenants.js';
import { contratoPermitido } from '../trava.js';
import { comoLista, comoObjeto, diasAtraso, hojeSP } from '../util.js';

const Contrato = z.object({ contrato_id: z.coerce.number().int().positive() });
const Documento = Contrato.extend({ tipo: z.enum(TIPOS_DOCUMENTO) });

const texto = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v).trim() || null);
const menosDias = (dias: number) => {
  const d = new Date(`${hojeSP()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
};
// Executa sem derrubar a ficha inteira: cada bloco que falhar volta como null.
const seguro = async <T>(f: () => Promise<T>): Promise<T | null> => { try { return await f(); } catch { return null; } };

export async function rotaPainel(app: FastifyInstance) {
  app.post('/v1/painel/contrato', async (req, reply) => {
    const { tenant, canal } = req.ctx!;
    if (!canal.permite_painel) return reply.code(403).send({ erro: 'painel_nao_permitido_neste_canal' });
    const { contrato_id } = Contrato.parse(req.body);
    const permitido = await contratoPermitido(tenant, canal, contrato_id);
    if (!permitido) return reply.code(404).send({ erro: 'contrato_nao_encontrado' });
    req.auditoria!.cliente_id = permitido.cliente_id;
    const s = schemaDe(tenant);

    // Documento do cliente (base própria) para a consulta ao vivo no SGP.
    const { rows: [base] } = await pool.query(`SELECT cpfcnpj FROM ${s}.clientes WHERE id = $1`, [permitido.cliente_id]);

    const [cliSgp, listaContrato, abertas, pagas, acesso, ocorrencias, envios, contatos, crm, pops] = await Promise.all([
      seguro(async () => comoLista(comoObjeto(await chamarSgp(tenant, 'clientes', { cpfcnpj: base?.cpfcnpj, exibir_conexao: true, omitir_titulos: true })).clientes)
        .map(comoObjeto).find((c) => comoLista(c.contratos).map(comoObjeto).some((ct) => Number(ct.id) === contrato_id)) ?? null),
      seguro(async () => comoObjeto(comoLista(await chamarSgp(tenant, 'listacontrato', { contrato: contrato_id, exibir_endereco: true }))[0])),
      seguro(() => faturasAbertas(tenant, contrato_id)),
      seguro(async () => comoLista(comoObjeto(await chamarSgp(tenant, 'titulos', {
        contrato: contrato_id, data_pagamento_inicio: menosDias(365), ordenar: 'data_pagamento', ordenar_ordem: 'desc',
        limit: 12, empresa_cnpj: tenant.empresa_cnpj,
      })).titulos).map(comoObjeto)
        .filter((t) => Number(t.clienteContrato) === contrato_id && texto(t.dataPagamento))
        .map((t) => ({
          fatura_id: Number(t.id),
          vencimento: texto(t.dataVencimento)?.slice(0, 10) ?? null,
          pago_em: texto(t.dataPagamento)?.slice(0, 10) ?? null,
          valor_pago: Number(t.valorPago ?? t.valor ?? 0),
        }))),
      seguro(async () => comoObjeto(await chamarSgp(tenant, 'verificaacesso', { contrato: contrato_id }))),
      seguro(async () => comoLista(comoObjeto(await chamarSgp(tenant, 'ocorrencias', {
        contrato: contrato_id, data_cadastro_inicio: menosDias(90), limit: 20,
      })).ocorrencias).map(comoObjeto).map((o) => ({
        numero: texto(o.numero),
        tipo: texto(o.tipo),
        status: texto(o.status),
        status_id: Number(o.status_id ?? -1),
        aberto_em: texto(o.data_cadastro),
        agendado_para: texto(o.data_agendamento),
        finalizado_em: texto(o.data_finalizacao),
        resumo: texto(o.conteudo)?.slice(0, 400) ?? null,
        responsavel: texto(o.responsavel),
        comentarios: comoLista(o.comentarios).map(comoObjeto).slice(-5).map((c) => ({
          texto: texto(c.comentario)?.slice(0, 400) ?? null, por: texto(c.usuario), em: texto(c.data_cadastro),
        })),
        ordens_servico: comoLista(o.ordens_servicos).map(comoObjeto).map((os) => ({
          id: Number(os.id), status: texto(os.status), agendada_para: texto(os.data_agendamento), finalizada_em: texto(os.data_finalizacao),
        })),
      }))),
      seguro(async () => (await pool.query(
        `SELECT etapa, origem, status, enviado_em FROM ${s}.regua_envios WHERE contrato_id = $1 ORDER BY enviado_em DESC LIMIT 20`,
        [contrato_id])).rows),
      seguro(async () => (await pool.query(`SELECT tipo, valor FROM ${s}.contatos WHERE cliente_id = $1 ORDER BY tipo, valor`, [permitido.cliente_id])).rows),
      seguro(async () => (await statusCrm([permitido.cliente_id])).get(permitido.cliente_id) ?? null),
      seguro(() => nomesDosPops(tenant)),
    ]);

    // Contrato (campos públicos) e cliente.
    const ct = cliSgp ? contratosPublicos(cliSgp, canal.pops).find((c) => c.contrato_id === contrato_id) ?? null : null;
    const end = comoObjeto(listaContrato?.endereco);
    const login = texto(acesso?.login);
    const sessoes = login ? await sessoesRadius(login) : null;

    // Financeiro.
    const hoje = hojeSP();
    const lista = (abertas ?? []).map((f) => ({ ...f, vencida: diasAtraso(f.vencimento, hoje) > 0, dias_atraso: diasAtraso(f.vencimento, hoje) }));
    lista.sort((a, b) => (Number(b.vencida) - Number(a.vencida)) || a.vencimento.localeCompare(b.vencimento));
    const vencidas = lista.filter((f) => f.vencida);
    const soma = (xs: { valor: number }[]) => Math.round(xs.reduce((t, f) => t + f.valor, 0) * 100) / 100;

    // Situação em um olhar (e a aba que o painel abre).
    const statusContrato = ct?.status ?? texto(listaContrato?.status);
    const problemaContrato = !!statusContrato && !/^ativo$/i.test(statusContrato.trim());
    const online = acesso && typeof acesso.status === 'number' ? acesso.status === 1 : (ct?.conexao ? ct.conexao === 'online' : null);
    const situacao = {
      contrato: { texto: statusContrato, motivo: ct?.motivo_status ?? texto(listaContrato?.motivo_status), problema: problemaContrato },
      conexao: { online, mensagem: texto(acesso?.msg), problema: online === false },
      financeiro: { vencidas: vencidas.length, valor_vencido: soma(vencidas), problema: vencidas.length > 0 },
      aba_sugerida: vencidas.length > 0 || /suspens/i.test(statusContrato ?? '') ? 'financeiro' : online === false ? 'rede' : 'cliente',
    };

    return {
      gerado_em: new Date().toISOString(),
      situacao,
      cliente: cliSgp ? {
        id: permitido.cliente_id,
        nome: texto(cliSgp.nome),
        documento: texto(base?.cpfcnpj),
        ...clientePublico(cliSgp),
        telefones: (contatos ?? []).filter((c) => c.tipo !== 'emails').map((c) => c.valor),
        emails: (contatos ?? []).filter((c) => c.tipo === 'emails').map((c) => c.valor),
        status_crm: crm,
      } : null,
      contrato: {
        id: contrato_id,
        status: statusContrato,
        plano: ct?.plano ?? null,
        vencimento_dia: ct?.vencimento ?? null,
        pop: ct ? pops?.get(ct.pop_id) ?? null : null,
        endereco: ct?.endereco ?? null,
        latitude: texto(end.latitude),
        longitude: texto(end.longitude),
        documentos: TIPOS_DOCUMENTO,
      },
      financeiro: {
        abertas: lista,
        pagas: pagas ?? [],
        total_aberto: soma(lista),
        total_vencido: soma(vencidas),
        ultimo_pagamento: (pagas ?? [])[0] ?? null,
        consultado: abertas !== null,
      },
      rede: {
        online,
        mensagem: texto(acesso?.msg),
        login,
        sessoes: sessoes ?? [],
        ultima_queda: (sessoes ?? []).find((x) => x.fim)?.fim ?? null,
        consultado: acesso !== null,
      },
      atendimento: { chamados: ocorrencias ?? [], consultado: ocorrencias !== null },
      emails: envios ?? [],
    };
  });

  app.post('/v1/painel/documento', async (req, reply) => {
    const { tenant, canal } = req.ctx!;
    if (!canal.permite_painel) return reply.code(403).send({ erro: 'painel_nao_permitido_neste_canal' });
    const { contrato_id, tipo } = Documento.parse(req.body);
    const permitido = await contratoPermitido(tenant, canal, contrato_id);
    if (!permitido) return reply.code(404).send({ erro: 'contrato_nao_encontrado' });
    req.auditoria!.cliente_id = permitido.cliente_id;
    const pdf = await pdfContrato(tenant, tipo, contrato_id);
    return reply.header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `inline; filename="${tipo}-${contrato_id}.pdf"`).send(pdf);
  });
}
