import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { consultarCobertura } from '../cobertura.js';

const Body = z.object({ cep: z.string().min(8) });

/** Consulta de cobertura por CEP nos POPs do canal. Não chama o SGP. */
export async function rotaCobertura(app: FastifyInstance) {
  app.post('/v1/cobertura', async (req) => {
    const { tenant, canal } = req.ctx!;
    const { cep } = Body.parse(req.body);
    return consultarCobertura(tenant, canal, cep);
  });
}
