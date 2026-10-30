-- Régua por SMS e link pessoal da Área do Cliente. Idempotente.
-- Parte 1 (gateway): endereço público da Área de cada tenant, usado para montar o link pessoal.
ALTER TABLE gateway.tenants ADD COLUMN IF NOT EXISTS area_link_base text;
UPDATE gateway.tenants SET area_link_base = 'https://area.vivanettelecom.com.br'
 WHERE id = 'vivanet' AND area_link_base IS NULL;

-- Parte 2 (tenant vivanet): as mesmas tabelas estão no fim de migrations/tenant.sql para tenants novos.
-- Links pessoais: um código por envio, ligado a um contrato, com validade e contagem de cliques.
CREATE TABLE IF NOT EXISTS vivanet.links_area (
  codigo          text PRIMARY KEY,
  contrato_id     bigint NOT NULL,
  etapa           text NOT NULL,
  canal           text NOT NULL,                  -- sms | email
  criado_em       timestamptz NOT NULL DEFAULT now(),
  expira_em       timestamptz NOT NULL,
  cliques         int NOT NULL DEFAULT 0,
  primeiro_clique timestamptz,
  ultimo_clique   timestamptz
);
CREATE INDEX IF NOT EXISTS links_area_contrato ON vivanet.links_area (contrato_id);
CREATE INDEX IF NOT EXISTS links_area_criado ON vivanet.links_area (criado_em);

-- Régua por SMS: cada etapa de cada fatura sai uma única vez (reativação: uma vez por mês, fatura_id nulo).
CREATE TABLE IF NOT EXISTS vivanet.sms_envios (
  id           bigserial PRIMARY KEY,
  etapa        text NOT NULL,                     -- VENCE_HOJE | PRE_BLOQUEIO_D4 | SUSPENSO_D6 | REATIVACAO_AAAAMM
  contrato_id  bigint NOT NULL,
  fatura_id    bigint,
  numero       text NOT NULL,                     -- DDD + 9 + 8 dígitos
  link_codigo  text,
  ref_id       text,                              -- identificador devolvido pela Loca
  status       text NOT NULL,                     -- enviado | erro
  erro         text,
  entrega      text,                              -- T transmitido | P pendente | F falha (consulta do dia seguinte)
  entrega_desc text,
  entrega_em   timestamptz,
  enviado_em   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sms_envios_unico ON vivanet.sms_envios (etapa, contrato_id, coalesce(fatura_id, 0))
  WHERE status = 'enviado';
CREATE INDEX IF NOT EXISTS sms_envios_data ON vivanet.sms_envios (enviado_em);
CREATE INDEX IF NOT EXISTS sms_envios_ref ON vivanet.sms_envios (ref_id);
