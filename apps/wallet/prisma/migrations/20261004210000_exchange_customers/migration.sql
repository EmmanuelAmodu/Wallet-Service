CREATE TABLE exchange_customers (
  customer_id UUID PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE CHECK (length(external_id) BETWEEN 1 AND 128),
  domain_id TEXT NOT NULL,
  reset_epoch TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'frozen')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE exchange_deposit_address_assignments (
  assignment_id UUID PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES exchange_customers(customer_id),
  domain_id TEXT NOT NULL,
  reset_epoch TEXT NOT NULL,
  chain TEXT NOT NULL,
  network TEXT NOT NULL,
  wallet_id UUID UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(customer_id, chain, network)
);
CREATE TABLE exchange_deposit_projections (
  deposit_id UUID PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES exchange_customers(customer_id),
  domain_id TEXT NOT NULL,
  reset_epoch TEXT NOT NULL,
  wallet_id UUID,
  chain TEXT NOT NULL,
  network TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  amount TEXT CHECK (amount ~ '^[1-9][0-9]{0,77}$' AND amount::numeric < 2::numeric ^ 256),
  transaction_hash TEXT,
  transfer_identity JSONB,
  identity_digest TEXT,
  discovery_revision INTEGER NOT NULL DEFAULT 0 CHECK (discovery_revision >= 0),
  discovery_state TEXT NOT NULL DEFAULT 'unknown' CHECK (discovery_state IN ('unknown', 'observed', 'finalized', 'reverted')),
  discovery_digest TEXT,
  accounting_revision INTEGER NOT NULL DEFAULT 0 CHECK (accounting_revision >= 0),
  accounting_state TEXT NOT NULL DEFAULT 'pending' CHECK (accounting_state IN ('pending', 'credited', 'reversed')),
  accounting_digest TEXT,
  ledger_batch_id UUID,
  deficit_incident_id UUID,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX exchange_deposit_projections_customer_id_deposit_id_idx ON exchange_deposit_projections(customer_id, deposit_id);
