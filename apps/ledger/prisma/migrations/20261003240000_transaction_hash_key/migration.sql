ALTER TABLE "ledger_activities"
  ADD COLUMN "transaction_hash_key" TEXT;

UPDATE "ledger_activities"
SET "transaction_hash_key" = CASE
  WHEN "chain" = 'solana' THEN "transaction_hash"
  ELSE lower("transaction_hash")
END;

ALTER TABLE "ledger_activities"
  ALTER COLUMN "transaction_hash_key" SET NOT NULL;

CREATE INDEX "ledger_activities_chain_network_transaction_hash_key_idx"
  ON "ledger_activities"("chain", "network", "transaction_hash_key");