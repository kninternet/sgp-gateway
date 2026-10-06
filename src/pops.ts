/**
 * Nome dos POPs (ex.: 100072 → "NOVA GRECIA-RJ"), para o painel da equipe.
 * Lido do SGP (rota "pops", já na lista fechada) e guardado em memória por 6 horas.
 */
import { chamarSgp } from './sgp/client.js';
import type { Tenant } from './tenants.js';
import { comoLista, comoObjeto } from './util.js';

const cache = new Map<string, { quando: number; nomes: Map<number, string> }>();
const VALIDADE_MS = 6 * 60 * 60 * 1000;

export async function nomesDosPops(tenant: Tenant): Promise<Map<number, string>> {
  const c = cache.get(tenant.id);
  if (c && Date.now() - c.quando < VALIDADE_MS) return c.nomes;
  const nomes = new Map<number, string>();
  try {
    const resp = await chamarSgp(tenant, 'pops', {}, undefined, 5000);
    const o = comoObjeto(resp);
    const lista = Array.isArray(resp) ? resp : comoLista(o.pops ?? o.dados ?? o.result);
    for (const p of lista.map(comoObjeto)) {
      const id = Number(p.id ?? p.pop_id);
      const nome = String(p.descricao ?? p.nome ?? p.pop ?? p.cidade ?? '').trim();
      if (Number.isSafeInteger(id) && nome && tenant.pops_permitidos.includes(id)) nomes.set(id, nome);
    }
    cache.set(tenant.id, { quando: Date.now(), nomes });
  } catch {
    // Sem nome do POP nesta resposta; tenta de novo na próxima.
  }
  return nomes;
}
