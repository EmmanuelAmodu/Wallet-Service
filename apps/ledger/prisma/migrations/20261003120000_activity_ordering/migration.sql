ALTER TABLE "ledger_activities"
  ADD COLUMN "observation_sequence" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "canonical_reconciliation" BOOLEAN NOT NULL DEFAULT false;