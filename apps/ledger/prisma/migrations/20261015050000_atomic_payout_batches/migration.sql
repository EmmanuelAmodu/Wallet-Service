CREATE TABLE ledger_payout_batches (
 id uuid PRIMARY KEY,domain_id text NOT NULL,reset_epoch text NOT NULL,manifest jsonb NOT NULL,manifest_digest text NOT NULL,
 preparation jsonb NOT NULL,preparation_digest text NOT NULL,state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','settled','reverted')),
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),chain_identity text UNIQUE,created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(manifest_digest ~ '^[0-9a-f]{64}$' AND preparation_digest ~ '^[0-9a-f]{64}$')
);
CREATE TABLE ledger_payout_batch_members (
 batch_id uuid NOT NULL REFERENCES ledger_payout_batches(id),member_index integer NOT NULL CHECK(member_index BETWEEN 0 AND 49),
 operation_id uuid NOT NULL UNIQUE REFERENCES exchange_operations(id),attempt_id uuid NOT NULL UNIQUE REFERENCES ledger_execution_attempts(id),
 reservation_id uuid NOT NULL UNIQUE REFERENCES withdrawal_reservations(id),PRIMARY KEY(batch_id,member_index)
);
CREATE TABLE ledger_payout_batch_receipts (
 batch_id uuid NOT NULL REFERENCES ledger_payout_batches(id),revision integer NOT NULL CHECK(revision>0),digest text NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'),
 payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(batch_id,revision)
);
CREATE FUNCTION retain_payout_batch_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Payout batch financial history is retained'; END IF;
 IF TG_TABLE_NAME<>'ledger_payout_batches' THEN RAISE EXCEPTION 'Payout batch members and receipts are immutable'; END IF;
 IF ROW(NEW.id,NEW.domain_id,NEW.reset_epoch,NEW.manifest,NEW.manifest_digest,NEW.preparation,NEW.preparation_digest,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.domain_id,OLD.reset_epoch,OLD.manifest,OLD.manifest_digest,OLD.preparation,OLD.preparation_digest,OLD.created_at)
  OR NEW.revision<OLD.revision OR (OLD.chain_identity IS NOT NULL AND NEW.chain_identity IS DISTINCT FROM OLD.chain_identity) THEN
  RAISE EXCEPTION 'Payout batch authority and transaction identity are immutable'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER retain_payout_batch_history BEFORE UPDATE OR DELETE ON ledger_payout_batches FOR EACH ROW EXECUTE FUNCTION retain_payout_batch_history();
CREATE TRIGGER retain_payout_member_history BEFORE UPDATE OR DELETE ON ledger_payout_batch_members FOR EACH ROW EXECUTE FUNCTION retain_payout_batch_history();
CREATE TRIGGER retain_payout_receipt_history BEFORE UPDATE OR DELETE ON ledger_payout_batch_receipts FOR EACH ROW EXECUTE FUNCTION retain_payout_batch_history();

CREATE FUNCTION validate_payout_member() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b ledger_payout_batches%ROWTYPE;
DECLARE o exchange_operations%ROWTYPE;
DECLARE a ledger_execution_attempts%ROWTYPE;
DECLARE m jsonb;
BEGIN
 SELECT * INTO STRICT b FROM ledger_payout_batches WHERE id=NEW.batch_id;
 SELECT * INTO STRICT o FROM exchange_operations WHERE id=NEW.operation_id;
 SELECT * INTO STRICT a FROM ledger_execution_attempts WHERE id=NEW.attempt_id;
 m=b.manifest->'members'->NEW.member_index;
 IF b.state<>'prepared' OR b.revision<>0 OR b.manifest->>'batchId' IS DISTINCT FROM b.id::text
  OR b.manifest->>'domainId' IS DISTINCT FROM b.domain_id OR b.manifest->>'resetEpoch' IS DISTINCT FROM b.reset_epoch
  OR b.manifest#>>'{asset,chain}' IS DISTINCT FROM 'bitcoin' OR b.manifest#>>'{asset,network}' IS DISTINCT FROM 'regtest'
  OR b.manifest#>>'{asset,assetId}' IS DISTINCT FROM 'token:bitcoin:native'
  OR o.kind<>'withdrawal' OR o.domain_id<>b.domain_id OR o.reset_epoch<>b.reset_epoch OR o.attempt_id<>a.id
  OR o.reservation_id IS DISTINCT FROM NEW.reservation_id OR a.operation_id<>o.id OR a.reservation_id IS DISTINCT FROM NEW.reservation_id
  OR m->>'operationId' IS DISTINCT FROM o.id::text OR m->>'attemptId' IS DISTINCT FROM a.id::text
  OR m->>'reservationId' IS DISTINCT FROM NEW.reservation_id::text OR m->>'customerId' IS DISTINCT FROM o.customer_id::text
  OR m->>'requestDigest' IS DISTINCT FROM o.request_digest
  OR o.payload#>>'{data,sourceWalletId}' IS DISTINCT FROM b.manifest->>'sourceWalletId'
  OR o.payload#>>'{data,destination}' IS DISTINCT FROM m->>'destination'
  OR o.payload#>>'{data,amount,amount}' IS DISTINCT FROM m->>'principalUnits'
  OR o.payload#>'{data,amount,asset}' IS DISTINCT FROM b.manifest->'asset'
  OR o.payload#>>'{data,preparationDigest}' IS DISTINCT FROM b.preparation_digest THEN
   RAISE EXCEPTION 'Batch member must retain its original approved operation, attempt and hold'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER validate_payout_member BEFORE INSERT ON ledger_payout_batch_members FOR EACH ROW EXECUTE FUNCTION validate_payout_member();

CREATE FUNCTION require_complete_payout_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b ledger_payout_batches%ROWTYPE;
DECLARE target uuid;
BEGIN
 IF TG_TABLE_NAME='ledger_payout_batches' THEN target=NEW.id; ELSE target=NEW.batch_id; END IF;
 SELECT * INTO STRICT b FROM ledger_payout_batches WHERE id=target;
 IF (SELECT count(*) FROM ledger_payout_batch_members WHERE batch_id=target)<>jsonb_array_length(b.manifest->'members') THEN
  RAISE EXCEPTION 'Payout batch approval must contain every original obligation'; END IF;
 IF b.revision>0 AND NOT EXISTS(SELECT 1 FROM ledger_payout_batch_receipts WHERE batch_id=b.id AND revision=b.revision) THEN
  RAISE EXCEPTION 'Canonical batch state requires its immutable revision receipt'; END IF;
 RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER complete_payout_batch AFTER INSERT OR UPDATE ON ledger_payout_batches DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_complete_payout_batch();
CREATE CONSTRAINT TRIGGER complete_payout_member AFTER INSERT ON ledger_payout_batch_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_complete_payout_batch();

-- Old workers cannot independently settle/reverse/release a member of an approved batch.
CREATE FUNCTION fence_individual_batch_finances() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch_uuid uuid;
BEGIN
 IF TG_TABLE_NAME='exchange_operations' THEN
  SELECT batch_id INTO batch_uuid FROM ledger_payout_batch_members WHERE operation_id=NEW.id;
  IF batch_uuid IS NULL AND EXISTS(SELECT 1 FROM ledger_payout_batches WHERE chain_identity=NEW.settlement_identity) THEN
   RAISE EXCEPTION 'Transaction already belongs to an approved payout batch'; END IF;
 ELSE
  SELECT batch_id INTO batch_uuid FROM ledger_payout_batch_members WHERE reservation_id=NEW.id;
 END IF;
 IF batch_uuid IS NOT NULL AND current_setting('waas.payout_batch',true) IS DISTINCT FROM batch_uuid::text THEN
  RAISE EXCEPTION 'Approved batch members require atomic batch financial processing'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER fence_individual_batch_finances BEFORE UPDATE ON exchange_operations FOR EACH ROW EXECUTE FUNCTION fence_individual_batch_finances();
CREATE TRIGGER fence_individual_batch_hold BEFORE UPDATE ON withdrawal_reservations FOR EACH ROW EXECUTE FUNCTION fence_individual_batch_finances();
