-- CreateTable
CREATE TABLE "exchange_wallet_registry" (
    "wallet_id" UUID NOT NULL,
    "domain_id" TEXT NOT NULL,
    "reset_epoch" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "account" INTEGER NOT NULL,
    "customer_id" UUID,
    "hot_wallet_id" UUID,
    "registry_revision" INTEGER NOT NULL,
    "request" JSONB NOT NULL,
    "ledger_status" TEXT NOT NULL DEFAULT 'pending',
    "listener_status" TEXT NOT NULL DEFAULT 'pending',
    "ledger_ack_revision" INTEGER NOT NULL DEFAULT 0,
    "listener_ack_revision" INTEGER NOT NULL DEFAULT 0,
    "ledger_reason" TEXT,
    "listener_reason" TEXT,
    "start_cursor" TEXT,
    "ready" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_wallet_registry_pkey" PRIMARY KEY ("wallet_id")
);

-- CreateTable
CREATE TABLE "exchange_event_receipts" (
    "event_id" UUID NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_event_receipts_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "exchange_operation_projections" (
    "operation_id" UUID NOT NULL,
    "domain_id" TEXT NOT NULL,
    "reset_epoch" TEXT NOT NULL,
    "customer_id" UUID,
    "request_digest" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "state" TEXT NOT NULL,
    "result_revision" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_operation_projections_pkey" PRIMARY KEY ("operation_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "exchange_wallet_registry_domain_id_chain_network_address_key" ON "exchange_wallet_registry"("domain_id", "chain", "network", "address");

