CREATE TABLE evm_liquidity_reservations (
 execution_id uuid PRIMARY KEY REFERENCES custody_executions(id),
 source_wallet_id uuid NOT NULL REFERENCES wallets(id),
 domain_id text NOT NULL, reset_epoch text NOT NULL, seed_id text NOT NULL,
 network text NOT NULL CHECK(network='11155111'),
 nonce text NOT NULL CHECK(nonce ~ '^(0|[1-9][0-9]{0,77})$' AND nonce::numeric<power(2::numeric,256)),
 asset_id text NOT NULL CHECK(asset_id ~ '^token:ethereum:(native|erc20:0x[0-9a-f]{40})$'),
 principal_units text NOT NULL CHECK(principal_units ~ '^[1-9][0-9]{0,77}$' AND principal_units::numeric<power(2::numeric,256)),
 maximum_fee_units text NOT NULL CHECK(maximum_fee_units ~ '^(0|[1-9][0-9]{0,77})$' AND maximum_fee_units::numeric<=5000000000000000),
 request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
 evidence jsonb NOT NULL,
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','reverted','settled','unsigned_released')),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evm_liquidity_reservations_source_state ON evm_liquidity_reservations(source_wallet_id,state);

CREATE FUNCTION evm_liquidity_state(e custody_executions) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN e.reversed THEN 'reverted'
 WHEN e.retired_at IS NOT NULL AND ((e.authorization IS NULL AND e.signer_result IS NULL) OR e.signer_result->>'type'='transaction.custody.rejected') THEN 'unsigned_released'
 WHEN e.retired_at IS NOT NULL AND e.state IN ('confirmed','failed') AND e.ledger_batch_id IS NOT NULL AND e.settlement_revision>0 AND e.ledger_ack_revision>=e.settlement_revision AND e.inclusion IS NOT NULL THEN 'settled'
 ELSE 'reserved' END;
$$;

-- Preserve all existing prepared exposure. This is a projection baseline, not a new chain observation.
INSERT INTO evm_liquidity_reservations(execution_id,source_wallet_id,domain_id,reset_epoch,seed_id,network,nonce,asset_id,principal_units,maximum_fee_units,request_digest,evidence,state,created_at)
SELECT e.id,w.id,e.domain_id,e.reset_epoch,w.seed_id,w.network,
 COALESCE(e.prepared_request#>>'{transaction,nonce}',e.prepared_request#>>'{request,transaction,nonce}'),
 e.plan#>>'{data,asset,assetId}',e.principal_units,e.maximum_fee_units,e.request_digest,
 jsonb_build_object('provenance','migration_projection','preparationDigest',e.preparation_digest),
 evm_liquidity_state(e),e.created_at
FROM custody_executions e JOIN wallets w ON w.id=e.source_wallet_id
WHERE e.plan->>'type'='withdrawal.plan.requested.v1' AND w.chain='ethereum' AND w.custody_role='hot'
 AND e.prepared_request IS NOT NULL AND e.principal_units IS NOT NULL AND e.maximum_fee_units IS NOT NULL;

CREATE UNIQUE INDEX one_signed_evm_nonce_owner ON evm_liquidity_reservations(source_wallet_id,nonce) WHERE state<>'unsigned_released';

CREATE FUNCTION protect_evm_liquidity_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e custody_executions%ROWTYPE;
DECLARE w wallets%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'EVM liquidity history is retained'; END IF;
 SELECT * INTO STRICT e FROM custody_executions WHERE id=NEW.execution_id;
 SELECT * INTO STRICT w FROM wallets WHERE id=e.source_wallet_id;
 IF NEW.source_wallet_id<>w.id OR NEW.domain_id<>e.domain_id OR NEW.reset_epoch<>e.reset_epoch
 OR NEW.seed_id<>w.seed_id OR NEW.network<>w.network OR NEW.request_digest<>e.request_digest
 OR w.chain<>'ethereum' OR w.custody_role<>'hot' OR w.account<>0
 OR e.plan->>'type'<>'withdrawal.plan.requested.v1'
 OR NEW.asset_id IS DISTINCT FROM e.plan#>>'{data,asset,assetId}'
 OR NEW.principal_units IS DISTINCT FROM e.plan#>>'{data,amount}' THEN
  RAISE EXCEPTION 'EVM liquidity does not match its original hot withdrawal';
 END IF;
 IF NEW.state<>evm_liquidity_state(e) THEN RAISE EXCEPTION 'EVM liquidity release requires canonical acknowledgment or an unsigned terminal execution'; END IF;
 IF TG_OP='UPDATE' AND ROW(NEW.execution_id,NEW.source_wallet_id,NEW.domain_id,NEW.reset_epoch,NEW.seed_id,NEW.network,
 NEW.nonce,NEW.asset_id,NEW.principal_units,NEW.maximum_fee_units,NEW.request_digest,NEW.evidence,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.execution_id,OLD.source_wallet_id,OLD.domain_id,OLD.reset_epoch,OLD.seed_id,OLD.network,
 OLD.nonce,OLD.asset_id,OLD.principal_units,OLD.maximum_fee_units,OLD.request_digest,OLD.evidence,OLD.created_at) THEN
  RAISE EXCEPTION 'EVM liquidity reservation terms are immutable';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_evm_liquidity BEFORE INSERT OR UPDATE OR DELETE ON evm_liquidity_reservations
 FOR EACH ROW EXECUTE FUNCTION protect_evm_liquidity_reservation();

CREATE FUNCTION sync_evm_liquidity_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- Older Wallet workers prepare under the retained one-source fence. Capture their
 -- resource identity without inventing a fresh balance observation or silently losing exposure.
 IF NEW.prepared_request IS NOT NULL AND NEW.plan->>'type'='withdrawal.plan.requested.v1' THEN
  INSERT INTO evm_liquidity_reservations(execution_id,source_wallet_id,domain_id,reset_epoch,seed_id,network,nonce,asset_id,principal_units,maximum_fee_units,request_digest,evidence,state)
  SELECT NEW.id,w.id,NEW.domain_id,NEW.reset_epoch,w.seed_id,w.network,
   COALESCE(NEW.prepared_request#>>'{transaction,nonce}',NEW.prepared_request#>>'{request,transaction,nonce}'),
   NEW.plan#>>'{data,asset,assetId}',NEW.principal_units,NEW.maximum_fee_units,NEW.request_digest,
   jsonb_build_object('provenance','legacy_projection','preparationDigest',NEW.preparation_digest),evm_liquidity_state(NEW)
  FROM wallets w WHERE w.id=NEW.source_wallet_id AND w.chain='ethereum' AND w.custody_role='hot'
  ON CONFLICT(execution_id) DO NOTHING;
 END IF;
 IF EXISTS(SELECT 1 FROM evm_liquidity_reservations r WHERE r.execution_id=NEW.id AND NEW.prepared_request IS NOT NULL AND
 (r.nonce IS DISTINCT FROM COALESCE(NEW.prepared_request#>>'{transaction,nonce}',NEW.prepared_request#>>'{request,transaction,nonce}')
 OR r.principal_units IS DISTINCT FROM NEW.principal_units OR r.maximum_fee_units IS DISTINCT FROM NEW.maximum_fee_units)) THEN
  RAISE EXCEPTION 'Prepared execution differs from its EVM liquidity reservation';
 END IF;
 UPDATE evm_liquidity_reservations SET state=evm_liquidity_state(NEW),updated_at=now() WHERE execution_id=NEW.id;
 RETURN NEW;
END;
$$;
CREATE TRIGGER sync_evm_liquidity AFTER INSERT OR UPDATE OF retired_at,reversed,ledger_ack_revision,settlement_revision,state,prepared_request ON custody_executions
 FOR EACH ROW EXECUTE FUNCTION sync_evm_liquidity_reservation();
