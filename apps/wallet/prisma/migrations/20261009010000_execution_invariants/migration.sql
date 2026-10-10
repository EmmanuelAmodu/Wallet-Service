-- Native execution evidence remains immutable after preparation/authorization.
ALTER TABLE custody_executions ADD COLUMN signer_result JSONB;
ALTER TABLE custody_executions
  ADD CONSTRAINT custody_execution_state CHECK (state IN ('planning','prepared','deferred','signing','queued','submitted','confirmed','failed','attention')),
  ADD CONSTRAINT custody_execution_revisions CHECK (revision >= 0 AND settlement_revision >= 0 AND ledger_ack_revision >= 0),
  ADD CONSTRAINT custody_execution_digest CHECK (request_digest ~ '^[a-f0-9]{64}$' AND (preparation_digest IS NULL OR preparation_digest ~ '^[a-f0-9]{64}$')),
  ADD CONSTRAINT custody_execution_amounts CHECK (
    (principal_units IS NULL OR principal_units ~ '^[1-9][0-9]*$') AND
    (maximum_fee_units IS NULL OR maximum_fee_units ~ '^(0|[1-9][0-9]*)$')),
  ADD CONSTRAINT custody_execution_preparation CHECK (
    (prepared_request IS NULL AND preparation_digest IS NULL AND principal_units IS NULL AND maximum_fee_units IS NULL AND expires_at IS NULL) OR
    (prepared_request IS NOT NULL AND preparation_digest IS NOT NULL AND principal_units IS NOT NULL AND maximum_fee_units IS NOT NULL AND expires_at IS NOT NULL)),
  ADD CONSTRAINT custody_execution_authorization CHECK ("authorization" IS NULL OR prepared_request IS NOT NULL);

CREATE FUNCTION protect_custody_execution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source wallets%ROWTYPE; hot wallets%ROWTYPE; transaction_source uuid;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Custody execution history is retained'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.retired_at IS NOT NULL THEN RAISE EXCEPTION 'New execution must acquire its source fence'; END IF;
    SELECT * INTO STRICT source FROM wallets WHERE id=NEW.source_wallet_id;
    SELECT * INTO STRICT hot FROM wallets WHERE id=NEW.hot_wallet_id;
    SELECT wallet_id INTO STRICT transaction_source FROM transactions WHERE id=NEW.transaction_id;
    IF source.custody_role <> 'customer_deposit' OR source.account < 10 OR hot.custody_role <> 'hot' OR hot.account <> 0 OR
       source.customer_id IS DISTINCT FROM NEW.customer_id OR source.hot_wallet_id IS DISTINCT FROM hot.id OR
       source.custody_domain_id IS DISTINCT FROM NEW.domain_id OR source.reset_epoch IS DISTINCT FROM NEW.reset_epoch OR
       hot.custody_domain_id IS DISTINCT FROM NEW.domain_id OR hot.reset_epoch IS DISTINCT FROM NEW.reset_epoch OR
       source.seed_id <> hot.seed_id OR source.chain <> hot.chain OR source.network <> hot.network OR transaction_source <> source.id THEN
      RAISE EXCEPTION 'Custody execution ownership mismatch';
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
    IF NEW.revision < OLD.revision OR NEW.settlement_revision < OLD.settlement_revision OR NEW.ledger_ack_revision < OLD.ledger_ack_revision THEN
      RAISE EXCEPTION 'Custody execution revisions cannot regress';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER custody_execution_evidence BEFORE INSERT OR UPDATE OR DELETE ON custody_executions FOR EACH ROW EXECUTE FUNCTION protect_custody_execution();

CREATE FUNCTION protect_execution_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE retired timestamptz;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Execution resource history is retained'; END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.resource_key,NEW.execution_id,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.resource_key,OLD.execution_id,OLD.created_at) THEN
    RAISE EXCEPTION 'Execution resource identity is immutable';
  END IF;
  SELECT retired_at INTO STRICT retired FROM custody_executions WHERE id=NEW.execution_id;
  IF (NEW.active AND retired IS NOT NULL) OR (NOT NEW.active AND retired IS NULL) THEN
    RAISE EXCEPTION 'Execution claims follow authoritative source retirement';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER execution_claim_evidence BEFORE INSERT OR UPDATE OR DELETE ON execution_resource_claims FOR EACH ROW EXECUTE FUNCTION protect_execution_claim();

CREATE FUNCTION protect_signed_custody_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM custody_executions WHERE transaction_id=OLD.id) THEN
    IF ROW(NEW.id,NEW.wallet_id,NEW.idempotency_key,NEW.request_hash,NEW.intent)
       IS DISTINCT FROM ROW(OLD.id,OLD.wallet_id,OLD.idempotency_key,OLD.request_hash,OLD.intent) OR
       (OLD.prepared IS NOT NULL AND NEW.prepared IS DISTINCT FROM OLD.prepared) OR
       (OLD.signed IS NOT NULL AND ROW(NEW.signed,NEW.tx_hash) IS DISTINCT FROM ROW(OLD.signed,OLD.tx_hash)) THEN
      RAISE EXCEPTION 'Custody transaction identity, prepared request and signed bytes are immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signed_custody_transaction_evidence BEFORE UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION protect_signed_custody_transaction();
