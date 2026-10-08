import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { consultarCobertura } from '../cobertura.js';
import { pool } from '../db.js';
import { cadastrarCliente } from '../sgp/client.js';
import { emailCopiaCadastro } from '../regua/modelos.js';
import { enviarEmail, smtpConfigurado } from '../regua/smtp.js';
import { emailVerificado } from './verificacao.js';
import { schemaDe, type Tenant } from '../tenants.js';
import { celularParaSgp, cnpjValido, cpfValido, normalizarTelefone, normalizarTexto, soDigitos } from '../util.js';

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
  origem: z.enum(['vitor', 'formulario', 'atendimento']).optional(),
  // Campanha de origem (formulário): só entra na cópia ao atendimento, não vai ao SGP.
  utm: z.record(z.string().max(200)).optional().nullable(),
});

const NOME_ORIGEM = { vitor: 'Vitor', formulario: 'Formulário', atendimento: 'Atendimento' } as const;
const fmtDoc = (d: string) => d.length === 14
  ? d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5')
  : d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');

/** Cópia de todo cadastro enviado ao SGP para o atendimento (não bloqueia a resposta). */
function copiaAtendimento(tenant: Tenant, log: { warn: (o: object, m: string) => void }, titulo: string,
  linhas: Array<[string, string | number | null | undefined]>, link: string | null) {
  const para = process.env[`EMAIL_COPIA_CADASTRO_${tenant.id.toUpperCase()}`];
  if (!para || !smtpConfigurado(tenant)) return;
  const m = emailCopiaCadastro(titulo, linhas, link);
  enviarEmail(tenant, para, m.assunto, m.html, m.texto).catch((e) => log.warn({ err: (e as Error).message }, 'cópia do cadastro não enviada'));
}

/**
 * Cadastro de cliente PF (CPF) ou PJ (CNPJ) no CRM do SGP, de qualquer canal (Vitor, formulário, atendimento).
 * Revalida tudo (CPF, cobertura, plano, vencimento) — nada vem pronto do modelo.
 * O contrato é montado pela equipe a partir da observação.
 */
export async function rotaCadastro(app: FastifyInstance) {
  app.post('/v1/cadastro', async (req, reply) => {
    const { tenant, canal } = req.ctx!;
    if (!canal.permite_cadastro) return reply.code(403).send({ erro: 'cadastro_nao_permitido_neste_canal' });

    const b = Body.parse(req.body);
    const cpf = soDigitos(b.cpfcnpj);
    const pj = cpf.length === 14;
    if (pj ? !cnpjValido(cpf) : !cpfValido(cpf)) return reply.code(400).send({ erro: pj ? 'cnpj_invalido' : 'cpf_invalido' });
    if (!/^[\x20-\x7E]+$/.test(b.email)) return reply.code(400).send({ erro: 'email_invalido' });
    const nome = b.nome.replace(/\s+/g, ' ');
    if (!pj && nome.split(' ').length < 2) return reply.code(400).send({ erro: 'nome_incompleto' });
    const origem = b.origem ?? (canal.nome === 'formulario' ? 'formulario' : 'vitor');
    const verificado = await emailVerificado(tenant, b.email);

    const s = schemaDe(tenant);

    // Sem limite por hora e sem bloqueio de CPF repetido no gateway: o SGP já recusa
    // um CPF existente, e esse caso vai para o atendimento.
    const cob = await consultarCobertura(tenant, canal, b.cep);
    if (!cob.atende) return reply.code(422).send({ erro: 'sem_cobertura', motivo: cob.motivo });

    const plano = cob.planos.find((p) => normalizarTexto(p.nome) === normalizarTexto(b.plano));
    if (!plano) return reply.code(422).send({ erro: 'plano_invalido', planos: cob.planos.map((p) => p.nome) });
    if (!cob.vencimentos.includes(b.vencimento)) {
      return reply.code(422).send({ erro: 'vencimento_invalido', vencimentos: cob.vencimentos });
    }

    const celular = celularParaSgp(b.celular);
    const observacao = [
      `Cadastro via ${NOME_ORIGEM[origem]} (Viva Net)`,
      verificado ? 'E-mail confirmado por código' : 'E-mail não confirmado',
      `Plano: ${plano.nome} - R$ ${plano.valor.toFixed(2).replace('.', ',')}`,
      `Vencimento: Dia ${b.vencimento}`,
      `POP ID: ${cob.pop_id}`,
      plano.sgp_plano_id ? `Plano ID SGP: ${plano.sgp_plano_id}` : '',
      b.celular && !celular ? `Telefone informado: ${soDigitos(b.celular)}` : '',
      b.conversa ? `Conversa Chatwoot: ${b.conversa}` : '',
    ].filter(Boolean).join(' | ');

    const registrar = async (status: string, cliente_id: number | null, erro: string | null): Promise<number> => {
      const r = await pool.query<{ id: number }>(
        `INSERT INTO ${s}.cadastros (canal_id, conversa, cpfcnpj, pop_id, plano, vencimento, status, cliente_id, erro, celular_norm, nome,
                                     origem, tipo_pessoa, email_verificado)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
        [canal.id, b.conversa ?? null, cpf, cob.pop_id, plano.nome, b.vencimento, status, cliente_id, erro,
          normalizarTelefone(b.celular), nome, origem, pj ? 'J' : 'F', verificado],
      );
      const leadId = r.rows[0].id;
      // Cópia ao atendimento: título no padrão "Novo Cadastro - CPF|CNPJ[ Duplicado] - Nome - Origem[ - E-mail não verificado]".
      // No formulário, o código do e-mail é pedido logo após o envio: a cópia espera 45 s e confere de novo.
      const enviarCopia = (emailOk: boolean) => {
        const doc = pj ? 'CNPJ' : 'CPF';
        const titulo = `Novo Cadastro - ${doc}${status === 'cpf_existente' ? ' Duplicado' : ''} - ${nome} - ${NOME_ORIGEM[origem]}`
          + (emailOk ? '' : ' - E-mail não verificado');
        const resultado = status === 'ok' ? 'Cliente criado no CRM do SGP (Em análise)'
          : status === 'cpf_existente' ? `Não criado: ${doc} já cadastrado no SGP` : `Não criado: SGP recusou (${erro ?? ''})`;
        const endereco = [[cob.endereco.logradouro, b.numero].join(', '), b.complemento, cob.endereco.bairro,
          `${cob.endereco.cidade}/${cob.endereco.uf}`].filter(Boolean).join(' - ');
        const conv = b.conversa && /^\d+$/.test(b.conversa) ? `https://chat.vivanettelecom.com.br/app/accounts/1/conversations/${b.conversa}` : null;
        copiaAtendimento(tenant, req.log, titulo, [
          ['Resultado', resultado],
          ['Nome', nome], [doc, fmtDoc(cpf)],
          ['E-mail', `${b.email} (${emailOk ? 'confirmado por código' : 'não confirmado'})`],
          ['Celular', b.celular ? soDigitos(b.celular) : null],
          ['CEP', cob.endereco.cep], ['Endereço de instalação', endereco],
          ['Plano', `${plano.nome} · R$ ${plano.valor.toFixed(2).replace('.', ',')}`],
          ['Vencimento', `Dia ${b.vencimento}`],
          ['POP', cob.pop_id], ['SGP Cliente ID', cliente_id], ['Lead ID', leadId],
          ['Origem', NOME_ORIGEM[origem]],
          ...Object.entries(b.utm ?? {}).map(([k, v]) => [k, v] as [string, string]),
          ['Data', new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(new Date())],
        ], conv);
      };
      if (origem === 'formulario' && !verificado) {
        setTimeout(async () => {
          let ok = false;
          try {
            ok = await emailVerificado(tenant, b.email);
            if (ok) await pool.query(`UPDATE ${s}.cadastros SET email_verificado = true WHERE id = $1`, [leadId]);
          } catch { /* segue como não verificado */ }
          enviarCopia(ok);
        }, 45_000).unref();
      } else {
        enviarCopia(verificado);
      }
      return leadId;
    };

    const resp = await cadastrarCliente(tenant, pj ? 'J' : 'F', {
      nome,
      cpfcnpj: cpf,
      email: b.email,
      ...(celular ? { celular } : {}),
      ...(pj ? { respempresa: nome } : {}),
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
        plano_valor: plano.valor, vencimento: b.vencimento, status_crm: 'Em análise', email_verificado: verificado,
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
