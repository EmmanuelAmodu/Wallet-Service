CREATE TABLE ledger_execution_attempts (
 id uuid PRIMARY KEY,
 operation_id uuid NOT NULL REFERENCES exchange_operations(id),
 reservation_id uuid REFERENCES withdrawal_reservations(id),
 domain_id text NOT NULL,
 reset_epoch text NOT NULL,
 customer_id uuid,
 request_digest text NOT NULL,
 kind "ExchangeOperationKind" NOT NULL,
 ordinal integer NOT NULL DEFAULT 0,
 predecessor_id uuid REFERENCES ledger_execution_attempts(id),
 intent jsonb NOT NULL,
 intent_digest text NOT NULL CHECK(intent_digest ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(operation_id,ordinal),
 CONSTRAINT ledger_root_attempt_only CHECK(ordinal=0 AND predecessor_id IS NULL)
);
CREATE INDEX ledger_execution_attempts_scope ON ledger_execution_attempts(domain_id,reset_epoch,operation_id);

CREATE FUNCTION capture_ledger_execution_attempt(operation_uuid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE o exchange_operations%ROWTYPE;
DECLARE r withdrawal_reservations%ROWTYPE;
BEGIN
 SELECT * INTO o FROM exchange_operations WHERE id=operation_uuid;
 IF NOT FOUND OR o.attempt_id IS NULL THEN RETURN; END IF;
 -- Copy only an actual accepted execution, never manufacture authority for a placeholder.
 IF o.payload->>'operationId' IS DISTINCT FROM o.id::text
 OR o.payload->>'attemptId' IS DISTINCT FROM o.attempt_id::text
 OR o.payload->>'domainId' IS DISTINCT FROM o.domain_id
 OR o.payload->>'resetEpoch' IS DISTINCT FROM o.reset_epoch
 OR o.payload->>'requestDigest' IS DISTINCT FROM o.request_digest
 OR o.payload->>'type' IS DISTINCT FROM o.kind::text||'.execute.requested.v1' THEN
  RAISE EXCEPTION 'Accepted execution intent does not match its financial obligation';
 END IF;
 IF o.kind='withdrawal' THEN
  SELECT * INTO r FROM withdrawal_reservations WHERE id=o.reservation_id;
  IF NOT FOUND OR r.operation_id IS DISTINCT FROM o.id OR r.domain_id IS DISTINCT FROM o.domain_id
  OR r.reset_epoch IS DISTINCT FROM o.reset_epoch OR r.customer_id IS DISTINCT FROM o.customer_id
  OR r.request_digest IS DISTINCT FROM o.request_digest
  OR r.request#>'{source,data,principal}' IS DISTINCT FROM o.payload#>'{data,amount}'
  OR r.request#>>'{source,data,destination}' IS DISTINCT FROM o.payload#>>'{data,destination}'
  OR r.request#>>'{source,data,hotWalletId}' IS DISTINCT FROM o.payload#>>'{data,sourceWalletId}' THEN
   RAISE EXCEPTION 'Withdrawal attempt must retain its original hold principal destination and hot wallet';
  END IF;
 END IF;
 INSERT INTO ledger_execution_attempts(id,operation_id,reservation_id,domain_id,reset_epoch,customer_id,request_digest,kind,intent,intent_digest,created_at)
 VALUES(o.attempt_id,o.id,o.reservation_id,o.domain_id,o.reset_epoch,o.customer_id,o.request_digest,o.kind,o.payload,encode(sha256(convert_to(o.payload::text,'UTF8')),'hex'),o.created_at);
END;
$$;
-- Preserve existing financial obligations and their accepted root authority in place.
SELECT capture_ledger_execution_attempt(id) FROM exchange_operations ORDER BY created_at,id;

CREATE FUNCTION bind_new_ledger_execution_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM capture_ledger_execution_attempt(NEW.id);
 RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_execution_attempt_insert AFTER INSERT ON exchange_operations
 FOR EACH ROW EXECUTE FUNCTION bind_new_ledger_execution_attempt();

CREATE FUNCTION protect_ledger_execution_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o exchange_operations%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Ledger execution attempt authority is immutable'; END IF;
 SELECT * INTO STRICT o FROM exchange_operations WHERE id=NEW.operation_id;
 IF NEW.id IS DISTINCT FROM o.attempt_id OR NEW.domain_id IS DISTINCT FROM o.domain_id
 OR NEW.reset_epoch IS DISTINCT FROM o.reset_epoch OR NEW.customer_id IS DISTINCT FROM o.customer_id
 OR NEW.reservation_id IS DISTINCT FROM o.reservation_id OR NEW.request_digest IS DISTINCT FROM o.request_digest
 OR NEW.kind IS DISTINCT FROM o.kind OR NEW.intent IS DISTINCT FROM o.payload
 OR NEW.intent_digest IS DISTINCT FROM encode(sha256(convert_to(NEW.intent::text,'UTF8')),'hex') THEN
  RAISE EXCEPTION 'Attempt authority differs from the accepted obligation';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_ledger_execution_attempt BEFORE INSERT OR UPDATE OR DELETE ON ledger_execution_attempts
 FOR EACH ROW EXECUTE FUNCTION protect_ledger_execution_attempt();

CREATE FUNCTION protect_exchange_obligation_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Exchange obligation history is retained'; END IF;
 IF ROW(NEW.id,NEW.domain_id,NEW.reset_epoch,NEW.customer_id,NEW.reservation_id,NEW.request_digest,NEW.kind,NEW.payload,NEW.attempt_id,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.domain_id,OLD.reset_epoch,OLD.customer_id,OLD.reservation_id,OLD.request_digest,OLD.kind,OLD.payload,OLD.attempt_id,OLD.created_at) THEN
  RAISE EXCEPTION 'Exchange obligation identity and original approval are immutable';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_exchange_obligation_identity BEFORE UPDATE OR DELETE ON exchange_operations
 FOR EACH ROW EXECUTE FUNCTION protect_exchange_obligation_identity();

-- Hold state may settle, freeze or recover; its accepted financial terms cannot change.
CREATE FUNCTION protect_withdrawal_obligation_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Withdrawal obligation history is retained'; END IF;
 IF ROW(NEW.id,NEW.operation_id,NEW.domain_id,NEW.reset_epoch,NEW.customer_id,NEW.request_digest,
        NEW.policy_version,NEW.amounts,NEW.request,NEW.reserve_batch_id,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.operation_id,OLD.domain_id,OLD.reset_epoch,OLD.customer_id,OLD.request_digest,
        OLD.policy_version,OLD.amounts,OLD.request,OLD.reserve_batch_id,OLD.created_at) THEN
  RAISE EXCEPTION 'Accepted withdrawal obligation terms are immutable';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_withdrawal_obligation_terms BEFORE UPDATE OR DELETE ON withdrawal_reservations
 FOR EACH ROW EXECUTE FUNCTION protect_withdrawal_obligation_terms();
