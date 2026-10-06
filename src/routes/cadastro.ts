import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { consultarCobertura } from '../cobertura.js';
import { pool } from '../db.js';
import { cadastrarClientePf } from '../sgp/client.js';
import { schemaDe } from '../tenants.js';
import { celularParaSgp, cpfValido, normalizarTexto, soDigitos } from '../util.js';

const Body = z.object({
  cpfcnpj: z.string(),
  nome: z.string().trim().min(5).max(120),
  email: z.string().trim().email().max(120),
  celular: z.string().optional().nullable(),
  cep: z.string(),
  numero: z.string().trim().min(1).max(20),
  complemento: z.string().trim().max(80).optional().nullable(),
  plano: z.string().trim().min(1),
  vencimento: z.coerce.number().int(),
  conversa: z.string().max(60).optional().nullable(),
});

const LIMITE_POR_HORA = 20;

/**
 * Cadastro de cliente PF no CRM do SGP. Única escrita do gateway.
 * Revalida tudo (CPF, cobertura, plano, vencimento) — nada vem pronto do modelo.
 * O contrato é montado pela equipe a partir da observação.
 */
export async function rotaCadastro(app: FastifyInstance) {
  app.post('/v1/cadastro', async (req, reply) => {
    const { tenant, canal } = req.ctx!;
    if (!canal.permite_cadastro) return reply.code(403).send({ erro: 'cadastro_nao_permitido_neste_canal' });

    const b = Body.parse(req.body);
    const cpf = soDigitos(b.cpfcnpj);
    if (!cpfValido(cpf)) return reply.code(400).send({ erro: 'cpf_invalido' });
    if (!/^[\x20-\x7E]+$/.test(b.email)) return reply.code(400).send({ erro: 'email_invalido' });
    const nome = b.nome.replace(/\s+/g, ' ');
    if (nome.split(' ').length < 2) return reply.code(400).send({ erro: 'nome_incompleto' });

    const s = schemaDe(tenant);

    // Mesmo CPF já cadastrado com sucesso nos últimos 30 dias: devolve o anterior, não duplica.
    const anterior = await pool.query<{ id: number; cliente_id: number }>(
      `SELECT id, cliente_id FROM ${s}.cadastros WHERE cpfcnpj = $1 AND status = 'ok'
         AND criado_em > now() - interval '30 days' ORDER BY id DESC LIMIT 1`, [cpf]);
    if (anterior.rows[0]) {
      req.auditoria!.cliente_id = anterior.rows[0].cliente_id;
      return { ok: true, cliente_id: anterior.rows[0].cliente_id, lead_id: anterior.rows[0].id, ja_existia: true };
    }

    // Freio contra abuso do canal.
    const recentes = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${s}.cadastros WHERE canal_id = $1 AND criado_em > now() - interval '1 hour'`, [canal.id]);
    if (recentes.rows[0].n >= LIMITE_POR_HORA) return reply.code(429).send({ erro: 'limite_de_cadastros' });

    const cob = await consultarCobertura(tenant, canal, b.cep);
    if (!cob.atende) return reply.code(422).send({ erro: 'sem_cobertura', motivo: cob.motivo });

    const plano = cob.planos.find((p) => normalizarTexto(p.nome) === normalizarTexto(b.plano));
    if (!plano) return reply.code(422).send({ erro: 'plano_invalido', planos: cob.planos.map((p) => p.nome) });
    if (!cob.vencimentos.includes(b.vencimento)) {
      return reply.code(422).send({ erro: 'vencimento_invalido', vencimentos: cob.vencimentos });
    }

    const celular = celularParaSgp(b.celular);
    const observacao = [
      'Cadastro via Vitor (Viva Net)',
      `Plano: ${plano.nome} - R$ ${plano.valor.toFixed(2).replace('.', ',')}`,
      `Vencimento: Dia ${b.vencimento}`,
      `POP ID: ${cob.pop_id}`,
      plano.sgp_plano_id ? `Plano ID SGP: ${plano.sgp_plano_id}` : '',
      b.celular && !celular ? `Telefone informado: ${soDigitos(b.celular)}` : '',
      b.conversa ? `Conversa Chatwoot: ${b.conversa}` : '',
    ].filter(Boolean).join(' | ');

    const registrar = async (status: string, cliente_id: number | null, erro: string | null): Promise<number> => {
      const r = await pool.query<{ id: number }>(
        `INSERT INTO ${s}.cadastros (canal_id, conversa, cpfcnpj, pop_id, plano, vencimento, status, cliente_id, erro)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [canal.id, b.conversa ?? null, cpf, cob.pop_id, plano.nome, b.vencimento, status, cliente_id, erro],
      );
      return r.rows[0].id;
    };

    const resp = await cadastrarClientePf(tenant, {
      nome,
      cpfcnpj: cpf,
      email: b.email,
      ...(celular ? { celular } : {}),
      observacao,
      endereco: {
        logradouro: cob.endereco.logradouro,
        numero: b.numero,
        complemento: b.complemento ?? '',
        bairro: cob.endereco.bairro,
        cidade: cob.endereco.cidade,
        cep: cob.endereco.cep,
        uf: cob.endereco.uf,
        pais: 'BR',
        pontoreferencia: '',
      },
    });

    const clienteId = Number(resp.cliente_id);
    if (Number.isSafeInteger(clienteId) && clienteId > 0) {
      const leadId = await registrar('ok', clienteId, null);
      req.auditoria!.cliente_id = clienteId;
      // O SGP cria o cliente do CRM já em "Em análise" (status 1); não há escrita de status aqui.
      return {
        ok: true, cliente_id: clienteId, lead_id: leadId, pop_id: cob.pop_id, plano: plano.nome,
        plano_valor: plano.valor, vencimento: b.vencimento, status_crm: 'Em análise',
      };
    }

    // O SGP é o árbitro final: CPF existente em qualquer POP (inclusive de outra marca) é recusado.
    const erros = (resp.errors ?? {}) as Record<string, unknown>;
    const msg = String(erros.cpfcnpj ?? erros.message ?? resp.message ?? 'recusado').slice(0, 300);
    if (erros.cpfcnpj) {
      await registrar('cpf_existente', null, msg);
      return reply.code(409).send({ erro: 'cpf_ja_cadastrado' });
    }
    await registrar('recusado', null, msg);
    req.auditoria!.erro = 'sgp_recusou_cadastro';
    return reply.code(502).send({ erro: 'sgp_recusou' });
  });
}
