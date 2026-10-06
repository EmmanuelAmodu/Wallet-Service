ALTER TABLE "transactions"
  ADD COLUMN "domain_id" TEXT,
  ADD COLUMN "reset_epoch" TEXT,
  ADD COLUMN "operation_id" UUID,
  ADD COLUMN "attempt_id" UUID,
  ADD COLUMN "request_digest" TEXT,
  ADD COLUMN "preparation_digest" TEXT,
  ADD COLUMN "observed_block_hash" TEXT,
  ADD COLUMN "observed_block_height" TEXT,
  ADD COLUMN "actual_fee_units" TEXT;

CREATE UNIQUE INDEX "transactions_attempt_id_key" ON "transactions"("attempt_id");
CREATE INDEX "transactions_operation_id_created_at_idx" ON "transactions"("operation_id", "created_at");

ALTER TABLE "transactions" ADD CONSTRAINT "custody_execution_binding"
CHECK (
  ("operation_id" IS NULL AND "attempt_id" IS NULL AND "domain_id" IS NULL AND "reset_epoch" IS NULL AND "request_digest" IS NULL AND "preparation_digest" IS NULL AND NOT ("snapshot" ? 'execution')) OR
  ("operation_id" IS NOT NULL AND "attempt_id" IS NOT NULL AND "domain_id" IS NOT NULL AND "reset_epoch" IS NOT NULL AND "request_digest" ~ '^[a-f0-9]{64}$' AND "preparation_digest" ~ '^[a-f0-9]{64}$'
   AND "snapshot"->'execution'->>'domainId' = "domain_id"
   AND "snapshot"->'execution'->>'resetEpoch' = "reset_epoch"
   AND "snapshot"->'execution'->>'operationId' = "operation_id"::text
   AND "snapshot"->'execution'->>'attemptId' = "attempt_id"::text
   AND "snapshot"->'execution'->>'requestDigest' = "request_digest"
   AND "snapshot"->'execution'->>'preparationDigest' = "preparation_digest")
);
ALTER TABLE "transactions" ADD CONSTRAINT "custody_canonical_amounts"
CHECK (("actual_fee_units" IS NULL OR "actual_fee_units" ~ '^(0|[1-9][0-9]{0,77})$') AND ("observed_block_height" IS NULL OR "observed_block_height" ~ '^(0|[1-9][0-9]*)$'));
