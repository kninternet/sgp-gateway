-- Cobertura e condições de venda da Viva Net. Idempotente: reflete o estado desejado.
-- Vendas de Nova Grécia e Tribobó no POP 100072 (linha de planos TRIBOBO).
DELETE FROM vivanet.cobertura WHERE pop_id = 22 AND bairro IN ('Pavuna', 'Nova Grécia', 'Tribobó');

INSERT INTO vivanet.cobertura (pop_id, cidade, bairro) VALUES
  (100072, 'São Gonçalo', 'Nova Grécia'),
  (100072, 'São Gonçalo', 'Tribobó')
ON CONFLICT DO NOTHING;

INSERT INTO vivanet.pops_venda (pop_id, vencimentos, taxa_instalacao) VALUES
  (22,     '{5,10,15}', 160.00),
  (100072, '{5,10,15}', 160.00)
ON CONFLICT DO NOTHING;

INSERT INTO vivanet.planos_venda (pop_id, nome, valor, sgp_plano_id) VALUES
  (22,     '350 Mega', 120.00, 101327),
  (100072, '350 Mega', 120.00, 101315),
  (100072, '450 Mega', 150.00, 101316),
  (100072, '600 Mega', 170.00, 101318),
  (100072, '800 Mega', 200.00, 101319)
ON CONFLICT DO NOTHING;
