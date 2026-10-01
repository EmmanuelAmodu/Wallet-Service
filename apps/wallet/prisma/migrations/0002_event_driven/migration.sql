ALTER TABLE wallets ALTER COLUMN address DROP NOT NULL;
ALTER TABLE wallets ADD COLUMN status text NOT NULL DEFAULT 'ready';
ALTER TABLE wallets ALTER COLUMN status SET DEFAULT 'deriving';
ALTER TABLE wallets ADD COLUMN last_error text;
ALTER TABLE wallets ADD CONSTRAINT wallets_status_check CHECK (status IN ('deriving','ready','rejected'));
ALTER TABLE transactions ALTER COLUMN prepared DROP NOT NULL;
ALTER TABLE transactions ALTER COLUMN signed DROP NOT NULL;
ALTER TABLE transactions ALTER COLUMN tx_hash DROP NOT NULL;
ALTER TABLE transactions ADD COLUMN broadcast_generation integer NOT NULL DEFAULT 0;
ALTER TABLE transactions DROP CONSTRAINT transactions_status_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_status_check CHECK
  (status IN ('preparing','signing','signed','queued','broadcasting','submitted','confirmed','failed','rejected','attention'));
DROP INDEX one_pending_per_wallet;
CREATE UNIQUE INDEX one_pending_per_wallet ON transactions(wallet_id)
  WHERE status IN ('preparing','signing','signed','queued','broadcasting','submitted','attention');
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
