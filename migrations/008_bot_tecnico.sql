-- Bot de apoio técnico (Telegram): tenant interno, permissão de status CRM e tabelas do bot. Idempotente.

-- Permissão nova por canal (padrão 006/007)
ALTER TABLE gateway.canais ADD COLUMN IF NOT EXISTS permite_status_crm boolean NOT NULL DEFAULT false;

-- Tenant para ferramentas internas: credencial SGP própria, sem POPs (o sync não copia nada)
INSERT INTO gateway.tenants (id, nome, sgp_base_url, sgp_app, sgp_token_env, schema_name,
                             pops_permitidos, sgp_write_app, sgp_write_token_env)
SELECT 'interno', 'Ferramentas internas', t.sgp_base_url, 'bot_tecnico', 'SGP_TOKEN_BOT_TECNICO', 'interno',
       '{}', 'bot_tecnico', 'SGP_TOKEN_BOT_TECNICO'
  FROM gateway.tenants t WHERE t.id = 'vivanet'
ON CONFLICT (id) DO NOTHING;

CREATE SCHEMA IF NOT EXISTS interno;

-- Técnicos e papéis (autorização pelo ID numérico do Telegram)
CREATE TABLE IF NOT EXISTS interno.tecnicos_bot (
  telegram_id   bigint PRIMARY KEY,
  nome          text NOT NULL,
  username      text,
  sgp_login     text,
  papel         text NOT NULL DEFAULT 'tecnico' CHECK (papel IN ('tecnico','head','admin')),
  status        text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','ativo','recusado','revogado')),
  aprovado_por  bigint,
  aprovado_em   timestamptz,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

-- Estado da conversa (fluxos em etapas, expira em minutos)
CREATE TABLE IF NOT EXISTS interno.bot_sessoes (
  telegram_id bigint PRIMARY KEY,
  etapa       text NOT NULL,
  dados       jsonb NOT NULL DEFAULT '{}',
  expira_em   timestamptz NOT NULL
);

-- Auditoria de negócio do bot (a técnica fica em gateway.auditoria)
CREATE TABLE IF NOT EXISTS interno.bot_acoes (
  id              bigserial PRIMARY KEY,
  telegram_id     bigint NOT NULL,
  sgp_login       text,
  acao            text NOT NULL,
  cliente_id      bigint,
  cpfcnpj_mascara text,
  status_anterior text,
  status_novo     text,
  resultado       text NOT NULL,
  detalhe         text,
  criado_em       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bot_acoes_criado_em ON interno.bot_acoes (criado_em);
CREATE INDEX IF NOT EXISTS bot_acoes_cliente   ON interno.bot_acoes (cliente_id);

-- Configuração (ex.: head_telegram_id)
CREATE TABLE IF NOT EXISTS interno.bot_config (
  chave text PRIMARY KEY,
  valor text NOT NULL
);

-- Admin
INSERT INTO interno.tecnicos_bot (telegram_id, nome, papel, status, aprovado_em)
VALUES (8315783423, 'Otávio Falcone', 'admin', 'ativo', now())
ON CONFLICT (telegram_id) DO NOTHING;
