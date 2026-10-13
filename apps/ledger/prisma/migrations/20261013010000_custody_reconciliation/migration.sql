CREATE TABLE custody_reconciliations (run_id UUID PRIMARY KEY,domain_id TEXT NOT NULL,reset_epoch TEXT NOT NULL,wallet_id UUID NOT NULL,digest TEXT NOT NULL,evidence JSONB NOT NULL,report JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX custody_reconciliations_scope ON custody_reconciliations(domain_id,reset_epoch,wallet_id,created_at);
CREATE FUNCTION retain_custody_reconciliation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Reconciliation evidence is immutable'; END $$;
CREATE TRIGGER retain_custody_reconciliation BEFORE UPDATE OR DELETE ON custody_reconciliations FOR EACH ROW EXECUTE FUNCTION retain_custody_reconciliation();
