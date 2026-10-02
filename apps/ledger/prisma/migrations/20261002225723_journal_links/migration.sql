/*
  Warnings:

  - A unique constraint covering the columns `[last_entry_id]` on the table `ledger_accounts` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[previous_entry_id]` on the table `ledger_entries` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[next_entry_id]` on the table `ledger_entries` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_last_entry_id_key" ON "ledger_accounts"("last_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_previous_entry_id_key" ON "ledger_entries"("previous_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_next_entry_id_key" ON "ledger_entries"("next_entry_id");

-- RenameForeignKey
ALTER TABLE "ledger_accounts" RENAME CONSTRAINT "ledger_accounts_last_entry_fkey" TO "ledger_accounts_last_entry_id_fkey";
