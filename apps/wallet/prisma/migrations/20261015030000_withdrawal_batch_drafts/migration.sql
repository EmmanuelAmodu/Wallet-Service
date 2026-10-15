CREATE TABLE withdrawal_batch_drafts (
 id uuid PRIMARY KEY,source_wallet_id uuid NOT NULL REFERENCES wallets(id),domain_id text NOT NULL,reset_epoch text NOT NULL,
 manifest jsonb NOT NULL,manifest_digest text NOT NULL CHECK(manifest_digest ~ '^[0-9a-f]{64}$'),
 state text NOT NULL DEFAULT 'planned' CHECK(state IN ('planned','released')),
 created_at timestamptz NOT NULL DEFAULT now(),released_at timestamptz,
 CHECK((state='released')=(released_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_planned_batch_draft_per_source ON withdrawal_batch_drafts(source_wallet_id) WHERE state='planned';
ALTER TABLE withdrawals ADD COLUMN batch_draft_id uuid REFERENCES withdrawal_batch_drafts(id);
ALTER TABLE withdrawals DROP CONSTRAINT withdrawal_state;
ALTER TABLE withdrawals ADD CONSTRAINT withdrawal_state CHECK(state IN ('reserving','queued','planning','waiting_liquidity','executing','attention','settled','failed','rejected','cancelling','cancelled','reconciliation_required','batch_planned'));
ALTER TABLE withdrawals ADD CONSTRAINT withdrawal_batch_state CHECK((state='batch_planned')=(batch_draft_id IS NOT NULL));
CREATE TABLE withdrawal_batch_draft_members (
 batch_id uuid NOT NULL REFERENCES withdrawal_batch_drafts(id),member_index integer NOT NULL CHECK(member_index BETWEEN 0 AND 49),
 withdrawal_id uuid NOT NULL REFERENCES withdrawals(id),attempt_id uuid NOT NULL UNIQUE,reservation_id uuid NOT NULL,
 active boolean NOT NULL DEFAULT true,PRIMARY KEY(batch_id,member_index)
);
CREATE UNIQUE INDEX one_active_draft_per_withdrawal ON withdrawal_batch_draft_members(withdrawal_id) WHERE active;
CREATE UNIQUE INDEX one_active_draft_per_hold ON withdrawal_batch_draft_members(reservation_id) WHERE active;

CREATE FUNCTION guard_batch_draft() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w wallets%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Batch draft history is retained'; END IF;
 IF TG_OP='UPDATE' THEN
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
CREATE TRIGGER protect_batch_draft BEFORE INSERT OR UPDATE OR DELETE ON withdrawal_batch_drafts FOR EACH ROW EXECUTE FUNCTION guard_batch_draft();

CREATE FUNCTION guard_batch_member() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b withdrawal_batch_drafts%ROWTYPE;
DECLARE w withdrawals%ROWTYPE;
DECLARE m jsonb;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Batch membership history is retained'; END IF;
 SELECT * INTO STRICT b FROM withdrawal_batch_drafts WHERE id=NEW.batch_id;
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.batch_id,NEW.member_index,NEW.withdrawal_id,NEW.attempt_id,NEW.reservation_id)
   IS DISTINCT FROM ROW(OLD.batch_id,OLD.member_index,OLD.withdrawal_id,OLD.attempt_id,OLD.reservation_id)
   OR NOT OLD.active OR NEW.active OR b.state<>'released' THEN RAISE EXCEPTION 'Batch member terms are immutable'; END IF;
 ELSE
  SELECT * INTO STRICT w FROM withdrawals WHERE id=NEW.withdrawal_id;
  m=b.manifest->'members'->NEW.member_index;
  IF b.state<>'planned' OR NOT NEW.active OR w.batch_draft_id IS DISTINCT FROM b.id OR w.state<>'batch_planned' OR w.cancel_requested
   OR w.domain_id<>b.domain_id OR w.reset_epoch<>b.reset_epoch OR w.hot_wallet_id<>b.source_wallet_id
   OR w.chain IS DISTINCT FROM b.manifest#>>'{asset,chain}' OR w.network IS DISTINCT FROM b.manifest#>>'{asset,network}'
   OR w.asset_id IS DISTINCT FROM b.manifest#>>'{asset,assetId}'
   OR w.attempt_id IS DISTINCT FROM NEW.attempt_id OR w.reservation_id IS DISTINCT FROM NEW.reservation_id
   OR m->>'operationId' IS DISTINCT FROM w.id::text OR m->>'attemptId' IS DISTINCT FROM NEW.attempt_id::text
   OR m->>'reservationId' IS DISTINCT FROM NEW.reservation_id::text OR m->>'customerId' IS DISTINCT FROM w.customer_id::text
   OR m->>'requestDigest' IS DISTINCT FROM w.request_digest OR m->>'destination' IS DISTINCT FROM w.destination
   OR m->>'principalUnits' IS DISTINCT FROM w.principal_units THEN RAISE EXCEPTION 'Batch member does not match the original held withdrawal'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER protect_batch_member BEFORE INSERT OR UPDATE OR DELETE ON withdrawal_batch_draft_members FOR EACH ROW EXECUTE FUNCTION guard_batch_member();

CREATE FUNCTION guard_batched_withdrawal() RETURNS trigger LANGUAGE plpgsql AS $$
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
   NEW.hot_wallet_id,NEW.hot_registry_revision,NEW.chain,NEW.network,NEW.asset_id,NEW.destination,NEW.principal_units,NEW.customer_fee_units,NEW.request,NEW.policy_version,NEW.cancel_requested,NEW.state)
   IS DISTINCT FROM ROW(OLD.id,OLD.customer_id,OLD.domain_id,OLD.reset_epoch,OLD.request_digest,OLD.reservation_id,OLD.attempt_id,
   OLD.hot_wallet_id,OLD.hot_registry_revision,OLD.chain,OLD.network,OLD.asset_id,OLD.destination,OLD.principal_units,OLD.customer_fee_units,OLD.request,OLD.policy_version,OLD.cancel_requested,OLD.state) THEN
    RAISE EXCEPTION 'Batched withdrawal terms are immutable';
  END IF;
 ELSIF NEW.batch_draft_id IS NOT NULL AND (OLD.state<>'queued' OR OLD.attempt_id IS NOT NULL OR OLD.reservation_id IS NULL OR OLD.cancel_requested
  OR EXISTS(SELECT 1 FROM custody_executions WHERE operation_id=OLD.id)) THEN
  RAISE EXCEPTION 'Only an untouched held withdrawal can enter a batch draft';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER protect_batched_withdrawal BEFORE UPDATE ON withdrawals FOR EACH ROW EXECUTE FUNCTION guard_batched_withdrawal();

-- Deferred completeness rejects crashes/partial writes while permitting one atomic claim or dissolution.
CREATE FUNCTION complete_batch_draft() RETURNS trigger LANGUAGE plpgsql AS $$
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
 IF b.state='planned' AND (SELECT count(*) FROM withdrawal_batch_draft_members m JOIN withdrawals w ON w.id=m.withdrawal_id
  WHERE m.batch_id=b.id AND m.active AND w.batch_draft_id=b.id AND w.state='batch_planned' AND w.attempt_id=m.attempt_id AND w.reservation_id=m.reservation_id)<>expected THEN
  RAISE EXCEPTION 'Batch draft ownership must be complete and exclusive';
 END IF;
 IF b.state='released' AND (EXISTS(SELECT 1 FROM withdrawal_batch_draft_members WHERE batch_id=b.id AND active)
  OR EXISTS(SELECT 1 FROM withdrawals WHERE batch_draft_id=b.id)) THEN RAISE EXCEPTION 'Unsigned batch release must dissolve every member atomically'; END IF;
 RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER complete_draft AFTER INSERT OR UPDATE ON withdrawal_batch_drafts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION complete_batch_draft();
CREATE CONSTRAINT TRIGGER complete_draft_member AFTER INSERT OR UPDATE ON withdrawal_batch_draft_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION complete_batch_draft();
CREATE CONSTRAINT TRIGGER complete_draft_withdrawal AFTER UPDATE ON withdrawals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION complete_batch_draft();

CREATE FUNCTION guard_individual_during_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_uuid uuid;
BEGIN
 IF TG_TABLE_NAME='transactions' THEN source_uuid=NEW.wallet_id; ELSE source_uuid=NEW.source_wallet_id; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('custody-source:'||source_uuid::text,0));
 IF EXISTS(SELECT 1 FROM withdrawal_batch_drafts WHERE source_wallet_id=source_uuid AND state='planned') THEN
  RAISE EXCEPTION 'Source belongs to a retained unsigned batch draft'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER individual_transaction_batch_fence BEFORE INSERT OR UPDATE OF wallet_id ON transactions FOR EACH ROW EXECUTE FUNCTION guard_individual_during_batch();
CREATE TRIGGER individual_execution_batch_fence BEFORE INSERT OR UPDATE OF source_wallet_id ON custody_executions FOR EACH ROW EXECUTE FUNCTION guard_individual_during_batch();


-- Preserve every original intent/hold/revision guard. The sole attempt-reset exception
-- is a retained, completely dissolved unsigned draft that never had an execution.
CREATE OR REPLACE FUNCTION protect_withdrawal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Withdrawal history is retained'; END IF;
 IF ROW(NEW.id,NEW.customer_id,NEW.domain_id,NEW.reset_epoch,NEW.idempotency_key,NEW.request_digest,NEW.request,NEW.chain,NEW.network,NEW.asset_id,NEW.destination,NEW.principal_units,NEW.customer_fee_units,NEW.policy_version,NEW.hot_wallet_id,NEW.hot_registry_revision,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.customer_id,OLD.domain_id,OLD.reset_epoch,OLD.idempotency_key,OLD.request_digest,OLD.request,OLD.chain,OLD.network,OLD.asset_id,OLD.destination,OLD.principal_units,OLD.customer_fee_units,OLD.policy_version,OLD.hot_wallet_id,OLD.hot_registry_revision,OLD.created_at)
 OR (OLD.reservation_id IS NOT NULL AND NEW.reservation_id IS DISTINCT FROM OLD.reservation_id)
 OR (OLD.attempt_id IS NOT NULL AND NEW.attempt_id IS DISTINCT FROM OLD.attempt_id AND NOT (
  OLD.batch_draft_id IS NOT NULL AND NEW.batch_draft_id IS NULL AND NEW.attempt_id IS NULL AND NEW.state='queued'
  AND EXISTS(SELECT 1 FROM withdrawal_batch_drafts b JOIN withdrawal_batch_draft_members m ON m.batch_id=b.id
   WHERE b.id=OLD.batch_draft_id AND b.state='released' AND m.withdrawal_id=OLD.id AND m.attempt_id=OLD.attempt_id AND NOT m.active)
  AND NOT EXISTS(SELECT 1 FROM custody_executions WHERE operation_id=OLD.id)))
 OR NEW.revision<OLD.revision OR NEW.execution_revision<OLD.execution_revision OR NEW.settlement_revision<OLD.settlement_revision OR NEW.reservation_revision<OLD.reservation_revision THEN
  RAISE EXCEPTION 'Withdrawal intent, hold, attempt and revisions are immutable';
 END IF;
 IF NEW.state='cancelled' AND EXISTS(SELECT 1 FROM custody_executions WHERE operation_id=NEW.id AND "authorization" IS NOT NULL) THEN
  RAISE EXCEPTION 'Authorized withdrawal cannot be cancelled'; END IF;
 RETURN NEW;
END;
$$;
