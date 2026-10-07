/**
 * Modelos de e-mail da Viva Net (régua, boas-vindas e envios manuais).
 * HTML de e-mail: tabelas e estilos inline, largura 600 px, sem scripts nem imagens embutidas.
 */
import type { ContatoContrato, FaturaEmail } from './dados.js';

export type EtapaRegua = 'PRE_FATURA_D5' | 'VENCE_AMANHA' | 'VENCE_HOJE' | 'ATRASO_D2' | 'PRE_BLOQUEIO_D4';
export type Etapa = EtapaRegua | 'BOAS_VINDAS' | 'FATURA' | 'LISTA';

/** Dias em relação ao vencimento (negativo = antes) em que cada etapa sai. */
export const DIAS_DA_ETAPA: Record<EtapaRegua, number> = {
  PRE_FATURA_D5: -5,
  VENCE_AMANHA: -1,
  VENCE_HOJE: 0,
  ATRASO_D2: 2,
  PRE_BLOQUEIO_D4: 4,
};

const COR = { indigo: '#4143B2', vinho: '#8F2C52', tinta: '#1E1F33', cinza: '#5B5C75', fundo: '#F3F3FA', caixa: '#F6F6FC', linha: '#E2E2F0' };
const SITE = 'https://vivanettelecom.com.br';
const LOGO = SITE + '/marca/vivanet-logo.png';
const CHAT = SITE + '/chat?origem=email';
const WHATSAPP = { texto: '(21) 99949-0642', link: 'https://wa.me/5521999490642' };
const EMAIL_ATENDIMENTO = 'atendimento@vivanettelecom.com.br';

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const brl = (v: number) => 'R$ ' + v.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
export const dataBR = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
};
export function primeiroNome(nome: string): string {
  const n = String(nome || '').trim().split(/\s+/)[0] || '';
  return n ? n.charAt(0).toUpperCase() + n.slice(1).toLowerCase() : 'cliente';
}
/** "350MBPS-TRIBOBO" → "350 Mega". */
export function planoAmigavel(p: string | null): string {
  const m = /(\d+)\s*(MBPS|MB|MEGA|M)(?![A-Z])/i.exec(String(p || ''));
  return m ? `${m[1]} Mega` : String(p || '');
}

// ---------------------------------------------------------------- blocos

function botao(texto: string, link: string, cor = COR.indigo) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 4px 0;"><tr>
<td style="background:${cor};border-radius:6px;"><a href="${esc(link)}" target="_blank"
 style="display:inline-block;padding:13px 26px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">${esc(texto)}</a></td>
</tr></table>`;
}

function caixaFatura(f: FaturaEmail, cor: string, rotuloVenc = 'Vencimento') {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
 style="background:${COR.caixa};border-left:4px solid ${cor};border-radius:4px;margin:18px 0;"><tr><td style="padding:16px 20px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="50%" style="font-family:Arial,Helvetica,sans-serif;"><span style="font-size:12px;color:${COR.cinza};">${rotuloVenc}</span><br>
<strong style="font-size:18px;color:${COR.tinta};">${dataBR(f.vencimento)}</strong></td>
<td width="50%" style="font-family:Arial,Helvetica,sans-serif;"><span style="font-size:12px;color:${COR.cinza};">Valor</span><br>
<strong style="font-size:18px;color:${COR.tinta};">${brl(f.valor)}</strong></td>
</tr></table></td></tr></table>`;
}

/** Formas de pagamento: boleto (link), PIX copia e cola e linha digitável. */
function pagamento(f: FaturaEmail, cor: string) {
  let h = '';
  if (f.link_boleto) h += botao('Abrir boleto', f.link_boleto, cor);
  if (f.pix) {
    h += `<p style="margin:22px 0 6px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;color:${COR.tinta};">Pague com PIX copia e cola</p>
<p style="margin:0 0 8px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:${COR.cinza};">Copie o código abaixo e cole na opção <strong>PIX copia e cola</strong> do app do seu banco.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="background:#ffffff;border:1px dashed ${COR.indigo};border-radius:6px;padding:12px 14px;font-family:'Courier New',Courier,monospace;font-size:12px;line-height:1.5;color:${COR.tinta};word-break:break-all;">${esc(f.pix)}</td>
</tr></table>`;
  }
  if (f.linha_digitavel) {
    h += `<p style="margin:18px 0 4px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:${COR.cinza};">Linha digitável do boleto</p>
<p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:13px;color:${COR.tinta};word-break:break-all;">${esc(f.linha_digitavel)}</p>`;
  }
  return h;
}

function p(texto: string, extra = '') {
  return `<p style="margin:0 0 14px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:${COR.tinta};${extra}">${texto}</p>`;
}

function layout(titulo: string, faixa: string, corFaixa: string, corpo: string, previa: string) {
  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(titulo)}</title></head>
<body style="margin:0;padding:0;background:${COR.fundo};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(previa)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COR.fundo};"><tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;">
<tr><td align="center" style="padding:26px 32px 18px 32px;"><img src="${LOGO}" width="190" alt="Viva Net Telecom" style="display:block;border:0;height:auto;"></td></tr>
<tr><td align="center" style="background:${corFaixa};padding:11px 32px;"><span style="font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#ffffff;">${esc(faixa)}</span></td></tr>
<tr><td style="padding:30px 36px 18px 36px;">${corpo}</td></tr>
<tr><td style="padding:0 36px 26px 36px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COR.caixa};border-radius:6px;"><tr><td style="padding:14px 18px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;color:${COR.cinza};">
Precisa de ajuda? Fale com o Vitor no <a href="${CHAT}" style="color:${COR.indigo};font-weight:700;">Vivanet Chat</a>, a qualquer hora.
</td></tr></table></td></tr>
<tr><td style="background:${COR.indigo};padding:18px 32px;text-align:center;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.7;color:#E6E6F7;">
<a href="${CHAT}" style="color:#ffffff;text-decoration:none;font-weight:700;">Vivanet Chat</a> &nbsp;·&nbsp;
<a href="${WHATSAPP.link}" style="color:#ffffff;text-decoration:none;">WhatsApp ${WHATSAPP.texto}</a> &nbsp;·&nbsp;
<a href="mailto:${EMAIL_ATENDIMENTO}" style="color:#ffffff;text-decoration:none;">${EMAIL_ATENDIMENTO}</a><br>
Viva Net Telecom · MJP TELECOM LTDA · CNPJ 34.676.479/0001-00<br>
<a href="${SITE}" style="color:#ffffff;text-decoration:none;">vivanettelecom.com.br</a>
</td></tr>
</table></td></tr></table></body></html>`;
}

function textoPagamento(f: FaturaEmail) {
  return [
    `Vencimento: ${dataBR(f.vencimento)} · Valor: ${brl(f.valor)}`,
    f.link_boleto ? `Boleto: ${f.link_boleto}` : '',
    f.pix ? `PIX copia e cola: ${f.pix}` : '',
    f.linha_digitavel ? `Linha digitável: ${f.linha_digitavel}` : '',
  ].filter(Boolean).join('\n');
}

const RODAPE_TXT = `\n\nPrecisa de ajuda? Fale com o Vitor no Vivanet Chat: ${CHAT}\nViva Net Telecom · MJP TELECOM LTDA · CNPJ 34.676.479/0001-00`;

// ---------------------------------------------------------------- etapas da régua e fatura avulsa

interface TextoEtapa { assunto: string; faixa: string; cor: string; intro: string; depois: string }

function textoEtapa(etapa: EtapaRegua | 'FATURA', nome: string): TextoEtapa {
  switch (etapa) {
    case 'PRE_FATURA_D5':
      return { assunto: `${nome}, sua fatura Viva Net já está disponível 💙`, faixa: 'Fatura disponível', cor: COR.indigo,
        intro: `Oi, ${nome}! Aqui é o Vitor, da Viva Net 😊 Passando para avisar que a sua próxima fatura já está disponível.`,
        depois: 'Manter os pagamentos em dia garante a sua conexão funcionando sem interrupções 💙' };
    case 'VENCE_AMANHA':
      return { assunto: 'Sua fatura Viva Net vence amanhã 📌', faixa: 'Vence amanhã', cor: COR.indigo,
        intro: `Oi, ${nome}! Aqui é o Vitor 😊 Só um lembrete: a sua fatura Viva Net vence amanhã.`,
        depois: 'Se já pagou, pode desconsiderar este aviso 💙' };
    case 'VENCE_HOJE':
      return { assunto: 'Hoje é o vencimento da sua fatura Viva Net', faixa: 'Vence hoje', cor: COR.indigo,
        intro: `Oi, ${nome}! Aqui é o Vitor, da Viva Net 😊 Hoje é o dia do vencimento da sua fatura.`,
        depois: 'Manter a fatura em dia evita bloqueios. Se já pagou, pode desconsiderar este e-mail.' };
    case 'ATRASO_D2':
      return { assunto: 'Identificamos uma fatura pendente na sua Viva Net', faixa: 'Fatura pendente', cor: COR.vinho,
        intro: `Oi, ${nome}. Aqui é o Vitor, da Viva Net. Até o momento, não identificamos o pagamento da fatura abaixo.`,
        depois: 'Se o pagamento já foi feito, desconsidere esta mensagem: a compensação bancária pode levar algumas horas.' };
    case 'PRE_BLOQUEIO_D4':
      return { assunto: '⚠️ Evite o bloqueio da sua conexão Viva Net', faixa: 'Aviso de bloqueio', cor: COR.vinho,
        intro: `Oi, ${nome}. Aqui é o Vitor. A sua fatura ainda está em aberto, e queremos te ajudar a evitar o bloqueio automático da conexão.`,
        depois: '<strong>O bloqueio automático pode acontecer em até 24 horas.</strong> Pagando com PIX, a liberação é automática após a confirmação. Se já pagou, desconsidere este e-mail.' };
    case 'FATURA':
      return { assunto: 'Sua fatura Viva Net', faixa: 'Sua fatura', cor: COR.indigo,
        intro: `Oi, ${nome}! Conforme solicitado, segue a sua fatura Viva Net.`,
        depois: 'Qualquer dúvida, estamos à disposição 💙' };
  }
}

export function emailFatura(etapa: EtapaRegua | 'FATURA', c: ContatoContrato, f: FaturaEmail) {
  const nome = primeiroNome(c.nome);
  const t = textoEtapa(etapa, nome);
  const rotulo = etapa === 'ATRASO_D2' || etapa === 'PRE_BLOQUEIO_D4' ? 'Vencimento original' : 'Vencimento';
  const corpo = p(t.intro) + caixaFatura(f, t.cor, rotulo) + pagamento(f, t.cor) + '<div style="height:18px;"></div>' + p(t.depois, `color:${COR.cinza};font-size:14px;`);
  const textoLimpo = t.depois.replace(/<[^>]+>/g, '');
  return {
    assunto: t.assunto,
    html: layout(t.assunto, t.faixa, t.cor, corpo, `${dataBR(f.vencimento)} · ${brl(f.valor)}`),
    texto: `${t.intro}\n\n${textoPagamento(f)}\n\n${textoLimpo}${RODAPE_TXT}`,
  };
}

// ---------------------------------------------------------------- lista de faturas em aberto

export function emailLista(c: ContatoContrato, faturas: FaturaEmail[]) {
  const nome = primeiroNome(c.nome);
  const assunto = 'Suas faturas Viva Net em aberto';
  const blocos = faturas.slice(0, 6).map((f, i) =>
    (i > 0 ? `<div style="border-top:1px solid ${COR.linha};margin:22px 0;"></div>` : '') + caixaFatura(f, COR.indigo) + pagamento(f, COR.indigo)).join('');
  const resto = faturas.length > 6 ? p(`Há mais ${faturas.length - 6} fatura(s) em aberto. Fale com o Vitor no Vivanet Chat para receber as demais.`, `color:${COR.cinza};font-size:14px;`) : '';
  const corpo = p(`Oi, ${nome}! Conforme solicitado, seguem as suas faturas em aberto na Viva Net.`) + blocos + '<div style="height:18px;"></div>' + resto;
  return {
    assunto,
    html: layout(assunto, 'Faturas em aberto', COR.indigo, corpo, `${faturas.length} fatura(s) em aberto`),
    texto: `Oi, ${nome}! Seguem as suas faturas em aberto na Viva Net.\n\n${faturas.slice(0, 6).map(textoPagamento).join('\n\n')}${RODAPE_TXT}`,
  };
}

// ---------------------------------------------------------------- boas-vindas

export function emailBoasVindas(c: ContatoContrato) {
  const nome = primeiroNome(c.nome);
  const assunto = `Bem-vindo(a) à Viva Net, ${nome}! Sua conexão foi ativada 🎉`;
  const plano = planoAmigavel(c.plano);
  const linha = (rotulo: string, valor: string) =>
    `<td width="50%" style="font-family:Arial,Helvetica,sans-serif;"><span style="font-size:12px;color:${COR.cinza};">${rotulo}</span><br><strong style="font-size:17px;color:${COR.tinta};">${esc(valor)}</strong></td>`;
  const canal = (titulo: string, texto: string, link: string, rotuloLink: string) =>
    `<tr><td style="padding:12px 0;border-top:1px solid ${COR.linha};font-family:Arial,Helvetica,sans-serif;">
<strong style="font-size:14px;color:${COR.tinta};">${titulo}</strong><br><span style="font-size:13px;color:${COR.cinza};line-height:1.6;">${texto}</span><br>
<a href="${link}" style="font-size:13px;font-weight:700;color:${COR.indigo};text-decoration:none;">${rotuloLink} →</a></td></tr>`;
  const corpo =
    p(`Oi, ${nome}! Aqui é o Vitor, da Viva Net 😊`) +
    p('É uma alegria ter você com a gente! A partir de agora, você conta com internet de fibra óptica de verdade para trabalhar, estudar e se divertir, com o suporte que você merece. Seja muito bem-vindo(a)! 💙') +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COR.caixa};border-left:4px solid ${COR.indigo};border-radius:4px;margin:18px 0;"><tr><td style="padding:16px 20px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${linha('Plano contratado', plano)}${linha('Vencimento', c.vencimento_dia ? 'Todo dia ' + c.vencimento_dia : '-')}</tr></table>
</td></tr></table>` +
    p('Suas faturas chegam por e-mail, com boleto, PIX copia e cola e linha digitável. É só pagar pelo meio que preferir.', `color:${COR.cinza};font-size:14px;`) +
    `<p style="margin:22px 0 4px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${COR.vinho};">Fale com a gente</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${canal('Vivanet Chat', 'Nosso atendimento principal: suporte, financeiro e tudo sobre a sua conexão, a qualquer hora.', CHAT, 'Abrir o Vivanet Chat')}
${canal('WhatsApp ' + WHATSAPP.texto, '2ª via de fatura, PIX e contratação.', WHATSAPP.link, 'Chamar no WhatsApp')}
${canal('E-mail', EMAIL_ATENDIMENTO, 'mailto:' + EMAIL_ATENDIMENTO, 'Enviar e-mail')}
</table>`;
  return {
    assunto,
    html: layout(assunto, 'Sua conexão foi ativada', COR.indigo, corpo, `Plano ${plano} ativado`),
    texto: `Oi, ${nome}! Aqui é o Vitor, da Viva Net. Seja muito bem-vindo(a)!\n\nPlano: ${plano}\nVencimento: ${c.vencimento_dia ? 'todo dia ' + c.vencimento_dia : '-'}\n\nVivanet Chat: ${CHAT}\nWhatsApp: ${WHATSAPP.texto}\nE-mail: ${EMAIL_ATENDIMENTO}${RODAPE_TXT}`,
  };
}
