-- SQL CHECK treats NULL as success. Require the complete JSON binding explicitly.
ALTER TABLE "transactions" DROP CONSTRAINT "custody_execution_binding";
ALTER TABLE "transactions" ADD CONSTRAINT "custody_execution_binding" CHECK (
  COALESCE(
    ("operation_id" IS NULL AND "attempt_id" IS NULL AND "domain_id" IS NULL
     AND "reset_epoch" IS NULL AND "request_digest" IS NULL AND "preparation_digest" IS NULL
     AND NOT ("snapshot" ? 'execution'))
    OR
    ("operation_id" IS NOT NULL AND "attempt_id" IS NOT NULL AND "domain_id" IS NOT NULL
     AND "reset_epoch" IS NOT NULL AND "request_digest" IS NOT NULL AND "preparation_digest" IS NOT NULL
     AND "request_digest" ~ '^[a-f0-9]{64}$' AND "preparation_digest" ~ '^[a-f0-9]{64}$'
     AND jsonb_typeof("snapshot"->'execution') = 'object'
     AND "snapshot"->'execution'->>'domainId' = "domain_id"
     AND "snapshot"->'execution'->>'resetEpoch' = "reset_epoch"
     AND "snapshot"->'execution'->>'operationId' = "operation_id"::text
     AND "snapshot"->'execution'->>'attemptId' = "attempt_id"::text
     AND "snapshot"->'execution'->>'requestDigest' = "request_digest"
     AND "snapshot"->'execution'->>'preparationDigest' = "preparation_digest"),
    FALSE
  )
);

ALTER TABLE "transactions" ADD CONSTRAINT "custody_terminal_evidence" CHECK (
  "operation_id" IS NULL OR "status" NOT IN ('confirmed', 'failed')
  OR ("observed_block_hash" IS NOT NULL AND "observed_block_height" IS NOT NULL
      AND "actual_fee_units" IS NOT NULL)
);

CREATE FUNCTION immutable_broadcast_snapshot() RETURNS trigger AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."snapshot" IS DISTINCT FROM OLD."snapshot"
     OR NEW."domain_id" IS DISTINCT FROM OLD."domain_id"
     OR NEW."reset_epoch" IS DISTINCT FROM OLD."reset_epoch"
     OR NEW."operation_id" IS DISTINCT FROM OLD."operation_id"
     OR NEW."attempt_id" IS DISTINCT FROM OLD."attempt_id"
     OR NEW."request_digest" IS DISTINCT FROM OLD."request_digest"
     OR NEW."preparation_digest" IS DISTINCT FROM OLD."preparation_digest" THEN
    RAISE EXCEPTION 'Broadcast bytes and execution identity are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER immutable_broadcast_snapshot
BEFORE UPDATE ON "transactions"
FOR EACH ROW EXECUTE FUNCTION immutable_broadcast_snapshot();
