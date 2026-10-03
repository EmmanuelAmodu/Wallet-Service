-- CreateEnum
CREATE TYPE "WalletStatus" AS ENUM ('deriving', 'ready', 'rejected');

-- CreateEnum
CREATE TYPE "WalletTransactionStatus" AS ENUM ('preparing', 'signing', 'signed', 'queued', 'broadcasting', 'submitted', 'confirmed', 'failed', 'rejected', 'attention');

-- CreateTable
CREATE TABLE "wallets" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "seed_id" TEXT NOT NULL,
    "account" SERIAL NOT NULL,
    "path" TEXT NOT NULL,
    "address" TEXT,
    "status" "WalletStatus" NOT NULL DEFAULT 'deriving',
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "wallet_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "intent" JSONB NOT NULL,
    "prepared" JSONB,
    "signed" JSONB,
    "tx_hash" TEXT,
    "status" "WalletTransactionStatus" NOT NULL,
    "broadcast_attempts" INTEGER NOT NULL DEFAULT 0,
    "broadcast_generation" INTEGER NOT NULL DEFAULT 0,
    "broadcast_revision" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "inbox" (
    "id" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallets_tenant_id_external_id_chain_network_key" ON "wallets"("tenant_id", "external_id", "chain", "network");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_seed_id_chain_account_key" ON "wallets"("seed_id", "chain", "account");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_chain_network_address_key" ON "wallets"("chain", "network", "address");

-- CreateIndex
CREATE INDEX "transactions_tenant" ON "transactions"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_tenant_id_idempotency_key_key" ON "transactions"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "one_pending_per_wallet" ON "transactions"("wallet_id") WHERE ("status" IN ('preparing', 'signing', 'signed', 'queued', 'broadcasting', 'submitted', 'attention'));

-- CreateIndex
CREATE UNIQUE INDEX "outbox_dedupe_key_key" ON "outbox"("dedupe_key");

-- CreateIndex
CREATE INDEX "outbox_published_at_available_at_idx" ON "outbox"("published_at", "available_at");

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER SEQUENCE "wallets_account_seq"
    MINVALUE 0 MAXVALUE 2147483647 NO CYCLE RESTART WITH 0;

ALTER TABLE "wallets"
    ADD CONSTRAINT "wallets_account_check" CHECK ("account" >= 0);
