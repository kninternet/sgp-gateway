import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { chamarSgp } from '../sgp/client.js';
import { contratoPermitido } from '../trava.js';
import { comoLista, comoObjeto, diasAtraso, hojeSP, linkPublico } from '../util.js';

const Body = z.object({ contrato_id: z.coerce.number().int().positive() });

/** Faturas em aberto do contrato, consultadas AO VIVO no SGP. Atraso calculado aqui (o diasAtraso do SGP não é confiável). */
export async function rotaFaturas(app: FastifyInstance) {
  app.post('/v1/faturas', async (req, reply) => {
    const { tenant, canal } = req.ctx!;
    const { contrato_id } = Body.parse(req.body);
    req.auditoria!.contrato_id = contrato_id;

    const permitido = await contratoPermitido(tenant, canal, contrato_id);
    if (!permitido) return reply.code(404).send({ erro: 'contrato_nao_encontrado' });
    req.auditoria!.cliente_id = permitido.cliente_id;

    const resp = comoObjeto(
      await chamarSgp(tenant, 'titulos', {
        contrato: contrato_id,
        status: 'abertos',
        ordenar: 'data_vencimento',
        ordenar_ordem: 'asc',
        limit: 250,
        empresa_cnpj: tenant.empresa_cnpj,
      }),
    );

    const hoje = hojeSP();
    const faturas = comoLista(resp.titulos)
      .map(comoObjeto)
      // Segunda trava: descarta qualquer título que não seja deste contrato.
      .filter((t) => Number(t.clienteContrato) === contrato_id)
      .map((t) => {
        const venc = String(t.dataVencimento ?? '');
        const atraso = diasAtraso(venc, hoje);
        return {
          fatura_id: Number(t.id),
          valor: Number(t.valor ?? 0),
          valor_corrigido: Number(t.valorCorrigido ?? t.valor ?? 0),
          vencimento: venc,
          vencida: atraso > 0,
          dias_atraso: atraso,
          link_boleto: linkPublico(tenant.link_boleto_base, t.link),
          link_pagamento: linkPublico(tenant.link_boleto_base, t.link_cobranca),
          linha_digitavel: t.linhaDigitavel || null,
          tem_pix: Boolean(t.codigoPix),
        };
      });

    const vencidas = faturas.filter((f) => f.vencida);
    return {
      contrato_id,
      hoje,
      qtd_abertas: faturas.length,
      qtd_vencidas: vencidas.length,
      total_vencido: Number(vencidas.reduce((s, f) => s + f.valor_corrigido, 0).toFixed(2)),
      // Vencidas primeiro, depois as próximas a vencer (limita o que vai para o modelo).
      faturas: [...vencidas, ...faturas.filter((f) => !f.vencida).slice(0, 2)],
    };
  });
}
