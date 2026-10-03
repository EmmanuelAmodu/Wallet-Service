DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ledger_accounts" a
    LEFT JOIN LATERAL (
      SELECT e."id", e."sequence"
      FROM "ledger_entries" e
      WHERE e."account_key" = a."account_key"
      ORDER BY e."sequence" DESC
      LIMIT 1
    ) latest ON true
    WHERE a."last_entry_id" IS DISTINCT FROM latest."id"
       OR a."next_sequence" <> coalesce(latest."sequence", 0) + 1
  ) THEN
    RAISE EXCEPTION 'Ledger account cursors do not match journal sequence tails';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "ledger_entries" e
    JOIN "ledger_accounts" a ON a."account_key" = e."account_key"
    JOIN "ledger_activities" activity ON activity."identifier" = e."activity_identifier"
    WHERE e."account_kind" <> a."account_kind"
       OR e."balance_state" <> a."balance_state"
       OR e."asset" <> a."asset"
       OR e."wallet_id" IS DISTINCT FROM a."wallet_id"
       OR activity."chain" <> a."chain"
       OR activity."network" <> a."network"
       OR (a."account_kind" = 'wallet' AND a."normal_side" <> 'debit')
       OR (a."account_kind" = 'clearing' AND a."normal_side" <> 'credit')
  ) THEN
    RAISE EXCEPTION 'Ledger account metadata does not match journal entries';
  END IF;
END $$;

ALTER TABLE "ledger_entries"
  DROP CONSTRAINT "ledger_entries_account_key_fkey",
  DROP CONSTRAINT "ledger_entries_next_entry_id_fkey",
  DROP COLUMN "next_entry_id";

DROP INDEX "ledger_entries_wallet_id_asset_balance_state_sequence_idx";
CREATE INDEX "ledger_entries_wallet_id_account_key_sequence_idx"
  ON "ledger_entries"("wallet_id", "account_key", "sequence" DESC);

DROP TABLE "ledger_accounts";