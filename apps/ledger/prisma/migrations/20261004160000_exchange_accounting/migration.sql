-- CreateEnum
CREATE TYPE "LedgerAccountType" AS ENUM ('custody_deposit', 'custody_hot', 'custody_management', 'custody_in_transit', 'customer_available', 'customer_reserved', 'customer_frozen', 'customer_pending', 'fee_expense', 'fee_revenue', 'equity', 'deficit', 'reconciliation');

-- CreateEnum
CREATE TYPE "LedgerAccountOwnerKind" AS ENUM ('customer', 'wallet', 'exchange');

-- CreateEnum
CREATE TYPE "ExchangeWalletRole" AS ENUM ('customer', 'hot', 'management');

-- CreateEnum
CREATE TYPE "ExchangeCustomerState" AS ENUM ('active', 'frozen');

-- CreateEnum
CREATE TYPE "DepositState" AS ENUM ('pending', 'finalized', 'reverted');

-- CreateEnum
CREATE TYPE "WithdrawalReservationState" AS ENUM ('held', 'rejected', 'released', 'settled', 'frozen');

-- CreateEnum
CREATE TYPE "ExchangeOperationKind" AS ENUM ('sweep', 'funding', 'withdrawal');

-- AlterTable
ALTER TABLE "ledger_entries" ADD COLUMN     "account_id" UUID,
ADD COLUMN     "batch_id" UUID,
ALTER COLUMN "activity_identifier" DROP NOT NULL,
ALTER COLUMN "account_kind" DROP NOT NULL,
ALTER COLUMN "balance_state" DROP NOT NULL,
ALTER COLUMN "entry_kind" DROP NOT NULL;

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" UUID NOT NULL,
    "account_key" TEXT NOT NULL,
    "domain_id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "type" "LedgerAccountType" NOT NULL,
    "owner_kind" "LedgerAccountOwnerKind" NOT NULL,
    "owner_id" TEXT NOT NULL,
    "normal_side" "LedgerEntrySide" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_batches" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "domain_id" TEXT NOT NULL,
    "operation_id" UUID,
    "revision" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "request_digest" TEXT NOT NULL,
    "reversal_of_batch_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_wallets" (
    "wallet_id" UUID NOT NULL,
    "domain_id" TEXT NOT NULL,
    "customer_id" UUID,
    "chain" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "address_key" TEXT NOT NULL,
    "hot_wallet_id" UUID,
    "role" "ExchangeWalletRole" NOT NULL,
    "account" INTEGER NOT NULL,
    "registry_revision" INTEGER NOT NULL,
    "reset_epoch" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "exchange_wallets_pkey" PRIMARY KEY ("wallet_id")
);

-- CreateTable
CREATE TABLE "exchange_customers" (
    "customer_id" UUID NOT NULL,
    "domain_id" TEXT NOT NULL,
    "state" "ExchangeCustomerState" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "exchange_customers_pkey" PRIMARY KEY ("customer_id")
);

-- CreateTable
CREATE TABLE "deposits" (
    "id" UUID NOT NULL,
    "domain_id" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "wallet_id" UUID,
    "chain" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "transfer_id" TEXT NOT NULL,
    "transfer_identity" JSONB NOT NULL,
    "transaction_hash" TEXT NOT NULL,
    "amount" DECIMAL(96,18),
    "revision" INTEGER NOT NULL,
    "state" "DepositState" NOT NULL,
    "identity_digest" TEXT,
    "pending_batch_id" UUID,
    "credit_batch_id" UUID,
    "reversal_batch_id" UUID,
    "block_hash" TEXT,
    "payload" JSONB NOT NULL,
    "reset_epoch" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "deposits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawal_reservations" (
    "id" UUID NOT NULL,
    "operation_id" UUID NOT NULL,
    "domain_id" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "request_digest" TEXT NOT NULL,
    "policy_version" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "state" "WithdrawalReservationState" NOT NULL,
    "amounts" JSONB NOT NULL,
    "request" JSONB NOT NULL,
    "reserve_batch_id" UUID,
    "release_batch_id" UUID,
    "reset_epoch" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "withdrawal_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_operations" (
    "id" UUID NOT NULL,
    "domain_id" TEXT NOT NULL,
    "customer_id" UUID,
    "reservation_id" UUID,
    "request_digest" TEXT NOT NULL,
    "kind" "ExchangeOperationKind" NOT NULL,
    "payload" JSONB NOT NULL,
    "attempt_id" UUID,
    "attempt_revision" INTEGER NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL,
    "settlement_revision" INTEGER NOT NULL DEFAULT 0,
    "settlement_batch_id" UUID,
    "settlement_payload" JSONB,
    "settlement_identity" TEXT,
    "settlement_digest" TEXT,
    "settlement_outcome" TEXT,
    "reset_epoch" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "exchange_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_incidents" (
    "id" UUID NOT NULL,
    "domain_id" TEXT NOT NULL,
    "customer_id" UUID,
    "operation_id" UUID,
    "deposit_id" UUID,
    "reason" TEXT NOT NULL,
    "amount" JSONB,
    "state" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ledger_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox" (
    "id" UUID NOT NULL,
    "queue" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "available_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_inbox" (
    "event_id" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "reset_epoch" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_inbox_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_account_key_key" ON "ledger_accounts"("account_key");

-- CreateIndex
CREATE INDEX "ledger_accounts_domain_id_owner_kind_owner_id_idx" ON "ledger_accounts"("domain_id", "owner_kind", "owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_domain_id_chain_network_asset_id_type_owner_key" ON "ledger_accounts"("domain_id", "chain", "network", "asset_id", "type", "owner_kind", "owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "journal_batches_key_key" ON "journal_batches"("key");

-- CreateIndex
CREATE INDEX "journal_batches_domain_id_operation_id_revision_idx" ON "journal_batches"("domain_id", "operation_id", "revision");

-- CreateIndex
CREATE INDEX "exchange_wallets_domain_id_customer_id_idx" ON "exchange_wallets"("domain_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_wallets_domain_id_chain_network_address_key_key" ON "exchange_wallets"("domain_id", "chain", "network", "address_key");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_wallets_domain_id_chain_network_account_key" ON "exchange_wallets"("domain_id", "chain", "network", "account");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_customers_domain_id_customer_id_key" ON "exchange_customers"("domain_id", "customer_id");

-- CreateIndex
CREATE INDEX "deposits_domain_id_customer_id_state_idx" ON "deposits"("domain_id", "customer_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "deposits_domain_id_chain_network_asset_id_transfer_id_key" ON "deposits"("domain_id", "chain", "network", "asset_id", "transfer_id");

-- CreateIndex
CREATE UNIQUE INDEX "withdrawal_reservations_operation_id_key" ON "withdrawal_reservations"("operation_id");

-- CreateIndex
CREATE INDEX "withdrawal_reservations_domain_id_customer_id_state_idx" ON "withdrawal_reservations"("domain_id", "customer_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_operations_settlement_identity_key" ON "exchange_operations"("settlement_identity");

-- CreateIndex
CREATE INDEX "exchange_operations_domain_id_customer_id_state_idx" ON "exchange_operations"("domain_id", "customer_id", "state");

-- CreateIndex
CREATE INDEX "ledger_incidents_domain_id_state_idx" ON "ledger_incidents"("domain_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_dedupe_key_key" ON "outbox"("dedupe_key");

-- CreateIndex
CREATE INDEX "outbox_published_at_available_at_idx" ON "outbox"("published_at", "available_at");

-- CreateIndex
CREATE INDEX "ledger_entries_account_id_sequence_idx" ON "ledger_entries"("account_id", "sequence" DESC);

-- CreateIndex
CREATE INDEX "ledger_entries_batch_id_idx" ON "ledger_entries"("batch_id");

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "journal_batches"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "journal_batches" ADD CONSTRAINT "journal_batches_reversal_of_batch_id_fkey" FOREIGN KEY ("reversal_of_batch_id") REFERENCES "journal_batches"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Legacy entries keep their original constraints. New exchange entries must have
-- an account and journal batch, and cannot masquerade as legacy activity rows.
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_exchange_shape_check CHECK (
    (activity_identifier IS NOT NULL AND account_id IS NULL AND batch_id IS NULL
       AND account_kind IS NOT NULL AND balance_state IS NOT NULL AND entry_kind IS NOT NULL)
 OR (activity_identifier IS NULL AND account_id IS NOT NULL AND batch_id IS NOT NULL
       AND account_kind IS NULL AND balance_state IS NULL AND entry_kind IS NULL
       AND wallet_id IS NULL AND reversal_of_id IS NULL)
);
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_exchange_units_check CHECK (
    account_id IS NULL OR (
      amount = trunc(amount)
      AND amount <= 115792089237316195423570985008687907853269984665640564039457584007913129639935
      AND balance_after = trunc(balance_after)
      AND abs(balance_after) <= 115792089237316195423570985008687907853269984665640564039457584007913129639935
    )
);

ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_normal_side_check CHECK (
  (type IN ('custody_deposit', 'custody_hot', 'custody_management', 'custody_in_transit',
            'fee_expense', 'deficit', 'reconciliation') AND normal_side = 'debit')
  OR (type IN ('customer_available', 'customer_reserved', 'customer_frozen', 'customer_pending',
              'fee_revenue', 'equity') AND normal_side = 'credit')
);
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_owner_check CHECK (
  (type IN ('customer_available', 'customer_reserved', 'customer_frozen', 'customer_pending')
     AND owner_kind = 'customer')
  OR (type IN ('custody_deposit', 'custody_hot', 'custody_management') AND owner_kind = 'wallet')
  OR (type IN ('fee_expense', 'fee_revenue', 'equity') AND owner_kind = 'exchange')
  OR type IN ('custody_in_transit', 'deficit', 'reconciliation')
);
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_identity_check CHECK (
  length(domain_id) BETWEEN 1 AND 128 AND length(network) BETWEEN 1 AND 128
  AND length(owner_id) BETWEEN 1 AND 256
  AND account_key ~ '^exchange:[a-f0-9]{64}$'
  AND asset_id LIKE 'token:' || chain || ':%'
);
ALTER TABLE journal_batches ADD COLUMN created_transaction BIGINT NOT NULL DEFAULT txid_current();
ALTER TABLE journal_batches ADD CONSTRAINT journal_batches_revision_check CHECK (revision >= 0);
ALTER TABLE journal_batches ADD CONSTRAINT journal_batches_digest_check
  CHECK (request_digest ~ '^[a-f0-9]{64}$');
ALTER TABLE journal_batches ADD CONSTRAINT journal_batches_key_check
  CHECK (length(key) BETWEEN 1 AND 512 AND length(kind) BETWEEN 1 AND 64);

ALTER TABLE exchange_wallets ADD CONSTRAINT exchange_wallets_role_check CHECK (
  (role = 'customer' AND account >= 10 AND customer_id IS NOT NULL AND hot_wallet_id IS NOT NULL)
  OR (role = 'hot' AND account = 0 AND customer_id IS NULL AND hot_wallet_id IS NULL)
  OR (role = 'management' AND account BETWEEN 1 AND 9
      AND customer_id IS NULL AND hot_wallet_id IS NULL)
);
ALTER TABLE exchange_wallets ADD CONSTRAINT exchange_wallets_account_check
  CHECK (account BETWEEN 0 AND 2147483647);
ALTER TABLE exchange_wallets ADD CONSTRAINT exchange_wallets_revision_check
  CHECK (registry_revision > 0);
CREATE UNIQUE INDEX exchange_wallets_one_hot ON exchange_wallets(domain_id, chain, network)
  WHERE role = 'hot';
ALTER TABLE deposits ADD CONSTRAINT deposits_amount_check CHECK (
  amount IS NULL OR (amount > 0 AND amount = trunc(amount)
    AND amount <= 115792089237316195423570985008687907853269984665640564039457584007913129639935)
);
ALTER TABLE deposits ADD CONSTRAINT deposits_identity_check CHECK (
  revision > 0 AND (state = 'reverted' OR (wallet_id IS NOT NULL AND amount IS NOT NULL))
);
ALTER TABLE withdrawal_reservations ADD CONSTRAINT withdrawal_reservations_revision_check
  CHECK (revision > 0);

-- Chart-of-accounts metadata and completed journal content have no update/delete path.
-- Legacy journal cleanup remains possible so the existing legacy application is unchanged.
CREATE FUNCTION reject_exchange_journal_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Exchange journal and account metadata are append-only';
END;
$$;
CREATE TRIGGER ledger_accounts_immutable BEFORE UPDATE OR DELETE ON ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION reject_exchange_journal_mutation();
CREATE TRIGGER journal_batches_immutable BEFORE UPDATE OR DELETE ON journal_batches
  FOR EACH ROW EXECUTE FUNCTION reject_exchange_journal_mutation();

CREATE FUNCTION protect_exchange_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.account_id IS NOT NULL OR OLD.batch_id IS NOT NULL THEN
    RAISE EXCEPTION 'Exchange journal entries are append-only';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW.account_id IS NOT NULL OR NEW.batch_id IS NOT NULL THEN
    RAISE EXCEPTION 'Legacy entries cannot be converted into exchange journal entries';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_entries_exchange_immutable BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION protect_exchange_entry();

CREATE FUNCTION verify_exchange_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  account ledger_accounts%ROWTYPE;
  batch journal_batches%ROWTYPE;
  previous ledger_entries%ROWTYPE;
  delta NUMERIC;
BEGIN
  IF NEW.account_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO STRICT account FROM ledger_accounts WHERE id = NEW.account_id;
  SELECT * INTO STRICT batch FROM journal_batches WHERE id = NEW.batch_id;
  PERFORM pg_advisory_xact_lock(hashtextextended('exchange-domain:' || account.domain_id, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('ledger-account-' || account.account_key, 0));
  IF batch.domain_id <> account.domain_id OR batch.revision <> NEW.revision
    OR NEW.account_key <> account.account_key OR NEW.asset <> account.asset_id THEN
    RAISE EXCEPTION 'Journal entry identity does not match its account and batch';
  END IF;
  IF batch.created_transaction <> txid_current() THEN
    RAISE EXCEPTION 'A completed journal batch cannot accept more entries';
  END IF;
  SELECT * INTO previous FROM ledger_entries
    WHERE account_id = NEW.account_id ORDER BY sequence DESC LIMIT 1;
  delta := CASE WHEN NEW.side = account.normal_side THEN NEW.amount ELSE -NEW.amount END;
  IF NEW.sequence <> COALESCE(previous.sequence, 0) + 1
    OR NEW.previous_entry_id IS DISTINCT FROM previous.id
    OR NEW.balance_after <> COALESCE(previous.balance_after, 0) + delta THEN
    RAISE EXCEPTION 'Journal entry does not extend its account tail';
  END IF;
  IF account.type IN ('customer_available', 'customer_reserved', 'customer_frozen', 'customer_pending')
    AND NEW.balance_after < 0 THEN
    RAISE EXCEPTION 'Customer liability balances cannot be negative';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_entries_exchange_verify BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION verify_exchange_entry();

-- The check is deferred so a batch and all its legs commit atomically. Both empty
-- batches and debit/credit legs that balance only after mixing assets are rejected.
CREATE FUNCTION verify_exchange_batch_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target UUID;
BEGIN
  IF TG_TABLE_NAME = 'journal_batches' THEN target := NEW.id;
  ELSE target := NEW.batch_id; END IF;
  IF target IS NULL THEN RETURN NULL; END IF;
  IF (SELECT count(*) FROM ledger_entries WHERE batch_id = target) < 2 THEN
    RAISE EXCEPTION 'A journal batch requires at least two entries';
  END IF;
  IF EXISTS (
    SELECT 1 FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
    WHERE e.batch_id = target
    GROUP BY a.chain, a.network, a.asset_id
    HAVING SUM(CASE WHEN e.side = 'debit' THEN e.amount ELSE -e.amount END) <> 0
  ) THEN
    RAISE EXCEPTION 'Journal postings do not balance separately for each asset';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER journal_batches_balanced AFTER INSERT ON journal_batches
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_exchange_batch_balance();
CREATE CONSTRAINT TRIGGER ledger_entries_exchange_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_exchange_batch_balance();
