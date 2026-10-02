import pg from 'pg';
import { config } from './config.js';

// bigint (int8) vem como string por padrão; os IDs do SGP cabem em Number.
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 5 });
