import { config, tokenDoTenant } from '../config.js';
import type { Tenant } from '../tenants.js';

/**
 * Lista FECHADA de rotas do SGP que o gateway pode chamar. Só leitura.
 * Qualquer rota nova precisa entrar aqui explicitamente.
 */
const ROTAS = {
  clientes: '/api/ura/clientes/',
  titulos: '/api/ura/titulos/',
  fatura2via: '/api/ura/fatura2via/',
  pix: '/api/ura/pagamento/pix/:id',
  pops: '/api/ura/pops/',
} as const;

export type RotaSgp = keyof typeof ROTAS;

export class SgpError extends Error {
  constructor(
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'SgpError';
  }
}

/**
 * Valores: string/number viram campo do form. `true` envia "1".
 * `false`, null e undefined NÃO enviam o campo — vários flags do SGP
 * (ex.: omitir_titulos) funcionam por presença, então "0" também ativaria.
 */
export type CamposSgp = Record<string, string | number | boolean | null | undefined>;

export async function chamarSgp(
  tenant: Tenant,
  rota: RotaSgp,
  campos: CamposSgp = {},
  id?: number,
  timeoutMs: number = config.SGP_TIMEOUT_MS,
): Promise<unknown> {
  let path: string = ROTAS[rota];
  if (path.includes(':id')) {
    if (!Number.isSafeInteger(id) || (id as number) <= 0) throw new SgpError(`rota ${rota} exige id`);
    path = path.replace(':id', String(id));
  }

  const form = new FormData();
  form.set('app', tenant.sgp_app);
  form.set('token', tokenDoTenant(tenant.sgp_token_env));
  for (const [k, v] of Object.entries(campos)) {
    if (v === undefined || v === null || v === false) continue;
    form.set(k, v === true ? '1' : String(v));
  }

  let res: Response;
  try {
    res = await fetch(new URL(path, tenant.sgp_base_url), {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new SgpError(`SGP ${rota}: falha de rede (${(e as Error).name})`);
  }

  const texto = await res.text();
  if (!res.ok) throw new SgpError(`SGP ${rota}: HTTP ${res.status}`, res.status);
  if (!texto.trim()) return null;
  try {
    return JSON.parse(texto);
  } catch {
    throw new SgpError(`SGP ${rota}: resposta não é JSON`);
  }
}

/**
 * ESCRITA no SGP: cadastro de cliente PF no CRM (mesmo formato do pre-cadastro).
 * Usa a credencial de escrita do tenant, separada da de leitura. É a única escrita do gateway.
 */
export async function cadastrarClientePf(tenant: Tenant, dados: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!tenant.sgp_write_app || !tenant.sgp_write_token_env) throw new SgpError('tenant sem credencial de escrita');
  const corpo = { app: tenant.sgp_write_app, token: tokenDoTenant(tenant.sgp_write_token_env), ...dados };
  let res: Response;
  try {
    res = await fetch(new URL('/api/crm/cliente/F', tenant.sgp_base_url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(config.SGP_TIMEOUT_MS),
    });
  } catch (e) {
    throw new SgpError(`SGP cadastro: falha de rede (${(e as Error).name})`);
  }
  const texto = await res.text();
  try {
    return JSON.parse(texto) as Record<string, unknown>;
  } catch {
    throw new SgpError(`SGP cadastro: HTTP ${res.status}, resposta não é JSON`, res.status);
  }
}
