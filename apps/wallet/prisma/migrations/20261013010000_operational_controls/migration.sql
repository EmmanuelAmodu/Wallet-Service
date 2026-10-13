CREATE TABLE operations_runs (id UUID PRIMARY KEY,sequence BIGSERIAL UNIQUE,domain_id TEXT NOT NULL,reset_epoch TEXT NOT NULL,wallet_id UUID NOT NULL,state TEXT NOT NULL,evidence JSONB,report JSONB,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX operations_runs_scope ON operations_runs(domain_id,reset_epoch,wallet_id,created_at);
CREATE TABLE operations_commands (id UUID PRIMARY KEY,sequence BIGSERIAL UNIQUE,domain_id TEXT NOT NULL,reset_epoch TEXT NOT NULL,actor TEXT NOT NULL,reason TEXT NOT NULL,digest TEXT NOT NULL,request JSONB NOT NULL,state TEXT NOT NULL,result JSONB,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX operations_commands_scope ON operations_commands(domain_id,reset_epoch,created_at);
CREATE TABLE operations_alerts (id TEXT PRIMARY KEY,domain_id TEXT NOT NULL,reset_epoch TEXT NOT NULL,severity TEXT NOT NULL,state TEXT NOT NULL,evidence JSONB NOT NULL,review JSONB,first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX operations_alerts_scope ON operations_alerts(domain_id,reset_epoch,state);
CREATE TABLE operations_metric_reports (id TEXT PRIMARY KEY,domain_id TEXT NOT NULL,reset_epoch TEXT NOT NULL,consumer TEXT NOT NULL,occurred_at TIMESTAMPTZ NOT NULL,metrics JSONB NOT NULL);
CREATE FUNCTION retain_operations_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Operational evidence is retained'; END IF;
 IF TG_TABLE_NAME='operations_commands' AND (to_jsonb(NEW)-ARRAY['state','result','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','result','updated_at']) THEN RAISE EXCEPTION 'Operator command identity is immutable'; END IF;
 IF TG_TABLE_NAME='operations_runs' AND (to_jsonb(NEW)-ARRAY['state','evidence','report','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','evidence','report','updated_at']) THEN RAISE EXCEPTION 'Custody sample identity is immutable'; END IF;
 IF TG_TABLE_NAME='operations_runs' THEN
 IF OLD.evidence IS NOT NULL AND NEW.evidence IS DISTINCT FROM OLD.evidence THEN RAISE EXCEPTION 'Canonical sample evidence is immutable'; END IF;
 IF OLD.report IS NOT NULL AND NEW.report IS DISTINCT FROM OLD.report THEN RAISE EXCEPTION 'Reconciliation evidence is immutable'; END IF;
 END IF;
 RETURN NEW; END $$;
CREATE TRIGGER retain_operations_commands BEFORE UPDATE OR DELETE ON operations_commands FOR EACH ROW EXECUTE FUNCTION retain_operations_audit();
CREATE TRIGGER retain_operations_runs BEFORE UPDATE OR DELETE ON operations_runs FOR EACH ROW EXECUTE FUNCTION retain_operations_audit();
CREATE TABLE operations_funding_gates(domain_id TEXT NOT NULL,reset_epoch TEXT NOT NULL,enabled BOOLEAN NOT NULL DEFAULT true,reason TEXT NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(domain_id,reset_epoch));
