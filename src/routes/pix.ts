import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { chamarSgp } from '../sgp/client.js';
import type { Tenant } from '../tenants.js';
import { contratoPermitido } from '../trava.js';
import { comoLista, comoObjeto } from '../util.js';

const Body = z.object({
  contrato_id: z.coerce.number().int().positive(),
  fatura_id: z.coerce.number().int().positive(),
});

const CHAVES_PIX = ['pix', 'codigoPix', 'codigo_pix', 'emv', 'copiaecola', 'copia_cola', 'qrcode', 'payload'];

function extrairPix(v: unknown): string | null {
  const o = comoObjeto(v);
  for (const k of CHAVES_PIX) {
    const val = o[k];
    if (typeof val === 'string' && val.length > 20) return val;
    if (val && typeof val === 'object') {
      const interno = extrairPix(val);
      if (interno) return interno;
    }
  }
  return null;
}

async function buscarTitulo(tenant: Tenant, contrato: number, fatura: number) {
  const resp = comoObjeto(await chamarSgp(tenant, 'titulos', { titulo_id: fatura, contrato }));
  return comoLista(resp.titulos)
    .map(comoObjeto)
    .find((t) => Number(t.id) === fatura && Number(t.clienteContrato) === contrato);
}

/**
 * PIX copia-e-cola de uma fatura do contrato.
 * A doc da rota URA não mostra a resposta: tenta extrair dela e, se não vier,
 * relê o título e usa o campo codigoPix.
 */
export async function rotaPix(app: FastifyInstance) {
  app.post('/v1/pix', async (req, reply) => {
    const { tenant, canal } = req.ctx!;
    const { contrato_id, fatura_id } = Body.parse(req.body);
    req.auditoria!.contrato_id = contrato_id;

    const permitido = await contratoPermitido(tenant, canal, contrato_id);
    if (!permitido) return reply.code(404).send({ erro: 'contrato_nao_encontrado' });
    req.auditoria!.cliente_id = permitido.cliente_id;

    // A fatura precisa ser deste contrato e estar em aberto.
    const titulo = await buscarTitulo(tenant, contrato_id, fatura_id);
    if (!titulo) return reply.code(404).send({ erro: 'fatura_nao_encontrada' });
    if (String(titulo.status ?? '').toLowerCase() !== 'aberto') {
      return reply.code(409).send({ erro: 'fatura_nao_esta_em_aberto' });
    }

    let codigo = typeof titulo.codigoPix === 'string' && titulo.codigoPix ? titulo.codigoPix : null;
    if (!codigo) {
      const resp = await chamarSgp(tenant, 'pix', { contrato: contrato_id }, fatura_id);
      // Registra só os NOMES dos campos, para descobrirmos o formato real da resposta.
      req.log.info({ chaves: Object.keys(comoObjeto(resp)) }, 'formato da resposta PIX do SGP');
      codigo = extrairPix(resp);
      if (!codigo) {
        const relido = await buscarTitulo(tenant, contrato_id, fatura_id);
        codigo = typeof relido?.codigoPix === 'string' && relido.codigoPix ? relido.codigoPix : null;
      }
    }

    if (!codigo) {
      req.auditoria!.erro = 'pix_indisponivel';
      return reply.code(502).send({ erro: 'pix_indisponivel' });
    }

    return {
      contrato_id,
      fatura_id,
      valor: Number(titulo.valorCorrigido ?? titulo.valor ?? 0),
      vencimento: titulo.dataVencimento ?? null,
      pix_copia_e_cola: codigo,
    };
  });
}
