CREATE TABLE ledger_attempt_progress (
 attempt_id uuid PRIMARY KEY REFERENCES ledger_execution_attempts(id),
 reported_state text NOT NULL DEFAULT 'preparing',
 reported_revision integer NOT NULL DEFAULT 0 CHECK(reported_revision>=0),
 reported_digest text CHECK(reported_digest ~ '^[0-9a-f]{64}$'),
 canonical_state text NOT NULL DEFAULT 'none' CHECK(canonical_state IN ('none','confirmed','failed','reverted')),
 canonical_revision integer NOT NULL DEFAULT 0 CHECK(canonical_revision>=0),
 origin text NOT NULL CHECK(origin IN ('live','migration_projection')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(reported_state IN ('unknown','preparing','signing','signed','queued','submitted','attention','confirmed','failed'))
);
CREATE TABLE ledger_attempt_reports (
 attempt_id uuid NOT NULL REFERENCES ledger_execution_attempts(id),
 revision integer NOT NULL CHECK(revision>0),
 data_digest text NOT NULL CHECK(data_digest ~ '^[0-9a-f]{64}$'),
 payload jsonb NOT NULL,
 disposition text NOT NULL CHECK(disposition IN ('applied','ignored_stale','terminal_observation','projection_replay')),
 received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(attempt_id,revision)
);

-- Preserve the prior revision fence, but do not invent missing historical report payloads.
INSERT INTO ledger_attempt_progress(attempt_id,reported_state,reported_revision,canonical_state,canonical_revision,origin)
SELECT a.id,
 CASE WHEN o.attempt_revision=0 THEN 'preparing'
      WHEN o.settlement_revision=0 AND o.state IN ('preparing','signing','signed','queued','submitted','attention','confirmed','failed') THEN o.state
      ELSE 'unknown' END,
 o.attempt_revision,
 CASE WHEN o.state='reverted' THEN 'reverted'
      WHEN o.settlement_payload IS NOT NULL AND o.settlement_revision>0 AND o.settlement_outcome IN ('confirmed','failed') THEN o.settlement_outcome
      ELSE 'none' END,
 o.settlement_revision,'migration_projection'
FROM ledger_execution_attempts a JOIN exchange_operations o ON o.id=a.operation_id;

CREATE FUNCTION initialize_ledger_attempt_progress() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o exchange_operations%ROWTYPE;
BEGIN
 SELECT * INTO STRICT o FROM exchange_operations WHERE id=NEW.operation_id;
 INSERT INTO ledger_attempt_progress(attempt_id,reported_state,reported_revision,canonical_state,canonical_revision,origin)
 VALUES(NEW.id,
 CASE WHEN o.attempt_revision=0 THEN 'preparing'
      WHEN o.settlement_revision=0 AND o.state IN ('preparing','signing','signed','queued','submitted','attention','confirmed','failed') THEN o.state
      ELSE 'unknown' END,
 o.attempt_revision,
 CASE WHEN o.state='reverted' THEN 'reverted'
      WHEN o.settlement_payload IS NOT NULL AND o.settlement_revision>0 AND o.settlement_outcome IN ('confirmed','failed') THEN o.settlement_outcome
      ELSE 'none' END,
 o.settlement_revision,'live');
 RETURN NEW;
END;
$$;
CREATE TRIGGER initialize_attempt_progress AFTER INSERT ON ledger_execution_attempts
 FOR EACH ROW EXECUTE FUNCTION initialize_ledger_attempt_progress();

CREATE FUNCTION protect_ledger_attempt_report() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Attempt report history is immutable';
END;
$$;
CREATE TRIGGER immutable_ledger_attempt_report BEFORE UPDATE OR DELETE ON ledger_attempt_reports
 FOR EACH ROW EXECUTE FUNCTION protect_ledger_attempt_report();

CREATE FUNCTION protect_ledger_attempt_progress() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Attempt progress history is retained'; END IF;
 IF ROW(NEW.attempt_id,NEW.origin,NEW.created_at) IS DISTINCT FROM ROW(OLD.attempt_id,OLD.origin,OLD.created_at) THEN
  RAISE EXCEPTION 'Attempt progress identity is immutable';
 END IF;
 IF NEW.reported_revision<OLD.reported_revision OR NEW.canonical_revision<OLD.canonical_revision THEN
  RAISE EXCEPTION 'Attempt progress revisions cannot regress';
 END IF;
 IF NEW.reported_revision=OLD.reported_revision AND ROW(NEW.reported_state,NEW.reported_digest) IS DISTINCT FROM ROW(OLD.reported_state,OLD.reported_digest) THEN
  IF NOT (OLD.reported_revision>0 AND OLD.reported_digest IS NULL AND NEW.reported_digest IS NOT NULL
          AND (OLD.reported_state='unknown' OR OLD.reported_state=NEW.reported_state)) THEN
   RAISE EXCEPTION 'Attempt report revision content is immutable';
  END IF;
 END IF;
 IF NEW.canonical_revision=OLD.canonical_revision AND NEW.canonical_state<>OLD.canonical_state THEN
  RAISE EXCEPTION 'Canonical attempt revision cannot change outcome';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER guard_ledger_attempt_progress BEFORE UPDATE OR DELETE ON ledger_attempt_progress
 FOR EACH ROW EXECUTE FUNCTION protect_ledger_attempt_progress();


-- Keep projection truth consistent during mixed-version deployment. Older workers
-- update the retained operation fields; they cannot supply missing report bodies.
CREATE FUNCTION sync_ledger_attempt_projection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE canonical_text text;
BEGIN
 IF NEW.attempt_id IS NULL THEN RETURN NEW; END IF;
 UPDATE ledger_attempt_progress
 SET reported_revision=NEW.attempt_revision,reported_state=NEW.state,reported_digest=NULL,updated_at=now()
 WHERE attempt_id=NEW.attempt_id AND reported_revision<NEW.attempt_revision;
 canonical_text=CASE WHEN NEW.state='reverted' THEN 'reverted'
   WHEN NEW.settlement_payload IS NOT NULL AND NEW.settlement_revision>0 AND NEW.settlement_outcome IN ('confirmed','failed') THEN NEW.settlement_outcome
   ELSE 'none' END;
 UPDATE ledger_attempt_progress SET canonical_state=canonical_text,canonical_revision=NEW.settlement_revision,updated_at=now()
 WHERE attempt_id=NEW.attempt_id AND ROW(canonical_state,canonical_revision) IS DISTINCT FROM ROW(canonical_text,NEW.settlement_revision);
 RETURN NEW;
END;
$$;
CREATE TRIGGER sync_attempt_projection AFTER UPDATE OF state,attempt_revision,settlement_revision,settlement_payload,settlement_outcome ON exchange_operations
 FOR EACH ROW EXECUTE FUNCTION sync_ledger_attempt_projection();
