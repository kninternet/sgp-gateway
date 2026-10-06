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

-- Cobertura por bairro/cidade (comparação sem acento e sem caixa) e condições de venda por POP.
CREATE TABLE IF NOT EXISTS {{schema}}.cobertura (
  id      serial PRIMARY KEY,
  pop_id  int  NOT NULL,
  cidade  text NOT NULL,
  bairro  text NOT NULL,
  ativo   boolean NOT NULL DEFAULT true,
  UNIQUE (pop_id, cidade, bairro)
);

CREATE TABLE IF NOT EXISTS {{schema}}.pops_venda (
  pop_id           int PRIMARY KEY,
  vencimentos      int[] NOT NULL,
  taxa_instalacao  numeric(10,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS {{schema}}.planos_venda (
  id            serial PRIMARY KEY,
  pop_id        int  NOT NULL,
  nome          text NOT NULL,
  valor         numeric(10,2) NOT NULL,
  sgp_plano_id  int,
  ativo         boolean NOT NULL DEFAULT true,
  UNIQUE (pop_id, nome)
);

-- Registro de cada tentativa de cadastro (idempotência e auditoria). Sem senha nem token.
CREATE TABLE IF NOT EXISTS {{schema}}.cadastros (
  id          bigserial PRIMARY KEY,
  criado_em   timestamptz NOT NULL DEFAULT now(),
  canal_id    int,
  conversa    text,
  cpfcnpj     text NOT NULL,
  pop_id      int,
  plano       text,
  vencimento  int,
  status      text NOT NULL,   -- ok | cpf_existente | recusado | erro
  cliente_id  bigint,
  erro        text
);
CREATE INDEX IF NOT EXISTS cadastros_cpf ON {{schema}}.cadastros (cpfcnpj);
CREATE INDEX IF NOT EXISTS cadastros_canal_ts ON {{schema}}.cadastros (canal_id, criado_em);

-- v4.1: identificação pelo número do WhatsApp, inclusive de quem só fez cadastro pelo Vitor.
-- O nome serve só para conferir o titular informado pela pessoa; nunca vai para o modelo.
ALTER TABLE {{schema}}.cadastros ADD COLUMN IF NOT EXISTS celular_norm text;
ALTER TABLE {{schema}}.cadastros ADD COLUMN IF NOT EXISTS nome text;
CREATE INDEX IF NOT EXISTS cadastros_celular ON {{schema}}.cadastros (celular_norm);
