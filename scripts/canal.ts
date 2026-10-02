/**
 * Cria um canal e imprime a chave UMA vez (só o hash é gravado).
 * Uso: pnpm canal:add --tenant vivanet --nome webchat --pop 100072 [--telefone]
 */
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { hashChave } from '../src/contexto.js';
import { pool } from '../src/db.js';

const { values } = parseArgs({
  options: {
    tenant: { type: 'string' },
    nome: { type: 'string' },
    pop: { type: 'string' },
    telefone: { type: 'boolean', default: false },
  },
});

const pop = Number(values.pop);
if (!values.tenant || !values.nome || !Number.isInteger(pop)) {
  console.error('Uso: pnpm canal:add --tenant <id> --nome <canal> --pop <id> [--telefone]');
  process.exit(1);
}

const t = await pool.query(`SELECT pops_permitidos FROM gateway.tenants WHERE id = $1`, [values.tenant]);
if (!t.rows[0]) throw new Error(`tenant inexistente: ${values.tenant}`);
if (!t.rows[0].pops_permitidos.includes(pop)) throw new Error(`POP ${pop} não pertence ao tenant ${values.tenant}`);

const chave = `gw_${randomBytes(32).toString('base64url')}`;
await pool.query(
  `INSERT INTO gateway.canais (tenant_id, nome, pop_id, permite_telefone, key_hash) VALUES ($1, $2, $3, $4, $5)`,
  [values.tenant, values.nome, pop, values.telefone, hashChave(chave)],
);
console.log(`Canal ${values.tenant}/${values.nome} (POP ${pop}) criado.`);
console.log('Chave (aparece só agora, guarde direto na credencial do n8n):');
console.log(chave);
await pool.end();
