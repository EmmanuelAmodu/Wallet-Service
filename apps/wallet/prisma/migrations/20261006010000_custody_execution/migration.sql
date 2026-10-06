-- CreateTable
CREATE TABLE "custody_executions" (
    "id" UUID NOT NULL,
    "operation_id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "domain_id" TEXT NOT NULL,
    "reset_epoch" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "source_wallet_id" UUID NOT NULL,
    "hot_wallet_id" UUID NOT NULL,
    "request_digest" TEXT NOT NULL,
    "plan" JSONB NOT NULL,
    "prepared_request" JSONB,
    "preparation_digest" TEXT,
    "authorization" JSONB,
    "principal_units" TEXT,
    "maximum_fee_units" TEXT,
    "expires_at" TIMESTAMPTZ,
    "state" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "settlement_revision" INTEGER NOT NULL DEFAULT 0,
    "ledger_ack_revision" INTEGER NOT NULL DEFAULT 0,
    "ledger_batch_id" UUID,
    "inclusion" JSONB,
    "reversed" BOOLEAN NOT NULL DEFAULT false,
    "retired_at" TIMESTAMPTZ,
    "next_check_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custody_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execution_resource_claims" (
    "id" UUID NOT NULL,
    "resource_key" TEXT NOT NULL,
    "execution_id" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMPTZ,

    CONSTRAINT "execution_resource_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "custody_executions_operation_id_key" ON "custody_executions"("operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "custody_executions_attempt_id_key" ON "custody_executions"("attempt_id");

-- CreateIndex
CREATE UNIQUE INDEX "custody_executions_transaction_id_key" ON "custody_executions"("transaction_id");

-- CreateIndex
CREATE INDEX "custody_executions_next_check_at_id_idx" ON "custody_executions"("next_check_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "one_active_custody_execution_per_source" ON "custody_executions"("source_wallet_id") WHERE ("retired_at" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "one_active_custody_resource_claim" ON "execution_resource_claims"("resource_key") WHERE ("active");

-- AddForeignKey
ALTER TABLE "custody_executions" ADD CONSTRAINT "custody_executions_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "execution_resource_claims" ADD CONSTRAINT "execution_resource_claims_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "custody_executions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

