CREATE SEQUENCE wallet_account_seq MINVALUE 0 START 0 MAXVALUE 2147483647 NO CYCLE;
CREATE TABLE wallets (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  external_id text NOT NULL,
  chain text NOT NULL CHECK (chain IN ('ethereum','bitcoin','solana')),
  network text NOT NULL,
  seed_id text NOT NULL,
  account integer NOT NULL CHECK (account >= 0),
  path text NOT NULL,
  address text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_id, chain, network),
  UNIQUE (seed_id, chain, account),
  UNIQUE (chain, network, address)
);
CREATE TABLE transactions (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  wallet_id uuid NOT NULL REFERENCES wallets(id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  intent jsonb NOT NULL,
  prepared jsonb NOT NULL,
  signed jsonb NOT NULL,
  tx_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('signed','broadcasting','submitted','confirmed','failed')),
  broadcast_attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);
-- Conservative reservation: held through uncertain broadcast results and until finality.
CREATE UNIQUE INDEX one_pending_per_wallet ON transactions(wallet_id)
  WHERE status IN ('signed','broadcasting','submitted');
CREATE INDEX transactions_tenant ON transactions(tenant_id,created_at);
