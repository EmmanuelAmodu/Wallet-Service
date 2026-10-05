CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "users_email_normalized" CHECK ("email" = lower(btrim("email")) AND length("email") BETWEEN 3 AND 254),
    CONSTRAINT "users_password_hash_format" CHECK ("password_hash" ~ '^scrypt\$131072\$8\$1\$[0-9a-f]{64}\$[0-9a-f]{128}$')
);

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

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

CREATE UNIQUE INDEX "outbox_dedupe_key_key" ON "outbox"("dedupe_key");
CREATE INDEX "outbox_published_at_available_at_idx" ON "outbox"("published_at", "available_at");
