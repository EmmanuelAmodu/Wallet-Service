-- CreateEnum
CREATE TYPE "BroadcastTransactionStatus" AS ENUM ('queued', 'broadcasting', 'submitted', 'confirmed', 'failed', 'attention');

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL,
    "snapshot" JSONB NOT NULL,
    "status" "BroadcastTransactionStatus" NOT NULL,
    "broadcast_generation" INTEGER NOT NULL,
    "broadcast_attempts" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 0,
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
CREATE UNIQUE INDEX "outbox_dedupe_key_key" ON "outbox"("dedupe_key");

-- CreateIndex
CREATE INDEX "outbox_published_at_available_at_idx" ON "outbox"("published_at", "available_at");
