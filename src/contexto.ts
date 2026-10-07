import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { pool } from './db.js';
import type { Canal, Tenant } from './tenants.js';

declare module 'fastify' {
  interface FastifyRequest {
    ctx?: { tenant: Tenant; canal: Canal };
    auditoria?: { cliente_id?: number; contrato_id?: number; erro?: string };
  }
}

export const hashChave = (chave: string) => createHash('sha256').update(chave).digest('hex');

/** Autentica a chave do canal e carrega tenant + canal. A chave nunca é logada. */
export async function autenticar(req: FastifyRequest, reply: FastifyReply) {
  const chave = req.headers['x-gateway-key'];
  if (typeof chave !== 'string' || chave.length < 20) {
    return reply.code(401).send({ erro: 'nao_autorizado' });
  }

  const { rows } = await pool.query(
    `SELECT c.id, c.tenant_id, c.nome, c.pops, c.permite_telefone, c.permite_cadastro, c.permite_email,
            t.id AS t_id, t.nome AS t_nome, t.sgp_base_url, t.sgp_app, t.sgp_token_env,
            t.schema_name, t.pops_permitidos, t.empresa_cnpj, t.gerar_os_2via, t.link_boleto_base,
            t.sgp_write_app, t.sgp_write_token_env
       FROM gateway.canais c
       JOIN gateway.tenants t ON t.id = c.tenant_id
      WHERE c.key_hash = $1 AND c.ativo AND t.ativo`,
    [hashChave(chave)],
  );
  const r = rows[0];
  if (!r) return reply.code(401).send({ erro: 'nao_autorizado' });

  const tenant: Tenant = {
    id: r.t_id,
    nome: r.t_nome,
    sgp_base_url: r.sgp_base_url,
    sgp_app: r.sgp_app,
    sgp_token_env: r.sgp_token_env,
    schema_name: r.schema_name,
    pops_permitidos: r.pops_permitidos,
    empresa_cnpj: r.empresa_cnpj,
    gerar_os_2via: r.gerar_os_2via,
    link_boleto_base: r.link_boleto_base,
    sgp_write_app: r.sgp_write_app,
    sgp_write_token_env: r.sgp_write_token_env,
  };

  // Trava de configuração: todos os POPs do canal precisam estar entre os POPs do tenant.
  const pops: number[] = Array.isArray(r.pops) ? r.pops : [];
  if (pops.length === 0 || !pops.every((p) => tenant.pops_permitidos.includes(p))) {
    req.log.error({ canal: r.id, pops }, 'canal com POP fora do tenant');
    return reply.code(403).send({ erro: 'canal_mal_configurado' });
  }

  req.ctx = {
    tenant,
    canal: {
      id: r.id,
      tenant_id: r.tenant_id,
      nome: r.nome,
      pops,
      permite_telefone: r.permite_telefone,
      permite_cadastro: r.permite_cadastro,
      permite_email: r.permite_email,
    },
  };
  req.auditoria = {};
}
