-- Keep the existing source fences and one-attempt financial contract intact.
-- Capture historical records before introducing any future replacement path.
CREATE TABLE custody_attempts (
 id uuid PRIMARY KEY,
 execution_id uuid NOT NULL REFERENCES custody_executions(id),
 operation_id uuid NOT NULL,
 transaction_id uuid NOT NULL UNIQUE REFERENCES transactions(id),
 domain_id text NOT NULL,
 reset_epoch text NOT NULL,
 source_wallet_id uuid NOT NULL REFERENCES wallets(id),
 ordinal integer NOT NULL DEFAULT 0,
 predecessor_id uuid REFERENCES custody_attempts(id),
 request_digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(execution_id,ordinal),
 -- No child attempts are accepted before replacement authority is implemented.
 CONSTRAINT root_attempt_only CHECK (ordinal=0 AND predecessor_id IS NULL)
);
CREATE INDEX custody_attempts_domain_epoch_operation ON custody_attempts(domain_id,reset_epoch,operation_id);
CREATE TABLE custody_attempt_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 sequence bigserial NOT NULL UNIQUE,
 attempt_id uuid NOT NULL REFERENCES custody_attempts(id),
 digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
 provenance text NOT NULL CHECK (provenance IN ('migration_baseline','live_transition')),
 evidence jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(attempt_id,digest)
);
CREATE INDEX custody_attempt_observations_attempt_sequence ON custody_attempt_observations(attempt_id,sequence);

CREATE FUNCTION capture_custody_attempt(execution_uuid uuid, provenance_text text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE e custody_executions%ROWTYPE;
DECLARE t transactions%ROWTYPE;
DECLARE a custody_attempts%ROWTYPE;
DECLARE payload jsonb;
BEGIN
 SELECT * INTO e FROM custody_executions WHERE id=execution_uuid;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT * INTO t FROM transactions WHERE id=e.transaction_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Attempt transaction unavailable'; END IF;
 IF t.wallet_id<>e.source_wallet_id THEN RAISE EXCEPTION 'Attempt source transaction mismatch'; END IF;
 INSERT INTO custody_attempts(id,execution_id,operation_id,transaction_id,domain_id,reset_epoch,source_wallet_id,ordinal,request_digest,created_at)
 VALUES(e.attempt_id,e.id,e.operation_id,e.transaction_id,e.domain_id,e.reset_epoch,e.source_wallet_id,0,e.request_digest,e.created_at)
 ON CONFLICT(id) DO NOTHING;
 SELECT * INTO a FROM custody_attempts WHERE id=e.attempt_id;
 IF a.execution_id<>e.id OR a.operation_id<>e.operation_id OR a.transaction_id<>e.transaction_id
 OR a.domain_id<>e.domain_id OR a.reset_epoch<>e.reset_epoch OR a.source_wallet_id<>e.source_wallet_id
 OR a.request_digest<>e.request_digest THEN
  RAISE EXCEPTION 'Immutable custody attempt identity mismatch';
 END IF;
 payload=jsonb_build_object(
  'schemaVersion',1,'executionId',e.id,'operationId',e.operation_id,'attemptId',e.attempt_id,
  'transactionId',e.transaction_id,'domainId',e.domain_id,'resetEpoch',e.reset_epoch,
  'sourceWalletId',e.source_wallet_id,'requestDigest',e.request_digest,
  'plan',e.plan,'preparedRequest',e.prepared_request,'preparationDigest',e.preparation_digest,
  'authorization',e.authorization,'signerResult',e.signer_result,
  'principalUnits',e.principal_units,'maximumFeeUnits',e.maximum_fee_units,
  'authorizationExpiresAt',e.expires_at,'state',e.state,'revision',e.revision,'lastError',e.last_error,
  'transactionStatus',t.status,'signed',t.signed,'transactionHash',t.tx_hash,
  'inclusion',e.inclusion,'reversed',e.reversed,'retiredAt',e.retired_at,
  'settlementRevision',e.settlement_revision,'ledgerAckRevision',e.ledger_ack_revision,
  'terminalProofRevision',e.terminal_proof_revision,'ledgerBatchId',e.ledger_batch_id,
  'ledgerIntentAcknowledged',e.ledger_intent_ack,'listenerIntentAcknowledged',e.listener_intent_ack
 );
 INSERT INTO custody_attempt_observations(attempt_id,digest,provenance,evidence)
 VALUES(e.attempt_id,encode(sha256(convert_to(payload::text,'UTF8')),'hex'),provenance_text,payload)
 ON CONFLICT(attempt_id,digest) DO NOTHING;
END;
$$;

CREATE FUNCTION journal_custody_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM capture_custody_attempt(NEW.id,'live_transition');
 RETURN NEW;
END;
$$;
CREATE FUNCTION journal_custody_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE execution_uuid uuid;
BEGIN
 SELECT id INTO execution_uuid FROM custody_executions WHERE transaction_id=NEW.id;
 IF FOUND THEN PERFORM capture_custody_attempt(execution_uuid,'live_transition'); END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER custody_execution_attempt_journal AFTER INSERT OR UPDATE ON custody_executions
 FOR EACH ROW EXECUTE FUNCTION journal_custody_execution();
CREATE TRIGGER custody_transaction_attempt_journal AFTER UPDATE ON transactions
 FOR EACH ROW EXECUTE FUNCTION journal_custody_transaction();

-- A migration baseline is the state observed now, not a reconstruction of lost past transitions.
SELECT capture_custody_attempt(id,'migration_baseline') FROM custody_executions ORDER BY created_at,id;

CREATE FUNCTION reject_custody_attempt_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Custody attempt history is immutable';
END;
$$;
CREATE TRIGGER immutable_custody_attempt BEFORE UPDATE OR DELETE ON custody_attempts
 FOR EACH ROW EXECUTE FUNCTION reject_custody_attempt_mutation();
CREATE TRIGGER immutable_custody_attempt_observation BEFORE UPDATE OR DELETE ON custody_attempt_observations
 FOR EACH ROW EXECUTE FUNCTION reject_custody_attempt_mutation();
