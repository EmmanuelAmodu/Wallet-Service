/*
  Warnings:

  - You are about to drop the column `kind` on the `ledger_entries` table. All the data in the column will be lost.
  - You are about to drop the column `reversed_at` on the `ledger_entries` table. All the data in the column will be lost.
  - You are about to drop the column `reverses_id` on the `ledger_entries` table. All the data in the column will be lost.
  - You are about to drop the `ledger_balances` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[account_key,sequence]` on the table `ledger_entries` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `account_key` to the `ledger_entries` table without a default value. This is not possible if the table is not empty.
  - Added the required column `account_kind` to the `ledger_entries` table without a default value. This is not possible if the table is not empty.
  - Added the required column `balance_after` to the `ledger_entries` table without a default value. This is not possible if the table is not empty.
  - Added the required column `balance_state` to the `ledger_entries` table without a default value. This is not possible if the table is not empty.
  - Added the required column `entry_kind` to the `ledger_entries` table without a default value. This is not possible if the table is not empty.
  - Added the required column `sequence` to the `ledger_entries` table without a default value. This is not possible if the table is not empty.
  - Added the required column `side` to the `ledger_entries` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "ledger_balances" DROP CONSTRAINT "ledger_balances_wallet_id_fkey";

-- DropForeignKey
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_reverses_id_fkey";

-- DropIndex
DROP INDEX "ledger_entries_activity_identifier_revision_kind_wallet_id__key";

-- DropIndex
DROP INDEX "ledger_entries_reverses_id_key";

-- DropIndex
DROP INDEX "ledger_entries_wallet_id_asset_created_at_idx";

-- AlterTable
ALTER TABLE "ledger_entries" DROP COLUMN "kind",
DROP COLUMN "reversed_at",
DROP COLUMN "reverses_id",
ADD COLUMN     "account_key" TEXT NOT NULL,
ADD COLUMN     "account_kind" TEXT NOT NULL,
ADD COLUMN     "balance_after" DECIMAL(96,18) NOT NULL,
ADD COLUMN     "balance_state" TEXT NOT NULL,
ADD COLUMN     "entry_kind" TEXT NOT NULL,
ADD COLUMN     "next_entry_id" UUID,
ADD COLUMN     "previous_entry_id" UUID,
ADD COLUMN     "reversal_of_id" UUID,
ADD COLUMN     "sequence" BIGINT NOT NULL,
ADD COLUMN     "side" TEXT NOT NULL,
ALTER COLUMN "wallet_id" DROP NOT NULL;

-- DropTable
DROP TABLE "ledger_balances";

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "account_key" TEXT NOT NULL,
    "account_kind" TEXT NOT NULL,
    "normal_side" TEXT NOT NULL,
    "balance_state" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "wallet_id" UUID,
    "next_sequence" BIGINT NOT NULL DEFAULT 1,
    "last_entry_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("account_key")
);

-- CreateIndex
CREATE INDEX "ledger_accounts_wallet_id_balance_state_idx" ON "ledger_accounts"("wallet_id", "balance_state");

-- CreateIndex
CREATE INDEX "ledger_accounts_chain_network_asset_account_kind_balance_st_idx" ON "ledger_accounts"("chain", "network", "asset", "account_kind", "balance_state");

-- CreateIndex
CREATE INDEX "ledger_entries_activity_identifier_revision_idx" ON "ledger_entries"("activity_identifier", "revision");

-- CreateIndex
CREATE INDEX "ledger_entries_wallet_id_asset_balance_state_sequence_idx" ON "ledger_entries"("wallet_id", "asset", "balance_state", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_account_key_sequence_key" ON "ledger_entries"("account_key", "sequence");

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_key_fkey" FOREIGN KEY ("account_key") REFERENCES "ledger_accounts"("account_key") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_previous_entry_id_fkey" FOREIGN KEY ("previous_entry_id") REFERENCES "ledger_entries"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_next_entry_id_fkey" FOREIGN KEY ("next_entry_id") REFERENCES "ledger_entries"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_reversal_of_id_fkey" FOREIGN KEY ("reversal_of_id") REFERENCES "ledger_entries"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "ledger_wallets"("wallet_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
