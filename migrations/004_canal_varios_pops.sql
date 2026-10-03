-- Um canal pode atender mais de um POP do mesmo tenant.
-- pop_id fica como legado; a lista "pops" é a que vale.
ALTER TABLE gateway.canais ADD COLUMN IF NOT EXISTS pops int[];
UPDATE gateway.canais SET pops = ARRAY[pop_id] WHERE pops IS NULL;
ALTER TABLE gateway.canais ALTER COLUMN pops SET NOT NULL;
