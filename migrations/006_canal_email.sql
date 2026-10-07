-- Envio manual de e-mails (fatura e lista) só para canais autorizados.
ALTER TABLE gateway.canais ADD COLUMN IF NOT EXISTS permite_email boolean NOT NULL DEFAULT false;
