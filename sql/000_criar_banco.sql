-- Rodar UMA vez com o netecom_admin, no banco "postgres".
-- [VPS — webprod (177.86.157.241)]
--   psql -h 10.73.98.16 -U netecom_admin -d postgres -f sql/000_criar_banco.sql
-- Depois defina a senha sem deixá-la no histórico:
--   psql -h 10.73.98.16 -U netecom_admin -d postgres -c '\password sgp_gateway_app'

CREATE ROLE sgp_gateway_app LOGIN;
CREATE DATABASE sgp_gateway OWNER sgp_gateway_app;
REVOKE ALL ON DATABASE sgp_gateway FROM PUBLIC;
