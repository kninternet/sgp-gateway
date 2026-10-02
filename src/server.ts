import Fastify from 'fastify';
import { ZodError } from 'zod';
import { registrarAuditoria } from './auditoria.js';
import { config } from './config.js';
import { autenticar } from './contexto.js';
import { pool } from './db.js';
import { rotaFaturas } from './routes/faturas.js';
import { rotaIdentificar } from './routes/identificar.js';
import { rotaPix } from './routes/pix.js';
import { rotaSegundaVia } from './routes/segunda-via.js';
import { SgpError } from './sgp/client.js';

const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    redact: ['req.headers["x-gateway-key"]', 'req.headers.authorization'],
  },
  bodyLimit: 16 * 1024,
});

// Defesa extra além do UFW: só aceita os IPs configurados.
if (config.ALLOWED_IPS.length > 0) {
  app.addHook('onRequest', async (req, reply) => {
    if (!config.ALLOWED_IPS.includes(req.ip)) {
      req.log.warn({ ip: req.ip }, 'IP não permitido');
      return reply.code(403).send({ erro: 'origem_nao_permitida' });
    }
  });
}

app.get('/health', async () => {
  await pool.query('SELECT 1');
  return { ok: true };
});

app.register(async (rotas) => {
  rotas.addHook('preHandler', autenticar);
  rotas.addHook('onResponse', registrarAuditoria);
  await rotas.register(rotaIdentificar);
  await rotas.register(rotaFaturas);
  await rotas.register(rotaSegundaVia);
  await rotas.register(rotaPix);
});

app.setErrorHandler((err, req, reply) => {
  const msg = err instanceof ZodError ? 'entrada_invalida' : err instanceof Error ? err.message : String(err);
  if (req.auditoria) req.auditoria.erro = msg.slice(0, 200);
  if (err instanceof ZodError) {
    return reply.code(400).send({ erro: 'entrada_invalida', detalhes: err.issues.map((i) => i.message) });
  }
  if (err instanceof SgpError) {
    req.log.error({ err: err.message, status: err.httpStatus }, 'erro no SGP');
    return reply.code(502).send({ erro: 'sgp_indisponivel' });
  }
  req.log.error({ err }, 'erro interno');
  return reply.code(500).send({ erro: 'erro_interno' });
});

const parar = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', parar);
process.on('SIGTERM', parar);

await app.listen({ host: config.HOST, port: config.PORT });
