CREATE TABLE bitcoin_batch_executions (
 batch_id uuid PRIMARY KEY REFERENCES withdrawal_batch_preparations(batch_id),
 state text NOT NULL DEFAULT 'awaiting_ledger' CHECK(state IN ('awaiting_ledger','signing','signed','submitted','settlement_pending','settled','reverted','attention')),
 command jsonb,signer_result jsonb,signed jsonb,inclusion jsonb,canonical_command jsonb,
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),ledger_ack_revision integer NOT NULL DEFAULT -1 CHECK(ledger_ack_revision>=-1),
 terminal_proof_revision integer NOT NULL DEFAULT 0 CHECK(terminal_proof_revision>=0),broadcast_generation integer NOT NULL DEFAULT 0 CHECK(broadcast_generation>=0),
 next_check_at timestamptz NOT NULL DEFAULT now(),last_error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bitcoin_batch_execution_due ON bitcoin_batch_executions(next_check_at,batch_id);
CREATE TABLE bitcoin_batch_signer_results (
 batch_id uuid NOT NULL REFERENCES bitcoin_batch_executions(batch_id),digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),payload jsonb NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(batch_id,digest)
);
CREATE FUNCTION protect_batch_signer_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Authenticated batch signer result history is immutable'; END;
$$;
CREATE TRIGGER protect_batch_signer_receipt BEFORE UPDATE OR DELETE ON bitcoin_batch_signer_results FOR EACH ROW EXECUTE FUNCTION protect_batch_signer_receipt();
ALTER TABLE withdrawal_batch_drafts DROP CONSTRAINT withdrawal_batch_drafts_state_check;
ALTER TABLE withdrawal_batch_drafts ADD CONSTRAINT withdrawal_batch_drafts_state_check CHECK(state IN ('planned','released','completed'));

CREATE FUNCTION guard_bitcoin_batch_execution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b withdrawal_batch_drafts%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Batch execution history is retained'; END IF;
 SELECT * INTO STRICT b FROM withdrawal_batch_drafts WHERE id=NEW.batch_id;
 PERFORM pg_advisory_xact_lock(hashtextextended('custody-source:'||b.source_wallet_id::text,0));
 IF TG_OP='INSERT' THEN
  IF b.state<>'planned' OR b.manifest#>>'{asset,chain}'<>'bitcoin' OR NEW.command IS NOT NULL OR NEW.signed IS NOT NULL OR NEW.revision<>0 OR NEW.state<>'awaiting_ledger' THEN
   RAISE EXCEPTION 'Batch execution must acquire its complete original unsigned draft'; END IF;
 ELSE
  IF ROW(NEW.batch_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.batch_id,OLD.created_at)
   OR (OLD.command IS NOT NULL AND NEW.command IS DISTINCT FROM OLD.command)
   OR (OLD.signer_result IS NOT NULL AND NEW.signer_result IS DISTINCT FROM OLD.signer_result AND NOT (
    OLD.signer_result->>'type'='payout.batch.rejected' AND NEW.signer_result->>'type'='payout.batch.signed'
    AND EXISTS(SELECT 1 FROM bitcoin_batch_signer_results WHERE batch_id=NEW.batch_id AND payload=OLD.signer_result)
    AND EXISTS(SELECT 1 FROM bitcoin_batch_signer_results WHERE batch_id=NEW.batch_id AND payload=NEW.signer_result)))
   OR (OLD.signed IS NOT NULL AND NEW.signed IS DISTINCT FROM OLD.signed)
   OR NEW.revision<OLD.revision OR NEW.ledger_ack_revision<OLD.ledger_ack_revision
   OR NEW.broadcast_generation<OLD.broadcast_generation OR NEW.terminal_proof_revision<OLD.terminal_proof_revision THEN
    RAISE EXCEPTION 'Batch command, signed evidence and revisions are immutable'; END IF;
 END IF;
 IF NEW.command IS NOT NULL AND (NEW.ledger_ack_revision<0 OR NEW.command->>'batchId' IS DISTINCT FROM b.id::text OR NEW.command->>'transactionId' IS DISTINCT FROM b.id::text
  OR NEW.command#>>'{preparation,preparationDigest}' IS DISTINCT FROM (SELECT preparation_digest FROM withdrawal_batch_preparations WHERE batch_id=b.id)) THEN
   RAISE EXCEPTION 'Batch signing requires independently acknowledged exact preparation'; END IF;
 IF NEW.signed IS NOT NULL AND (NEW.command IS NULL OR NEW.signer_result->>'type' IS DISTINCT FROM 'payout.batch.signed' OR NEW.signer_result->'signed' IS DISTINCT FROM NEW.signed) THEN
  RAISE EXCEPTION 'Batch signed bytes require retained signer evidence'; END IF;
 IF NEW.state='settled' AND (NEW.revision<1 OR NEW.ledger_ack_revision<>NEW.revision OR NEW.terminal_proof_revision<>NEW.revision OR NEW.signed IS NULL OR NEW.inclusion IS NULL) THEN
  RAISE EXCEPTION 'Batch retirement requires fresh matching canonical and accounting proof'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER guard_bitcoin_batch_execution BEFORE INSERT OR UPDATE OR DELETE ON bitcoin_batch_executions FOR EACH ROW EXECUTE FUNCTION guard_bitcoin_batch_execution();

CREATE TABLE bitcoin_batch_execution_events (
 sequence bigserial PRIMARY KEY,batch_id uuid NOT NULL REFERENCES bitcoin_batch_executions(batch_id),snapshot jsonb NOT NULL,digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bitcoin_batch_execution_event_scope ON bitcoin_batch_execution_events(batch_id,sequence);
CREATE FUNCTION capture_bitcoin_batch_execution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE body jsonb; fingerprint text; prior text;
BEGIN
 body=to_jsonb(NEW)-'next_check_at'-'updated_at';
 fingerprint=encode(sha256(convert_to(body::text,'UTF8')),'hex');
 SELECT digest INTO prior FROM bitcoin_batch_execution_events WHERE batch_id=NEW.batch_id ORDER BY sequence DESC LIMIT 1;
 IF prior IS DISTINCT FROM fingerprint THEN
  INSERT INTO bitcoin_batch_execution_events(batch_id,snapshot,digest) VALUES(NEW.batch_id,body,fingerprint);
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER journal_bitcoin_batch_execution AFTER INSERT OR UPDATE ON bitcoin_batch_executions FOR EACH ROW EXECUTE FUNCTION capture_bitcoin_batch_execution();
CREATE FUNCTION protect_bitcoin_batch_execution_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Batch execution history is immutable'; END;
$$;
CREATE TRIGGER immutable_bitcoin_batch_execution_event BEFORE UPDATE OR DELETE ON bitcoin_batch_execution_events FOR EACH ROW EXECUTE FUNCTION protect_bitcoin_batch_execution_event();

CREATE OR REPLACE FUNCTION guard_batch_draft() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w wallets%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Batch draft history is retained'; END IF;
 IF TG_OP='UPDATE' THEN
  IF EXISTS(SELECT 1 FROM bitcoin_batch_executions WHERE batch_id=OLD.id) THEN
   IF ROW(NEW.id,NEW.source_wallet_id,NEW.domain_id,NEW.reset_epoch,NEW.manifest,NEW.manifest_digest,NEW.created_at,NEW.released_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.source_wallet_id,OLD.domain_id,OLD.reset_epoch,OLD.manifest,OLD.manifest_digest,OLD.created_at,OLD.released_at)
    OR OLD.state<>'planned' OR NEW.state<>'completed' OR NOT EXISTS(SELECT 1 FROM bitcoin_batch_executions WHERE batch_id=OLD.id AND state='settled') THEN
    RAISE EXCEPTION 'Admitted batch cannot dissolve or retire before canonical accounting'; END IF;
   RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.source_wallet_id,NEW.domain_id,NEW.reset_epoch,NEW.manifest,NEW.manifest_digest,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.source_wallet_id,OLD.domain_id,OLD.reset_epoch,OLD.manifest,OLD.manifest_digest,OLD.created_at)
   OR OLD.state<>'planned' OR NEW.state<>'released' THEN RAISE EXCEPTION 'Batch draft identity is immutable and only unsigned release is supported'; END IF;
 ELSE
  PERFORM pg_advisory_xact_lock(hashtextextended('custody-source:'||NEW.source_wallet_id::text,0));
  SELECT * INTO STRICT w FROM wallets WHERE id=NEW.source_wallet_id;
  IF w.custody_role<>'hot' OR w.account<>0 OR NOT w.active OR w.custody_domain_id IS DISTINCT FROM NEW.domain_id
   OR w.reset_epoch IS DISTINCT FROM NEW.reset_epoch OR NEW.manifest->>'sourceWalletId' IS DISTINCT FROM w.id::text
   OR NEW.manifest->>'domainId' IS DISTINCT FROM NEW.domain_id OR NEW.manifest->>'resetEpoch' IS DISTINCT FROM NEW.reset_epoch
   OR NEW.manifest->>'batchId' IS DISTINCT FROM NEW.id::text OR NEW.manifest->>'seedId' IS DISTINCT FROM w.seed_id
   OR NEW.manifest->>'sourceAddress' IS DISTINCT FROM w.address
   OR NEW.manifest#>>'{asset,chain}' IS DISTINCT FROM w.chain OR NEW.manifest#>>'{asset,network}' IS DISTINCT FROM w.network
   OR w.chain NOT IN ('bitcoin','solana') OR NEW.state<>'planned'
   OR jsonb_typeof(NEW.manifest->'members') IS DISTINCT FROM 'array'
   OR (jsonb_array_length(NEW.manifest->'members') NOT BETWEEN 2 AND (CASE WHEN w.chain='bitcoin' THEN 50 ELSE 20 END)) THEN
    RAISE EXCEPTION 'Batch draft must match its original custody hot source and members';
  END IF;
  IF EXISTS(SELECT 1 FROM custody_executions WHERE source_wallet_id=w.id AND retired_at IS NULL)
   OR EXISTS(SELECT 1 FROM transactions WHERE wallet_id=w.id AND status IN ('preparing','signing','signed','queued','broadcasting','submitted','attention')) THEN
   RAISE EXCEPTION 'Batch draft source is retained by an individual execution';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION guard_batched_withdrawal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (OLD.batch_draft_id IS NOT NULL OR NEW.batch_draft_id IS NOT NULL) AND
 ROW(NEW.id,NEW.customer_id,NEW.domain_id,NEW.reset_epoch,NEW.request_digest,NEW.reservation_id,NEW.hot_wallet_id,NEW.hot_registry_revision,
 NEW.chain,NEW.network,NEW.asset_id,NEW.destination,NEW.principal_units,NEW.customer_fee_units,NEW.request,NEW.policy_version,NEW.cancel_requested)
 IS DISTINCT FROM ROW(OLD.id,OLD.customer_id,OLD.domain_id,OLD.reset_epoch,OLD.request_digest,OLD.reservation_id,OLD.hot_wallet_id,OLD.hot_registry_revision,
 OLD.chain,OLD.network,OLD.asset_id,OLD.destination,OLD.principal_units,OLD.customer_fee_units,OLD.request,OLD.policy_version,OLD.cancel_requested) THEN
  RAISE EXCEPTION 'Batch transitions cannot change original withdrawal terms';
 END IF;
 IF OLD.batch_draft_id IS NOT NULL THEN
  IF NEW.batch_draft_id IS NOT NULL AND NEW.batch_draft_id<>OLD.batch_draft_id THEN RAISE EXCEPTION 'Batch assignment cannot be moved'; END IF;
  IF NEW.batch_draft_id IS NULL THEN
   IF NEW.attempt_id IS NOT NULL OR NEW.state<>'queued' OR NOT EXISTS(SELECT 1 FROM withdrawal_batch_drafts WHERE id=OLD.batch_draft_id AND state='released') THEN
    RAISE EXCEPTION 'Retained batch membership cannot be cleared'; END IF;
  ELSIF ROW(NEW.id,NEW.customer_id,NEW.domain_id,NEW.reset_epoch,NEW.request_digest,NEW.reservation_id,NEW.attempt_id,
   NEW.hot_wallet_id,NEW.hot_registry_revision,NEW.chain,NEW.network,NEW.asset_id,NEW.destination,NEW.principal_units,NEW.customer_fee_units,NEW.request,NEW.policy_version,NEW.cancel_requested)
   IS DISTINCT FROM ROW(OLD.id,OLD.customer_id,OLD.domain_id,OLD.reset_epoch,OLD.request_digest,OLD.reservation_id,OLD.attempt_id,
   OLD.hot_wallet_id,OLD.hot_registry_revision,OLD.chain,OLD.network,OLD.asset_id,OLD.destination,OLD.principal_units,OLD.customer_fee_units,OLD.request,OLD.policy_version,OLD.cancel_requested) THEN
    RAISE EXCEPTION 'Batched withdrawal terms are immutable';
  END IF;
 ELSIF NEW.batch_draft_id IS NOT NULL AND (OLD.state<>'queued' OR OLD.attempt_id IS NOT NULL OR OLD.reservation_id IS NULL OR OLD.cancel_requested
  OR EXISTS(SELECT 1 FROM custody_executions WHERE operation_id=OLD.id)) THEN
  RAISE EXCEPTION 'Only an untouched held withdrawal can enter a batch draft';
 END IF;
 IF OLD.batch_draft_id IS NOT NULL AND NEW.batch_draft_id=OLD.batch_draft_id AND NEW.state<>OLD.state AND NOT (
  (NEW.state='executing' AND EXISTS(SELECT 1 FROM bitcoin_batch_executions WHERE batch_id=OLD.batch_draft_id AND signed IS NOT NULL))
  OR (NEW.state='settled' AND EXISTS(SELECT 1 FROM bitcoin_batch_executions WHERE batch_id=OLD.batch_draft_id AND state='settled' AND revision=NEW.settlement_revision))
  OR (NEW.state='reconciliation_required' AND EXISTS(SELECT 1 FROM bitcoin_batch_executions WHERE batch_id=OLD.batch_draft_id AND state='reverted'))
 ) THEN RAISE EXCEPTION 'Batch withdrawal projection requires canonical aggregate evidence'; END IF;
 RETURN NEW;
END;
$$;
ALTER TABLE withdrawals DROP CONSTRAINT withdrawal_batch_state;
ALTER TABLE withdrawals ADD CONSTRAINT withdrawal_batch_state CHECK(
 (state<>'batch_planned' OR batch_draft_id IS NOT NULL) AND (batch_draft_id IS NULL OR state IN ('batch_planned','executing','settled','reconciliation_required')));
CREATE OR REPLACE FUNCTION complete_batch_draft() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch_uuid uuid;
DECLARE b withdrawal_batch_drafts%ROWTYPE;
DECLARE expected integer;
BEGIN
 IF TG_TABLE_NAME='withdrawal_batch_drafts' THEN batch_uuid=NEW.id;
 ELSIF TG_TABLE_NAME='withdrawal_batch_draft_members' THEN batch_uuid=NEW.batch_id;
 ELSE batch_uuid=COALESCE(NEW.batch_draft_id,OLD.batch_draft_id); END IF;
 IF batch_uuid IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO STRICT b FROM withdrawal_batch_drafts WHERE id=batch_uuid;
 expected=jsonb_array_length(b.manifest->'members');
 IF (SELECT count(*) FROM withdrawal_batch_draft_members WHERE batch_id=b.id)<>expected THEN RAISE EXCEPTION 'Batch draft requires its complete immutable membership'; END IF;
 IF b.state IN ('planned','completed') AND (SELECT count(*) FROM withdrawal_batch_draft_members m JOIN withdrawals w ON w.id=m.withdrawal_id
  WHERE m.batch_id=b.id AND m.active AND w.batch_draft_id=b.id AND w.state IN ('batch_planned','executing','settled','reconciliation_required') AND w.attempt_id=m.attempt_id AND w.reservation_id=m.reservation_id)<>expected THEN
  RAISE EXCEPTION 'Batch draft ownership must be complete and exclusive';
 END IF;
 IF b.state='released' AND (EXISTS(SELECT 1 FROM withdrawal_batch_draft_members WHERE batch_id=b.id AND active)
  OR EXISTS(SELECT 1 FROM withdrawals WHERE batch_draft_id=b.id)) THEN RAISE EXCEPTION 'Unsigned batch release must dissolve every member atomically'; END IF;
 RETURN NEW;
END;
$$;
