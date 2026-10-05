-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "sweep_wallet_registry" (
    "wallet_id" UUID NOT NULL,
    "domain_id" TEXT NOT NULL,
    "reset_epoch" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "address_key" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "account" INTEGER NOT NULL,
    "customer_id" UUID,
    "hot_wallet_id" UUID,
    "registry_revision" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sweep_wallet_registry_pkey" PRIMARY KEY ("wallet_id")
);

-- CreateTable
CREATE TABLE "sweep_customers" (
    "customer_id" UUID NOT NULL,
    "domain_id" TEXT NOT NULL,
    "reset_epoch" TEXT NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "pause_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sweep_customers_pkey" PRIMARY KEY ("customer_id")
);

-- CreateTable
CREATE TABLE "sweep_deposits" (
    "deposit_id" UUID NOT NULL,
    "domain_id" TEXT NOT NULL,
    "reset_epoch" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "wallet_id" UUID,
    "chain" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "revision_digest" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sweep_deposits_pkey" PRIMARY KEY ("deposit_id")
);

-- CreateTable
CREATE TABLE "sweep_work" (
    "id" UUID NOT NULL,
    "domain_id" TEXT NOT NULL,
    "reset_epoch" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "source_wallet_id" UUID NOT NULL,
    "hot_wallet_id" UUID,
    "chain" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "observed_credit_units" TEXT NOT NULL,
    "credited_deposit_count" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sweep_work_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbox" (
    "id" TEXT NOT NULL,
    "domain_id" TEXT NOT NULL,
    "reset_epoch" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "sweep_domain_gates" (
    "domain_id" TEXT NOT NULL,
    "reset_epoch" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sweep_domain_gates_pkey" PRIMARY KEY ("domain_id","reset_epoch")
);

-- CreateIndex
CREATE INDEX "sweep_wallet_registry_domain_id_reset_epoch_customer_id_idx" ON "sweep_wallet_registry"("domain_id", "reset_epoch", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "sweep_wallet_registry_domain_id_reset_epoch_chain_network_a_key" ON "sweep_wallet_registry"("domain_id", "reset_epoch", "chain", "network", "address_key");

-- CreateIndex
CREATE INDEX "sweep_deposits_domain_id_reset_epoch_wallet_id_chain_networ_idx" ON "sweep_deposits"("domain_id", "reset_epoch", "wallet_id", "chain", "network", "asset_id", "state");

-- CreateIndex
CREATE INDEX "sweep_work_domain_id_reset_epoch_state_idx" ON "sweep_work"("domain_id", "reset_epoch", "state");

-- CreateIndex
CREATE UNIQUE INDEX "sweep_work_domain_id_reset_epoch_source_wallet_id_chain_net_key" ON "sweep_work"("domain_id", "reset_epoch", "source_wallet_id", "chain", "network", "asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_dedupe_key_key" ON "outbox"("dedupe_key");

-- CreateIndex
CREATE INDEX "outbox_published_at_available_at_idx" ON "outbox"("published_at", "available_at");

-- Defense in depth for role and projection values; these rows never grant chain execution authority.
ALTER TABLE "sweep_wallet_registry" ADD CONSTRAINT "sweep_registry_role_account"
CHECK ((role = 'customer' AND account >= 10 AND customer_id IS NOT NULL AND hot_wallet_id IS NOT NULL)
    OR (role = 'hot' AND account = 0 AND customer_id IS NULL AND hot_wallet_id IS NULL)
    OR (role = 'management' AND account BETWEEN 1 AND 9 AND customer_id IS NULL AND hot_wallet_id IS NULL));
ALTER TABLE "sweep_wallet_registry" ADD CONSTRAINT "sweep_registry_revision_positive" CHECK (registry_revision > 0);
ALTER TABLE "sweep_deposits" ADD CONSTRAINT "sweep_deposit_amount_positive"
CHECK (amount ~ '^[1-9][0-9]{0,77}$' AND amount::numeric < power(2::numeric, 256));
ALTER TABLE "sweep_deposits" ADD CONSTRAINT "sweep_deposit_state_revision"
CHECK (state IN ('credited', 'reversed') AND revision > 0);
ALTER TABLE "sweep_work" ADD CONSTRAINT "sweep_work_credit_units_nonnegative"
CHECK (observed_credit_units ~ '^(0|[1-9][0-9]*)$' AND credited_deposit_count >= 0 AND revision > 0);
