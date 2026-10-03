/** Aplica as migrations (idempotentes) e o template de schema de cada tenant. */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';
import { schemaDe, tenantsAtivos } from '../src/tenants.js';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = join(raiz, 'migrations');

const arquivos = (await readdir(dir)).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
for (const f of arquivos) {
  await pool.query(await readFile(join(dir, f), 'utf8'));
  console.log(`ok: ${f}`);
}

const template = await readFile(join(dir, 'tenant.sql'), 'utf8');
for (const t of await tenantsAtivos()) {
  await pool.query(template.replaceAll('{{schema}}', schemaDe(t)));
  console.log(`ok: schema do tenant ${t.id}`);
}

// Seeds rodam por último (dependem das tabelas dos tenants). Devem ser idempotentes.
const dirSeeds = join(dir, 'seeds');
const seeds = (await readdir(dirSeeds).catch(() => [] as string[])).filter((f) => f.endsWith('.sql')).sort();
for (const f of seeds) {
  await pool.query(await readFile(join(dirSeeds, f), 'utf8'));
  console.log(`ok: seed ${f}`);
}
await pool.end();
