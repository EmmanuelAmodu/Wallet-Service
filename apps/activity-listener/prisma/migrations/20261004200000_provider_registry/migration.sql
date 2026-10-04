ALTER TABLE "exchange_wallet_registry"
  ADD COLUMN "readiness_revision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "provider_generation" UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN "provider_watch_id" TEXT,
  ADD COLUMN "provider_ack" JSONB,
  ADD COLUMN "provider_error" TEXT,
  ADD COLUMN "backfill_cursor" TEXT,
  ADD COLUMN "coverage_start_cursor" TEXT,
  ADD COLUMN "backfill_complete" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "provider_acknowledged_at" TIMESTAMPTZ,
  ADD COLUMN "last_backfill_at" TIMESTAMPTZ;
ALTER TABLE "exchange_wallet_registry"
  ADD CONSTRAINT "exchange_registry_readiness_revision_positive" CHECK (readiness_revision >= 0),
  ADD CONSTRAINT "exchange_registry_ready_has_coverage" CHECK (
    status <> 'ready' OR role <> 'customer_deposit' OR
    (provider_watch_id IS NOT NULL AND provider_ack IS NOT NULL AND start_cursor IS NOT NULL
      AND backfill_complete AND backfill_cursor IS NOT NULL)
  );
