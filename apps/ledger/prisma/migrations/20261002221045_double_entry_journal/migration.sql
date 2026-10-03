ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_activity_identifier_fkey";
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_wallet_id_fkey";
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_reverses_id_fkey";
ALTER TABLE "ledger_balances" DROP CONSTRAINT "ledger_balances_wallet_id_fkey";

ALTER TABLE "ledger_entries" RENAME TO "ledger_legacy_entries";
ALTER TABLE "ledger_balances" RENAME TO "ledger_legacy_balances";

ALTER INDEX "ledger_entries_pkey" RENAME TO "ledger_legacy_entries_pkey";
ALTER INDEX "ledger_entries_reverses_id_key" RENAME TO "ledger_legacy_entries_reverses_id_key";
ALTER INDEX "ledger_entries_wallet_id_asset_created_at_idx" RENAME TO "ledger_legacy_entries_wallet_asset_created_idx";
ALTER INDEX "ledger_entries_activity_identifier_revision_kind_wallet_id__key"
  RENAME TO "ledger_legacy_entries_activity_revision_key";
ALTER INDEX "ledger_balances_pkey" RENAME TO "ledger_legacy_balances_pkey";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ledger_legacy_entries" e
    LEFT JOIN "ledger_legacy_balances" b
      ON b."wallet_id" = e."wallet_id" AND b."asset" = e."asset"
    WHERE b."wallet_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Ledger upgrade stopped: legacy entries have no balance projection to reconcile';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "ledger_legacy_balances" b
    WHERE b."confirmed_amount" <> trunc(b."confirmed_amount")
       OR b."provisional_amount" <> trunc(b."provisional_amount")
       OR abs(b."confirmed_amount") >= power(10::numeric, 78)
       OR abs(b."provisional_amount") >= power(10::numeric, 78)
  ) THEN
    RAISE EXCEPTION 'Ledger upgrade stopped: legacy balances are not supported integer base units';
  END IF;
END $$;

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

CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "activity_identifier" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "account_key" TEXT NOT NULL,
    "sequence" BIGINT NOT NULL,
    "wallet_id" UUID,
    "asset" TEXT NOT NULL,
    "account_kind" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "amount" DECIMAL(96,18) NOT NULL,
    "balance_after" DECIMAL(96,18) NOT NULL,
    "balance_state" TEXT NOT NULL,
    "entry_kind" TEXT NOT NULL,
    "previous_entry_id" UUID,
    "next_entry_id" UUID,
    "reversal_of_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ledger_accounts_wallet_id_balance_state_idx"
  ON "ledger_accounts"("wallet_id", "balance_state");
CREATE INDEX "ledger_accounts_chain_network_asset_account_kind_balance_st_idx"
  ON "ledger_accounts"("chain", "network", "asset", "account_kind", "balance_state");
CREATE INDEX "ledger_entries_activity_identifier_revision_idx"
  ON "ledger_entries"("activity_identifier", "revision");
CREATE INDEX "ledger_entries_wallet_id_asset_balance_state_sequence_idx"
  ON "ledger_entries"("wallet_id", "asset", "balance_state", "sequence");
CREATE UNIQUE INDEX "ledger_entries_account_key_sequence_key"
  ON "ledger_entries"("account_key", "sequence");

ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_activity_identifier_fkey"
    FOREIGN KEY ("activity_identifier") REFERENCES "ledger_activities"("identifier") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "ledger_entries_account_key_fkey"
    FOREIGN KEY ("account_key") REFERENCES "ledger_accounts"("account_key") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "ledger_entries_wallet_id_fkey"
    FOREIGN KEY ("wallet_id") REFERENCES "ledger_wallets"("wallet_id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "ledger_entries_previous_entry_id_fkey"
    FOREIGN KEY ("previous_entry_id") REFERENCES "ledger_entries"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "ledger_entries_next_entry_id_fkey"
    FOREIGN KEY ("next_entry_id") REFERENCES "ledger_entries"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "ledger_entries_reversal_of_id_fkey"
    FOREIGN KEY ("reversal_of_id") REFERENCES "ledger_entries"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "ledger_accounts"
  ADD CONSTRAINT "ledger_accounts_wallet_id_fkey"
    FOREIGN KEY ("wallet_id") REFERENCES "ledger_wallets"("wallet_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

DO $$
DECLARE
  legacy RECORD;
  target_state TEXT;
  balance_amount NUMERIC;
  activity_id TEXT;
  wallet_key TEXT;
  clearing_key TEXT;
  wallet_entry_id UUID;
  clearing_entry_id UUID;
  clearing_account RECORD;
  previous_balance NUMERIC;
  clearing_delta NUMERIC;
  clearing_balance NUMERIC;
BEGIN
  FOR legacy IN
    SELECT b."wallet_id", b."asset", b."confirmed_amount", b."provisional_amount",
           w."chain", w."network"
    FROM "ledger_legacy_balances" b
    JOIN "ledger_wallets" w ON w."wallet_id" = b."wallet_id"
    ORDER BY b."wallet_id", b."asset"
  LOOP
    FOREACH target_state IN ARRAY ARRAY['confirmed', 'provisional'] LOOP
      balance_amount := CASE target_state
        WHEN 'confirmed' THEN legacy."confirmed_amount"
        ELSE legacy."provisional_amount"
      END;
      IF balance_amount = 0 THEN
        CONTINUE;
      END IF;

      activity_id := 'legacy-opening:' || legacy."wallet_id"::text || ':' || md5(legacy."asset") || ':' || target_state;
      IF EXISTS (SELECT 1 FROM "ledger_activities" WHERE "identifier" = activity_id) THEN
        RAISE EXCEPTION 'Ledger upgrade stopped: reserved legacy opening identifier already exists';
      END IF;
      INSERT INTO "ledger_activities" (
        "identifier", "chain", "network", "transaction_hash", "state", "revision",
        "completed_at_ms", "source_status", "payload", "created_at", "updated_at", "finalized_at"
      ) VALUES (
        activity_id, legacy."chain", legacy."network", activity_id,
        CASE target_state WHEN 'confirmed' THEN 'finalized' ELSE 'observed' END,
        0, 0, 'success',
        jsonb_build_object('source', 'legacy-ledger-cutover', 'walletId', legacy."wallet_id",
                           'asset', legacy."asset", 'balanceState', target_state,
                           'amount', balance_amount::text),
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
        CASE target_state WHEN 'confirmed' THEN CURRENT_TIMESTAMP ELSE NULL END
      );

      wallet_key := 'wallet:' || legacy."wallet_id"::text || ':' || legacy."asset" || ':' || target_state;
      clearing_key := 'clearing:' || legacy."chain" || ':' || legacy."network" || ':' || legacy."asset" || ':' || target_state;
      wallet_entry_id := gen_random_uuid();
      INSERT INTO "ledger_accounts" (
        "account_key", "account_kind", "normal_side", "balance_state", "chain", "network", "asset", "wallet_id"
      ) VALUES (
        wallet_key, 'wallet', 'debit', target_state, legacy."chain", legacy."network", legacy."asset", legacy."wallet_id"
      );
      INSERT INTO "ledger_entries" (
        "id", "activity_identifier", "revision", "account_key", "sequence", "wallet_id", "asset",
        "account_kind", "side", "amount", "balance_after", "balance_state", "entry_kind"
      ) VALUES (
        wallet_entry_id, activity_id, 0, wallet_key, 1, legacy."wallet_id", legacy."asset", 'wallet',
        CASE WHEN balance_amount > 0 THEN 'debit' ELSE 'credit' END,
        abs(balance_amount), balance_amount, target_state, 'wallet'
      );
      UPDATE "ledger_accounts"
      SET "next_sequence" = 2, "last_entry_id" = wallet_entry_id
      WHERE "account_key" = wallet_key;

      INSERT INTO "ledger_accounts" (
        "account_key", "account_kind", "normal_side", "balance_state", "chain", "network", "asset", "wallet_id"
      ) VALUES (
        clearing_key, 'clearing', 'credit', target_state, legacy."chain", legacy."network", legacy."asset", NULL
      ) ON CONFLICT ("account_key") DO NOTHING;
      SELECT * INTO clearing_account
      FROM "ledger_accounts"
      WHERE "account_key" = clearing_key
      FOR UPDATE;
      previous_balance := 0;
      IF clearing_account."last_entry_id" IS NOT NULL THEN
        SELECT "balance_after" INTO previous_balance
        FROM "ledger_entries"
        WHERE "id" = clearing_account."last_entry_id";
      END IF;
      clearing_delta := balance_amount;
      clearing_balance := previous_balance + clearing_delta;
      clearing_entry_id := gen_random_uuid();
      INSERT INTO "ledger_entries" (
        "id", "activity_identifier", "revision", "account_key", "sequence", "wallet_id", "asset",
        "account_kind", "side", "amount", "balance_after", "balance_state", "entry_kind", "previous_entry_id"
      ) VALUES (
        clearing_entry_id, activity_id, 0, clearing_key, clearing_account."next_sequence", NULL,
        legacy."asset", 'clearing', CASE WHEN clearing_delta > 0 THEN 'credit' ELSE 'debit' END,
        abs(clearing_delta), clearing_balance, target_state, 'clearing', clearing_account."last_entry_id"
      );
      IF clearing_account."last_entry_id" IS NOT NULL THEN
        UPDATE "ledger_entries"
        SET "next_entry_id" = clearing_entry_id
        WHERE "id" = clearing_account."last_entry_id";
      END IF;
      UPDATE "ledger_accounts"
      SET "next_sequence" = clearing_account."next_sequence" + 1,
          "last_entry_id" = clearing_entry_id
      WHERE "account_key" = clearing_key;
    END LOOP;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM "ledger_legacy_balances" b
    JOIN LATERAL (VALUES
      ('confirmed', b."confirmed_amount"),
      ('provisional', b."provisional_amount")
    ) s("balance_state", "expected") ON true
    JOIN "ledger_wallets" w ON w."wallet_id" = b."wallet_id"
    LEFT JOIN "ledger_accounts" a
      ON a."account_key" = 'wallet:' || b."wallet_id"::text || ':' || b."asset" || ':' || s."balance_state"
    LEFT JOIN "ledger_entries" e ON e."id" = a."last_entry_id"
    WHERE coalesce(e."balance_after", 0) <> s."expected"
  ) THEN
    RAISE EXCEPTION 'Ledger upgrade stopped: journal opening balances do not reconcile to legacy projections';
  END IF;

  IF EXISTS (
    SELECT "activity_identifier", "asset", "balance_state"
    FROM "ledger_entries"
    GROUP BY "activity_identifier", "asset", "balance_state"
    HAVING coalesce(sum("amount") FILTER (WHERE "side" = 'debit'), 0)
      <> coalesce(sum("amount") FILTER (WHERE "side" = 'credit'), 0)
  ) THEN
    RAISE EXCEPTION 'Ledger upgrade stopped: opening journal is not balanced';
  END IF;
END $$;
