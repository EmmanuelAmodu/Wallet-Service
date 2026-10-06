-- AlterTable
ALTER TABLE "sweep_work" ADD COLUMN     "active_operation_id" UUID,
ADD COLUMN     "consumed_generation" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "generation" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "last_scanned_at" TIMESTAMPTZ,
ADD COLUMN     "next_attempt_at" TIMESTAMPTZ,
ADD COLUMN     "scheduling_error" TEXT;

-- CreateTable
CREATE TABLE "sweep_operations" (
    "id" UUID NOT NULL,
    "work_id" UUID NOT NULL,
    "domain_id" TEXT NOT NULL,
    "reset_epoch" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "source_wallet_id" UUID NOT NULL,
    "hot_wallet_id" UUID NOT NULL,
    "chain" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "source_registry_revision" INTEGER NOT NULL,
    "hot_registry_revision" INTEGER NOT NULL,
    "policy_version" TEXT NOT NULL,
    "request_digest" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "reason" TEXT,
    "terminal_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sweep_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sweep_attempts" (
    "id" UUID NOT NULL,
    "operation_id" UUID NOT NULL,
    "preparation_digest" TEXT,
    "amount" TEXT,
    "maximum_fee_units" TEXT,
    "expires_at" TIMESTAMPTZ,
    "execute_event_id" UUID,
    "state" TEXT NOT NULL,
    "transaction_hash" TEXT,
    "terminal_safe" BOOLEAN NOT NULL DEFAULT false,
    "execution_revision" INTEGER NOT NULL DEFAULT 0,
    "execution_digest" TEXT,
    "settlement_revision" INTEGER NOT NULL DEFAULT 0,
    "settlement_digest" TEXT,
    "settlement_state" TEXT NOT NULL DEFAULT 'none',
    "ledger_batch_id" UUID,
    "reversal_fence_revision" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sweep_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sweep_exceptions" (
    "id" UUID NOT NULL,
    "domain_id" TEXT NOT NULL,
    "reset_epoch" TEXT NOT NULL,
    "work_id" UUID NOT NULL,
    "operation_id" UUID,
    "category" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "occurrence_count" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sweep_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sweep_funding_policies" (
    "id" UUID NOT NULL,
    "domain_id" TEXT NOT NULL,
    "reset_epoch" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "management_wallet_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "policy_version" TEXT NOT NULL,
    "per_operation_cap" TEXT NOT NULL,
    "per_customer_daily_cap" TEXT NOT NULL,
    "per_domain_daily_cap" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sweep_funding_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sweep_funding_intents" (
    "id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "domain_id" TEXT NOT NULL,
    "reset_epoch" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "source_wallet_id" UUID NOT NULL,
    "destination_wallet_id" UUID NOT NULL,
    "requested_units" TEXT NOT NULL,
    "request_digest" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'blocked_policy',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sweep_funding_intents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sweep_operations_domain_id_reset_epoch_source_wallet_id_ter_idx" ON "sweep_operations"("domain_id", "reset_epoch", "source_wallet_id", "terminal_at");

-- CreateIndex
CREATE UNIQUE INDEX "sweep_attempts_operation_id_key" ON "sweep_attempts"("operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "sweep_attempts_execute_event_id_key" ON "sweep_attempts"("execute_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "sweep_exceptions_fingerprint_key" ON "sweep_exceptions"("fingerprint");

-- CreateIndex
CREATE INDEX "sweep_exceptions_domain_id_reset_epoch_category_idx" ON "sweep_exceptions"("domain_id", "reset_epoch", "category");

-- CreateIndex
CREATE UNIQUE INDEX "sweep_funding_policies_domain_id_reset_epoch_chain_network__key" ON "sweep_funding_policies"("domain_id", "reset_epoch", "chain", "network", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "sweep_funding_intents_request_digest_key" ON "sweep_funding_intents"("request_digest");

-- CreateIndex
CREATE INDEX "sweep_funding_intents_domain_id_reset_epoch_customer_id_cre_idx" ON "sweep_funding_intents"("domain_id", "reset_epoch", "customer_id", "created_at");
-- A source retains its fence across signed, submitted, unknown and reorg outcomes.
CREATE UNIQUE INDEX "sweep_operations_one_active_source"
ON "sweep_operations" (domain_id, reset_epoch, source_wallet_id)
WHERE terminal_at IS NULL;

ALTER TABLE sweep_work ADD CONSTRAINT sweep_work_generation CHECK (generation > 0 AND consumed_generation >= 0);
ALTER TABLE sweep_operations ADD CONSTRAINT sweep_operation_identity CHECK
  (generation > 0 AND source_registry_revision > 0 AND hot_registry_revision > 0
   AND request_digest ~ '^[a-f0-9]{64}$' AND source_wallet_id <> hot_wallet_id);
ALTER TABLE sweep_attempts ADD CONSTRAINT sweep_attempt_amount CHECK
  ((amount IS NULL OR (amount ~ '^[1-9][0-9]{0,77}$' AND amount::numeric < power(2::numeric,256)))
   AND (maximum_fee_units IS NULL OR (maximum_fee_units ~ '^(0|[1-9][0-9]{0,77})$' AND maximum_fee_units::numeric < power(2::numeric,256)))
   AND (preparation_digest IS NULL OR preparation_digest ~ '^[a-f0-9]{64}$'));
ALTER TABLE sweep_funding_policies ADD CONSTRAINT sweep_funding_policy_caps CHECK
  (purpose = 'gas_fee' AND per_operation_cap ~ '^[1-9][0-9]{0,77}$'
   AND per_customer_daily_cap ~ '^[1-9][0-9]{0,77}$' AND per_domain_daily_cap ~ '^[1-9][0-9]{0,77}$'
   AND per_operation_cap::numeric <= per_customer_daily_cap::numeric
   AND per_customer_daily_cap::numeric <= per_domain_daily_cap::numeric
   AND per_domain_daily_cap::numeric < power(2::numeric,256));
ALTER TABLE sweep_funding_intents ADD CONSTRAINT sweep_funding_intent_units CHECK
  (requested_units ~ '^[1-9][0-9]{0,77}$' AND requested_units::numeric < power(2::numeric,256)
   AND request_digest ~ '^[a-f0-9]{64}$' AND source_wallet_id <> destination_wallet_id);

CREATE FUNCTION sweep_operation_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['state','reason','terminal_at','updated_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state','reason','terminal_at','updated_at']) THEN
    RAISE EXCEPTION 'Sweep operation identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sweep_operation_identity_immutable BEFORE UPDATE ON sweep_operations
FOR EACH ROW EXECUTE FUNCTION sweep_operation_identity_immutable();

CREATE FUNCTION sweep_attempt_preparation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.operation_id <> OLD.operation_id
     OR (OLD.preparation_digest IS NOT NULL AND
        (NEW.preparation_digest,NEW.amount,NEW.maximum_fee_units,NEW.expires_at)
        IS DISTINCT FROM (OLD.preparation_digest,OLD.amount,OLD.maximum_fee_units,OLD.expires_at))
     OR (OLD.execute_event_id IS NOT NULL AND NEW.execute_event_id IS DISTINCT FROM OLD.execute_event_id) THEN
    RAISE EXCEPTION 'Sweep attempt preparation is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sweep_attempt_preparation_immutable BEFORE UPDATE ON sweep_attempts
FOR EACH ROW EXECUTE FUNCTION sweep_attempt_preparation_immutable();
