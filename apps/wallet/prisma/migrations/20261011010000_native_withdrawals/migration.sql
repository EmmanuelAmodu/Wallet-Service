ALTER TABLE custody_executions ADD COLUMN terminal_proof_revision INTEGER NOT NULL DEFAULT 0 CHECK (terminal_proof_revision >= 0 AND terminal_proof_revision <= settlement_revision);
CREATE TABLE withdrawals (
  id UUID PRIMARY KEY, customer_id UUID NOT NULL REFERENCES exchange_customers(customer_id) ON DELETE RESTRICT,
  domain_id TEXT NOT NULL, reset_epoch TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL, request JSONB NOT NULL, chain TEXT NOT NULL, network TEXT NOT NULL, asset_id TEXT NOT NULL,
  destination TEXT NOT NULL, principal_units TEXT NOT NULL, customer_fee_units TEXT NOT NULL DEFAULT '0', policy_version TEXT NOT NULL,
  hot_wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT, hot_registry_revision INTEGER NOT NULL,
  reservation_id UUID UNIQUE, attempt_id UUID UNIQUE, state TEXT NOT NULL, reason TEXT, cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
  reservation_revision INTEGER NOT NULL DEFAULT 0, execution_revision INTEGER NOT NULL DEFAULT 0, settlement_revision INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1, next_check_at TIMESTAMPTZ NOT NULL DEFAULT now(), transaction_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT withdrawals_customer_id_idempotency_key_key UNIQUE(customer_id,idempotency_key),
  CONSTRAINT withdrawal_customer_domain_epoch FOREIGN KEY (customer_id,domain_id,reset_epoch) REFERENCES exchange_customers(customer_id,domain_id,reset_epoch) ON DELETE RESTRICT,
  CONSTRAINT withdrawal_native_scope CHECK(chain IN ('ethereum','bitcoin','solana') AND asset_id='token:'||chain||':native'),
  CONSTRAINT withdrawal_amounts CHECK(principal_units ~ '^[1-9][0-9]{0,77}$' AND customer_fee_units='0'),
  CONSTRAINT withdrawal_digest CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT withdrawal_state CHECK(state IN ('reserving','queued','planning','waiting_liquidity','executing','attention','settled','failed','rejected','cancelling','cancelled','reconciliation_required'))
);
CREATE INDEX withdrawals_state_next_check_at_id_idx ON withdrawals(state,next_check_at,id);
CREATE INDEX withdrawals_customer_id_created_at_id_idx ON withdrawals(customer_id,created_at,id);
CREATE FUNCTION protect_withdrawal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Withdrawal history is retained'; END IF;
  IF ROW(NEW.id,NEW.customer_id,NEW.domain_id,NEW.reset_epoch,NEW.idempotency_key,NEW.request_digest,NEW.request,NEW.chain,NEW.network,NEW.asset_id,NEW.destination,NEW.principal_units,NEW.customer_fee_units,NEW.policy_version,NEW.hot_wallet_id,NEW.hot_registry_revision,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.customer_id,OLD.domain_id,OLD.reset_epoch,OLD.idempotency_key,OLD.request_digest,OLD.request,OLD.chain,OLD.network,OLD.asset_id,OLD.destination,OLD.principal_units,OLD.customer_fee_units,OLD.policy_version,OLD.hot_wallet_id,OLD.hot_registry_revision,OLD.created_at) OR
    (OLD.reservation_id IS NOT NULL AND NEW.reservation_id IS DISTINCT FROM OLD.reservation_id) OR
    (OLD.attempt_id IS NOT NULL AND NEW.attempt_id IS DISTINCT FROM OLD.attempt_id) OR
    NEW.revision < OLD.revision OR NEW.execution_revision < OLD.execution_revision OR NEW.settlement_revision < OLD.settlement_revision OR NEW.reservation_revision < OLD.reservation_revision THEN
    RAISE EXCEPTION 'Withdrawal intent, hold, attempt and revisions are immutable';
  END IF;
  IF NEW.state='cancelled' AND EXISTS(SELECT 1 FROM custody_executions WHERE operation_id=NEW.id AND "authorization" IS NOT NULL) THEN
    RAISE EXCEPTION 'Authorized withdrawal cannot be cancelled';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER withdrawal_evidence BEFORE UPDATE OR DELETE ON withdrawals FOR EACH ROW EXECUTE FUNCTION protect_withdrawal();
CREATE OR REPLACE FUNCTION protect_custody_execution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source wallets%ROWTYPE; hot wallets%ROWTYPE; transaction_source uuid;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Custody execution history is retained'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.retired_at IS NOT NULL THEN RAISE EXCEPTION 'New execution must acquire its source fence'; END IF;
    SELECT * INTO STRICT source FROM wallets WHERE id=NEW.source_wallet_id;
    SELECT * INTO STRICT hot FROM wallets WHERE id=NEW.hot_wallet_id;
    SELECT wallet_id INTO STRICT transaction_source FROM transactions WHERE id=NEW.transaction_id;
    IF NEW.plan->>'type' = 'withdrawal.plan.requested.v1' THEN
      IF source.custody_role <> 'hot' OR source.account <> 0 OR hot.id <> source.id OR
         source.custody_domain_id IS DISTINCT FROM NEW.domain_id OR source.reset_epoch IS DISTINCT FROM NEW.reset_epoch OR transaction_source <> source.id OR
         NOT EXISTS(SELECT 1 FROM withdrawals WHERE id=NEW.operation_id AND customer_id=NEW.customer_id AND domain_id=NEW.domain_id AND reset_epoch=NEW.reset_epoch AND hot_wallet_id=source.id AND attempt_id=NEW.attempt_id AND request_digest=NEW.request_digest AND reservation_id IS NOT NULL AND NOT cancel_requested) THEN
        RAISE EXCEPTION 'Withdrawal execution ownership or hold mismatch';
      END IF;
    ELSIF NEW.plan->>'type' = 'sweep.plan.requested.v1' THEN
      IF source.custody_role <> 'customer_deposit' OR source.account < 10 OR hot.custody_role <> 'hot' OR hot.account <> 0 OR
         source.customer_id IS DISTINCT FROM NEW.customer_id OR source.hot_wallet_id IS DISTINCT FROM hot.id OR
         source.custody_domain_id IS DISTINCT FROM NEW.domain_id OR source.reset_epoch IS DISTINCT FROM NEW.reset_epoch OR
         hot.custody_domain_id IS DISTINCT FROM NEW.domain_id OR hot.reset_epoch IS DISTINCT FROM NEW.reset_epoch OR
         source.seed_id <> hot.seed_id OR source.chain <> hot.chain OR source.network <> hot.network OR transaction_source <> source.id THEN
        RAISE EXCEPTION 'Custody execution ownership mismatch';
      END IF;
    ELSE RAISE EXCEPTION 'Unsupported custody execution purpose';
    END IF;
  ELSE
    IF OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL AND NOT (
      (NEW.authorization IS NULL AND NEW.state='deferred') OR
      (NEW.state IN ('confirmed','failed') AND NEW.inclusion IS NOT NULL AND NOT NEW.reversed AND NEW.ledger_ack_revision=NEW.settlement_revision AND NEW.settlement_revision>0)) THEN
      RAISE EXCEPTION 'Signed or uncertain execution cannot retire before canonical settlement acknowledgement';
    END IF;
    IF ROW(NEW.id,NEW.operation_id,NEW.attempt_id,NEW.transaction_id,NEW.domain_id,NEW.reset_epoch,NEW.customer_id,NEW.source_wallet_id,NEW.hot_wallet_id,NEW.request_digest,NEW.plan,NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id,OLD.operation_id,OLD.attempt_id,OLD.transaction_id,OLD.domain_id,OLD.reset_epoch,OLD.customer_id,OLD.source_wallet_id,OLD.hot_wallet_id,OLD.request_digest,OLD.plan,OLD.created_at) THEN
      RAISE EXCEPTION 'Custody execution identity is immutable';
    END IF;
    IF OLD.prepared_request IS NOT NULL AND ROW(NEW.prepared_request,NEW.preparation_digest,NEW.principal_units,NEW.maximum_fee_units,NEW.expires_at)
       IS DISTINCT FROM ROW(OLD.prepared_request,OLD.preparation_digest,OLD.principal_units,OLD.maximum_fee_units,OLD.expires_at) THEN
      RAISE EXCEPTION 'Custody execution preparation is immutable';
    END IF;
    IF OLD.authorization IS NOT NULL AND NEW.authorization IS DISTINCT FROM OLD.authorization THEN
      RAISE EXCEPTION 'Custody execution authorization is immutable';
    END IF;
    IF OLD.signer_result IS NOT NULL AND NEW.signer_result IS DISTINCT FROM OLD.signer_result THEN
      RAISE EXCEPTION 'Authenticated custody signer result is immutable';
    END IF;
    IF NEW.revision < OLD.revision OR NEW.settlement_revision < OLD.settlement_revision OR NEW.ledger_ack_revision < OLD.ledger_ack_revision OR NEW.terminal_proof_revision < OLD.terminal_proof_revision THEN
      RAISE EXCEPTION 'Custody execution revisions cannot regress';
    END IF;
  END IF;
  RETURN NEW;
END $$;
