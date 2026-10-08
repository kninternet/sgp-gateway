-- Painel do atendente (Dashboard App do Chatwoot): leitura da ficha completa do contrato.
ALTER TABLE gateway.canais ADD COLUMN IF NOT EXISTS permite_painel boolean NOT NULL DEFAULT false;
