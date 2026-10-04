CREATE TABLE exchange_discoveries (
  id TEXT PRIMARY KEY, reset_epoch TEXT NOT NULL, chain TEXT NOT NULL, network TEXT NOT NULL,
  transaction_hash TEXT NOT NULL, payload_hash TEXT NOT NULL, signal JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', check_revision INTEGER NOT NULL DEFAULT 0,
  block_hash TEXT, block_height TEXT, next_check_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT exchange_discovery_revision CHECK (check_revision >= 0)
);
CREATE INDEX exchange_discoveries_due ON exchange_discoveries(reset_epoch, next_check_at);
CREATE TABLE exchange_transfers (
  id UUID PRIMARY KEY, domain_id TEXT NOT NULL, reset_epoch TEXT NOT NULL, customer_id UUID NOT NULL,
  wallet_id UUID NOT NULL, chain TEXT NOT NULL, network TEXT NOT NULL, asset_id TEXT NOT NULL,
  transaction_hash TEXT NOT NULL, transfer_key TEXT NOT NULL, identity JSONB NOT NULL,
  from_address TEXT, to_address TEXT NOT NULL, amount TEXT NOT NULL, state TEXT NOT NULL,
  revision INTEGER NOT NULL, block_hash TEXT, block_height TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT exchange_transfer_amount CHECK (amount ~ '^[1-9][0-9]{0,77}$' AND amount::numeric < power(2::numeric,256)),
  CONSTRAINT exchange_transfer_revision CHECK (revision > 0),
  CONSTRAINT exchange_transfer_state CHECK (state IN ('pending','finalized','reverted')),
  CONSTRAINT exchange_transfer_wallet FOREIGN KEY (wallet_id) REFERENCES exchange_wallet_registry(wallet_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  UNIQUE(domain_id, chain, network, asset_id, transaction_hash, transfer_key)
);
CREATE INDEX exchange_transfers_transaction ON exchange_transfers(chain,network,transaction_hash);
CREATE TABLE exchange_observed_operations (
  operation_id UUID PRIMARY KEY, domain_id TEXT NOT NULL, reset_epoch TEXT NOT NULL,
  attempt_id UUID NOT NULL, request_digest TEXT NOT NULL, kind TEXT NOT NULL, intent JSONB NOT NULL,
  revision INTEGER NOT NULL, attempt_revision INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'preparing', transaction_hash TEXT,
  CONSTRAINT exchange_observed_operation_revision CHECK (revision > 0 AND attempt_revision >= 0),
  UNIQUE(domain_id,attempt_id)
);
CREATE INDEX exchange_observed_operations_transaction ON exchange_observed_operations(domain_id,transaction_hash);
CREATE TABLE exchange_custody_incidents (
  id UUID PRIMARY KEY, incident_key TEXT UNIQUE NOT NULL, domain_id TEXT NOT NULL,
  reset_epoch TEXT NOT NULL, customer_id UUID, wallet_id UUID NOT NULL, chain TEXT NOT NULL,
  network TEXT NOT NULL, transaction_hash TEXT NOT NULL, category TEXT NOT NULL, reason TEXT NOT NULL,
  evidence JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT exchange_custody_incident_wallet FOREIGN KEY (wallet_id) REFERENCES exchange_wallet_registry(wallet_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
