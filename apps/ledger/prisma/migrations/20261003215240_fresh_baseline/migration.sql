-- CreateEnum
CREATE TYPE "LedgerActivityState" AS ENUM ('observed', 'finalized', 'failed', 'reverted', 'attention');

-- CreateEnum
CREATE TYPE "LedgerActivitySourceStatus" AS ENUM ('success', 'failed');

-- CreateEnum
CREATE TYPE "LedgerEntryAccountKind" AS ENUM ('wallet', 'clearing');

-- CreateEnum
CREATE TYPE "LedgerEntrySide" AS ENUM ('debit', 'credit');

-- CreateEnum
CREATE TYPE "LedgerBalanceState" AS ENUM ('provisional', 'confirmed');

-- CreateEnum
CREATE TYPE "LedgerEntryKind" AS ENUM ('wallet', 'clearing', 'reversal');

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
    "transaction_hash_key" TEXT NOT NULL,
    "state" "LedgerActivityState" NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "observation_sequence" BIGINT NOT NULL DEFAULT 0,
    "canonical_reconciliation" BOOLEAN NOT NULL DEFAULT false,
    "block_hash" TEXT,
    "block_height" BIGINT,
    "completed_at_ms" BIGINT NOT NULL,
    "source_status" "LedgerActivitySourceStatus" NOT NULL,
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
    "account_key" TEXT NOT NULL,
    "sequence" BIGINT NOT NULL,
    "wallet_id" UUID,
    "asset" TEXT NOT NULL,
    "account_kind" "LedgerEntryAccountKind" NOT NULL,
    "side" "LedgerEntrySide" NOT NULL,
    "amount" DECIMAL(96,18) NOT NULL,
    "balance_after" DECIMAL(96,18) NOT NULL,
    "balance_state" "LedgerBalanceState" NOT NULL,
    "entry_kind" "LedgerEntryKind" NOT NULL,
    "previous_entry_id" UUID,
    "reversal_of_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
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
CREATE INDEX "ledger_activities_chain_network_transaction_hash_key_idx" ON "ledger_activities"("chain", "network", "transaction_hash_key");

-- CreateIndex
CREATE INDEX "ledger_activities_state_updated_at_idx" ON "ledger_activities"("state", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_previous_entry_id_key" ON "ledger_entries"("previous_entry_id");

-- CreateIndex
CREATE INDEX "ledger_entries_activity_identifier_revision_idx" ON "ledger_entries"("activity_identifier", "revision");

-- CreateIndex
CREATE INDEX "ledger_entries_wallet_id_account_key_sequence_idx" ON "ledger_entries"("wallet_id", "account_key", "sequence" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_account_key_sequence_key" ON "ledger_entries"("account_key", "sequence");

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_activity_identifier_fkey" FOREIGN KEY ("activity_identifier") REFERENCES "ledger_activities"("identifier") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "ledger_wallets"("wallet_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_previous_entry_id_fkey" FOREIGN KEY ("previous_entry_id") REFERENCES "ledger_entries"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_reversal_of_id_fkey" FOREIGN KEY ("reversal_of_id") REFERENCES "ledger_entries"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "ledger_entries"
    ADD CONSTRAINT "ledger_entries_amount_check" CHECK ("amount" > 0),
    ADD CONSTRAINT "ledger_entries_sequence_check" CHECK ("sequence" > 0),
    ADD CONSTRAINT "ledger_entries_account_owner_check"
        CHECK (("account_kind" = 'wallet' AND "wallet_id" IS NOT NULL) OR
                     ("account_kind" = 'clearing' AND "wallet_id" IS NULL)),
    ADD CONSTRAINT "ledger_entries_reversal_check"
        CHECK (("entry_kind" = 'reversal' AND "reversal_of_id" IS NOT NULL) OR
                     ("entry_kind" <> 'reversal' AND "reversal_of_id" IS NULL)),
    ADD CONSTRAINT "ledger_entries_wallet_clearing_check"
        CHECK (("entry_kind" = 'wallet' AND "account_kind" = 'wallet') OR
                     ("entry_kind" = 'clearing' AND "account_kind" = 'clearing') OR
                     "entry_kind" = 'reversal');
