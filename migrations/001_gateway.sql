-- Plano de controle: tenants, canais e auditoria. Idempotente.
CREATE SCHEMA IF NOT EXISTS gateway;

CREATE TABLE IF NOT EXISTS gateway.tenants (
  id              text PRIMARY KEY,
  nome            text NOT NULL,
  sgp_base_url    text NOT NULL,
  sgp_app         text NOT NULL,
  sgp_token_env   text NOT NULL,           -- nome da variável de ambiente com o token
  schema_name     text NOT NULL UNIQUE CHECK (schema_name ~ '^[a-z_][a-z0-9_]{0,40}$'),
  pops_permitidos int[] NOT NULL,
  empresa_cnpj    text,                    -- filtro extra na Fatura – Listar (opcional)
  gerar_os_2via   boolean NOT NULL DEFAULT false,
  ativo           boolean NOT NULL DEFAULT true,
  criado_em       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gateway.canais (
  id               serial PRIMARY KEY,
  tenant_id        text NOT NULL REFERENCES gateway.tenants(id),
  nome             text NOT NULL,
  pop_id           int  NOT NULL,          -- cada canal opera em UM POP
  permite_telefone boolean NOT NULL DEFAULT false, -- só canais com telefone verificado (ex.: WhatsApp)
  key_hash         text NOT NULL UNIQUE,   -- sha256 da chave; a chave em si nunca é gravada
  ativo            boolean NOT NULL DEFAULT true,
  criado_em        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, nome)
);

CREATE TABLE IF NOT EXISTS gateway.auditoria (
  id          bigserial PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  tenant_id   text,
  canal_id    int,
  rota        text NOT NULL,
  cliente_id  bigint,
  contrato_id bigint,
  status      int NOT NULL,
  duracao_ms  int,
  erro        text
);
CREATE INDEX IF NOT EXISTS auditoria_ts ON gateway.auditoria (ts);
