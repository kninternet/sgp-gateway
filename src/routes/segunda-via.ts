import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { chamarSgp } from '../sgp/client.js';
import { contratoPermitido } from '../trava.js';
import { comoLista, comoObjeto } from '../util.js';

const Body = z.object({ contrato_id: z.coerce.number().int().positive() });

/** 2ª via no SGP (valores já corrigidos). Abre chamado só se o tenant estiver configurado para isso. */
export async function rotaSegundaVia(app: FastifyInstance) {
  app.post('/v1/segunda-via', async (req, reply) => {
    const { tenant, canal } = req.ctx!;
    const { contrato_id } = Body.parse(req.body);
    req.auditoria!.contrato_id = contrato_id;

    const permitido = await contratoPermitido(tenant, canal, contrato_id);
    if (!permitido) return reply.code(404).send({ erro: 'contrato_nao_encontrado' });
    req.auditoria!.cliente_id = permitido.cliente_id;

    const resp = comoObjeto(
      await chamarSgp(tenant, 'fatura2via', {
        contrato: contrato_id,
        tipo_ordenacao: 'data_vencimento',
        modo_ordenacao: 'asc',
        nao_gerar_os: tenant.gerar_os_2via ? undefined : 1,
      }),
    );

    // Segunda trava: a resposta tem que ser do mesmo contrato.
    if (resp.contratoId !== undefined && Number(resp.contratoId) !== contrato_id) {
      req.auditoria!.erro = 'sgp_contrato_divergente';
      req.log.error({ contrato_id, retornado: resp.contratoId }, 'SGP devolveu outro contrato na 2ª via');
      return reply.code(502).send({ erro: 'resposta_inconsistente' });
    }

    const faturas = comoLista(resp.links).map(comoObjeto).map((l) => ({
      fatura_id: Number(l.fatura),
      vencimento: l.vencimento ?? null,
      valor: Number(l.valor ?? 0),
      vencimento_original: l.vencimento_original ?? null,
      valor_original: l.valor_original != null ? Number(l.valor_original) : null,
      link_boleto: l.link ?? null,
      linha_digitavel: l.linhadigitavel || null,
    }));

    return {
      contrato_id,
      protocolo: resp.protocolo ?? null,
      mensagem_sgp: resp.msg || null,
      faturas,
    };
  });
}
