CREATE TABLE ledger_attempt_canonical_events (
 attempt_id uuid NOT NULL REFERENCES ledger_execution_attempts(id),
 revision integer NOT NULL CHECK(revision>0),
 event_type text NOT NULL CHECK(event_type IN ('settlement.requested.v1','settlement.reverted.v1')),
 data_digest text NOT NULL CHECK(data_digest ~ '^[0-9a-f]{64}$'),
 payload jsonb NOT NULL,
 origin text NOT NULL CHECK(origin IN ('live','migration_projection')),
 received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(attempt_id,revision)
);

-- SQL JSONB digests are database canonical digests, independent of JS serialization.
CREATE FUNCTION retain_ledger_canonical_event(body jsonb, provenance text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a ledger_execution_attempts%ROWTYPE;
DECLARE previous ledger_attempt_canonical_events%ROWTYPE;
DECLARE revision_number integer;
DECLARE digest_text text;
BEGIN
 IF body IS NULL OR body='null'::jsonb THEN RETURN; END IF;
 SELECT * INTO a FROM ledger_execution_attempts WHERE id=(body->>'attemptId')::uuid;
 -- A reversal may arrive before its original intent. Bind it when that intent arrives.
 IF NOT FOUND THEN RETURN; END IF;
 IF body->>'operationId' IS DISTINCT FROM a.operation_id::text
 OR body->>'domainId' IS DISTINCT FROM a.domain_id OR body->>'resetEpoch' IS DISTINCT FROM a.reset_epoch
 OR body->>'requestDigest' IS DISTINCT FROM a.request_digest
 OR (body ? 'customerId' AND body->>'customerId' IS DISTINCT FROM a.customer_id::text)
 OR body->>'type' NOT IN ('settlement.requested.v1','settlement.reverted.v1')
 OR body->'data' IS NULL THEN RAISE EXCEPTION 'Canonical receipt attempt identity mismatch'; END IF;
 revision_number=(body->>'revision')::integer;
 digest_text=encode(sha256(convert_to((body->'data')::text,'UTF8')),'hex');
 INSERT INTO ledger_attempt_canonical_events(attempt_id,revision,event_type,data_digest,payload,origin)
 VALUES(a.id,revision_number,body->>'type',digest_text,body,provenance)
 ON CONFLICT(attempt_id,revision) DO NOTHING;
 SELECT * INTO STRICT previous FROM ledger_attempt_canonical_events WHERE attempt_id=a.id AND revision=revision_number;
 IF previous.event_type IS DISTINCT FROM body->>'type' OR previous.payload->'data' IS DISTINCT FROM body->'data' THEN
  RAISE EXCEPTION 'Canonical attempt revision conflicts: conflicting content';
 END IF;
END;
$$;

-- Existing durable payloads are retained; missing historical deliveries are not invented.
SELECT retain_ledger_canonical_event(settlement_payload,'migration_projection')
 FROM exchange_operations WHERE settlement_payload IS NOT NULL ORDER BY created_at,id;
SELECT retain_ledger_canonical_event(prior_settlement_payload,'migration_projection')
 FROM settlement_reversals WHERE prior_settlement_payload IS NOT NULL ORDER BY created_at,operation_id,revision;
SELECT retain_ledger_canonical_event(payload,'migration_projection')
 FROM settlement_reversals ORDER BY created_at,operation_id,revision;

CREATE FUNCTION capture_ledger_canonical_projection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='exchange_operations' THEN
  PERFORM retain_ledger_canonical_event(NEW.settlement_payload,'live');
 ELSIF TG_TABLE_NAME='settlement_reversals' THEN
  PERFORM retain_ledger_canonical_event(NEW.payload,'live');
 ELSE
  PERFORM retain_ledger_canonical_event(settlement_payload,'live') FROM exchange_operations WHERE id=NEW.operation_id;
  PERFORM retain_ledger_canonical_event(prior_settlement_payload,'live') FROM settlement_reversals WHERE operation_id=NEW.operation_id ORDER BY revision;
  PERFORM retain_ledger_canonical_event(payload,'live') FROM settlement_reversals WHERE operation_id=NEW.operation_id ORDER BY revision;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER retain_canonical_operation AFTER UPDATE OF settlement_payload ON exchange_operations
 FOR EACH ROW EXECUTE FUNCTION capture_ledger_canonical_projection();
CREATE TRIGGER retain_canonical_reversal AFTER INSERT ON settlement_reversals
 FOR EACH ROW EXECUTE FUNCTION capture_ledger_canonical_projection();
CREATE TRIGGER retain_canonical_attempt AFTER INSERT ON ledger_execution_attempts
 FOR EACH ROW EXECUTE FUNCTION capture_ledger_canonical_projection();

CREATE FUNCTION protect_ledger_canonical_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Canonical attempt receipts are immutable';
END;
$$;
CREATE TRIGGER immutable_canonical_receipt BEFORE UPDATE OR DELETE ON ledger_attempt_canonical_events
 FOR EACH ROW EXECUTE FUNCTION protect_ledger_canonical_receipt();
