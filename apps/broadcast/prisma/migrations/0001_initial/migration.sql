CREATE TABLE transactions (
 id uuid PRIMARY KEY, snapshot jsonb NOT NULL,
 status text NOT NULL CHECK (status IN ('queued','broadcasting','submitted','confirmed','failed','attention')),
 broadcast_generation integer NOT NULL, broadcast_attempts integer NOT NULL DEFAULT 0,
 revision integer NOT NULL DEFAULT 0, last_error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE outbox (
  id uuid PRIMARY KEY,
  queue text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_published_at_available_at_idx ON outbox(published_at,available_at);
CREATE TABLE inbox (id text PRIMARY KEY, processed_at timestamptz NOT NULL DEFAULT now());
