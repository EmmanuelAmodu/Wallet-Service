CREATE TABLE "settlement_reversals" (
    "operation_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "domain_id" TEXT NOT NULL,
    "reset_epoch" TEXT NOT NULL,
    "attempt_id" UUID NOT NULL,
    "request_digest" TEXT NOT NULL,
    "customer_id" UUID,
    "prior_settlement_revision" INTEGER NOT NULL,
    "data_digest" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "prior_settlement_digest" TEXT,
    "prior_settlement_payload" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_reversals_pkey" PRIMARY KEY ("operation_id", "revision"),
    CONSTRAINT "settlement_reversals_revision_check" CHECK ("prior_settlement_revision" > 0 AND "revision" > "prior_settlement_revision")
);

CREATE INDEX "settlement_reversals_domain_id_operation_id_idx" ON "settlement_reversals"("domain_id", "operation_id");
