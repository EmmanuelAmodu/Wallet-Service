ALTER TABLE custody_executions ADD COLUMN ledger_intent_ack BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE custody_executions ADD COLUMN listener_intent_ack BOOLEAN NOT NULL DEFAULT false;
CREATE OR REPLACE FUNCTION protect_custody_execution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source wallets%ROWTYPE; hot wallets%ROWTYPE; transaction_source uuid;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Custody execution history is retained'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.retired_at IS NOT NULL THEN RAISE EXCEPTION 'New execution must acquire its source fence'; END IF;
    SELECT * INTO STRICT source FROM wallets WHERE id=NEW.source_wallet_id;
    SELECT * INTO STRICT hot FROM wallets WHERE id=NEW.hot_wallet_id;
    SELECT wallet_id INTO STRICT transaction_source FROM transactions WHERE id=NEW.transaction_id;
    IF NEW.plan->>'type' = 'funding.plan.requested.v1' THEN
      IF source.custody_role <> 'management' OR source.account <> 1 OR source.management_purpose <> 'gas_fee' OR
         hot.custody_role <> 'customer_deposit' OR hot.account < 10 OR hot.customer_id IS DISTINCT FROM NEW.customer_id OR
         source.chain <> 'ethereum' OR source.network <> '11155111' OR source.chain <> hot.chain OR source.network <> hot.network OR
         source.seed_id <> hot.seed_id OR source.custody_domain_id IS DISTINCT FROM NEW.domain_id OR hot.custody_domain_id IS DISTINCT FROM NEW.domain_id OR
         source.reset_epoch IS DISTINCT FROM NEW.reset_epoch OR hot.reset_epoch IS DISTINCT FROM NEW.reset_epoch OR transaction_source <> source.id OR
         NOT EXISTS(SELECT 1 FROM token_fee_reservations WHERE id=NEW.operation_id AND id=(NEW.plan->'data'->>'feeReservationId')::uuid
           AND management_wallet_id=source.id AND source_wallet_id=hot.id AND customer_id=NEW.customer_id AND domain_id=NEW.domain_id AND reset_epoch=NEW.reset_epoch
           AND kind='gas_funding' AND principal_units=NEW.plan->'data'->>'amount' AND state='reserved') THEN
        RAISE EXCEPTION 'Management funding execution ownership or reservation mismatch';
      END IF;
    ELSIF NEW.plan->>'type' = 'withdrawal.plan.requested.v1' THEN
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
    IF (OLD.ledger_intent_ack AND NOT NEW.ledger_intent_ack) OR (OLD.listener_intent_ack AND NOT NEW.listener_intent_ack) THEN RAISE EXCEPTION 'Execution registry acknowledgments cannot regress'; END IF;
    IF NEW.revision < OLD.revision OR NEW.settlement_revision < OLD.settlement_revision OR NEW.ledger_ack_revision < OLD.ledger_ack_revision OR NEW.terminal_proof_revision < OLD.terminal_proof_revision THEN
      RAISE EXCEPTION 'Custody execution revisions cannot regress';
    END IF;
  END IF;
  RETURN NEW;
END $$;
