-- Template aplicado a cada tenant ({{schema}} é substituído e validado). Idempotente.
CREATE SCHEMA IF NOT EXISTS {{schema}};

CREATE TABLE IF NOT EXISTS {{schema}}.clientes (
  id            bigint PRIMARY KEY,          -- id do cliente no SGP
  nome          text NOT NULL,
  cpfcnpj       text NOT NULL,               -- só dígitos
  tipo          text,
  sync_run      uuid NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clientes_cpfcnpj ON {{schema}}.clientes (cpfcnpj);

CREATE TABLE IF NOT EXISTS {{schema}}.contratos (
  id             bigint PRIMARY KEY,         -- id do contrato no SGP
  cliente_id     bigint NOT NULL REFERENCES {{schema}}.clientes(id) ON DELETE CASCADE,
  pop_id         int NOT NULL,
  status         text,
  motivo_status  text,
  vencimento     text,
  forma_cobranca text,
  plano          text,
  sync_run       uuid NOT NULL,
  atualizado_em  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contratos_cliente ON {{schema}}.contratos (cliente_id);
CREATE INDEX IF NOT EXISTS contratos_pop ON {{schema}}.contratos (pop_id);

CREATE TABLE IF NOT EXISTS {{schema}}.contatos (
  cliente_id bigint NOT NULL REFERENCES {{schema}}.clientes(id) ON DELETE CASCADE,
  tipo       text NOT NULL,                  -- telefones | celulares | emails | outros
  valor      text NOT NULL,
  valor_norm text NOT NULL                   -- telefone: dígitos sem DDI; e-mail: minúsculo
);
CREATE INDEX IF NOT EXISTS contatos_norm ON {{schema}}.contatos (valor_norm);
CREATE INDEX IF NOT EXISTS contatos_cliente ON {{schema}}.contatos (cliente_id);

CREATE TABLE IF NOT EXISTS {{schema}}.sync_log (
  id            bigserial PRIMARY KEY,
  pop_id        int NOT NULL,
  iniciado_em   timestamptz NOT NULL DEFAULT now(),
  finalizado_em timestamptz,
  clientes      int,
  contratos     int,
  removidos     int,
  status        text,
  erro          text
);
