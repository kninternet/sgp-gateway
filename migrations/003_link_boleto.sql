-- Domínio público dos boletos por tenant (o cliente nunca vê o domínio da central do SGP).
-- Links fora de /boleto/ não são repassados quando a coluna está preenchida.
ALTER TABLE gateway.tenants ADD COLUMN IF NOT EXISTS link_boleto_base text;
UPDATE gateway.tenants SET link_boleto_base = 'https://boleto.vivanettelecom.com.br'
 WHERE id = 'vivanet' AND link_boleto_base IS NULL;
