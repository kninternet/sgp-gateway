/**
 * Modelos de e-mail em arquivo HTML, por tenant: emails/<tenant>/<nome>.html (feitos pela equipe).
 * Variáveis no formato {nome}; todo valor é escapado antes de entrar no HTML.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Tenant } from '../tenants.js';
import type { ContatoContrato, FaturaEmail } from './dados.js';
import { brl, dataBR, primeiroNome } from './modelos.js';

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const EMPRESA: Record<string, { razao: string; cnpj: string; chat: string }> = {
  vivanet: { razao: 'MJP TELECOM LTDA', cnpj: '34.676.479/0001-00', chat: 'https://vivanettelecom.com.br/chat?origem=email' },
};

function modelo(tenant: Tenant, nome: string): string | null {
  const caminho = join(process.cwd(), 'emails', tenant.id, `${nome}.html`);
  return existsSync(caminho) ? readFileSync(caminho, 'utf8') : null;
}

function preencher(html: string, dados: Record<string, string>): string {
  return html.replace(/\{([a-z_]+)\}/g, (m, k: string) => (k in dados ? esc(dados[k]) : m));
}

/** Fatura avulsa com o modelo da equipe (emails/<tenant>/fatura.html). Nulo se o arquivo não existir. */
export function emailFaturaArquivo(tenant: Tenant, c: ContatoContrato, f: FaturaEmail) {
  const html = modelo(tenant, 'fatura');
  const emp = EMPRESA[tenant.id];
  if (!html || !emp) return null;
  const [ano, mes] = f.vencimento.split('-').map(Number);
  const mesRef = `${MESES[mes - 1]}/${ano}`;
  const valor = brl(f.valor).replace('R$ ', '');
  const dados = {
    cliente: primeiroNome(c.nome),
    mes_referencia: mesRef,
    valor,
    vencimento: dataBR(f.vencimento),
    pix_copia_cola: f.pix ?? 'PIX indisponível para esta fatura. Use o boleto abaixo ou fale com a gente no Vivanet Chat.',
    link_boleto: f.link_boleto ?? emp.chat,
    beneficiario_pix: emp.razao,
    razao_social: emp.razao,
    cnpj: emp.cnpj,
  };
  const assunto = `Sua fatura Viva Net de ${mesRef}`;
  const texto = [
    `Olá, ${dados.cliente}. Sua fatura de ${mesRef} está disponível.`, '',
    `Valor: R$ ${valor}`, `Vencimento: ${dados.vencimento}`, '',
    f.pix ? `PIX copia e cola:\n${f.pix}` : '', f.link_boleto ? `Boleto completo: ${f.link_boleto}` : '',
    f.linha_digitavel ? `Linha digitável: ${f.linha_digitavel}` : '', '',
    `Confira antes de pagar: o recebedor do PIX deve ser ${emp.razao}. Já pagou? Pode desconsiderar este e-mail.`,
    `Dúvidas? Vivanet Chat: ${emp.chat}`, '', `Vitor · Atendimento Viva Net`,
    `Viva Net Telecom é uma marca de ${emp.razao} · CNPJ ${emp.cnpj}`,
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
  return { assunto, html: preencher(html, dados), texto };
}
