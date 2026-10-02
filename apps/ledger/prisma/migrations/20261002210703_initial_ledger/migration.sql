-- CreateTable
CREATE TABLE "ledger_wallets" (
    "wallet_id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "address_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_wallets_pkey" PRIMARY KEY ("wallet_id")
);

-- CreateTable
CREATE TABLE "ledger_activities" (
    "identifier" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "transaction_hash" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "block_hash" TEXT,
    "block_height" BIGINT,
    "completed_at_ms" BIGINT NOT NULL,
    "source_status" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "finalized_at" TIMESTAMPTZ,

    CONSTRAINT "ledger_activities_pkey" PRIMARY KEY ("identifier")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "activity_identifier" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "wallet_id" UUID NOT NULL,
    "asset" TEXT NOT NULL,
    "amount" DECIMAL(96,18) NOT NULL,
    "kind" TEXT NOT NULL,
    "reverses_id" UUID,
    "reversed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_balances" (
    "wallet_id" UUID NOT NULL,
    "asset" TEXT NOT NULL,
    "confirmed_amount" DECIMAL(96,18) NOT NULL DEFAULT 0,
    "provisional_amount" DECIMAL(96,18) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ledger_balances_pkey" PRIMARY KEY ("wallet_id","asset")
);

-- CreateTable
CREATE TABLE "inbox" (
    "id" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ledger_wallets_chain_network_address_key_key" ON "ledger_wallets"("chain", "network", "address_key");

-- CreateIndex
CREATE INDEX "ledger_activities_chain_network_block_height_idx" ON "ledger_activities"("chain", "network", "block_height");

-- CreateIndex
CREATE INDEX "ledger_activities_state_updated_at_idx" ON "ledger_activities"("state", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_reverses_id_key" ON "ledger_entries"("reverses_id");

-- CreateIndex
CREATE INDEX "ledger_entries_wallet_id_asset_created_at_idx" ON "ledger_entries"("wallet_id", "asset", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_activity_identifier_revision_kind_wallet_id__key" ON "ledger_entries"("activity_identifier", "revision", "kind", "wallet_id", "asset");

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_activity_identifier_fkey" FOREIGN KEY ("activity_identifier") REFERENCES "ledger_activities"("identifier") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "ledger_wallets"("wallet_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_reverses_id_fkey" FOREIGN KEY ("reverses_id") REFERENCES "ledger_entries"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ledger_balances" ADD CONSTRAINT "ledger_balances_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "ledger_wallets"("wallet_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
