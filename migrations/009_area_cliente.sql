-- Área do Cliente (site): login por CPF + código no e-mail do cadastro. Idempotente.
ALTER TABLE gateway.canais ADD COLUMN IF NOT EXISTS permite_area boolean NOT NULL DEFAULT false;
