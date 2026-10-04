CREATE TABLE exchange_provider_watch_leases (
  generation UUID PRIMARY KEY,
  wallet_id UUID NOT NULL,
  domain_id TEXT NOT NULL,
  reset_epoch TEXT NOT NULL,
  provider TEXT NOT NULL,
  chain TEXT NOT NULL,
  network TEXT NOT NULL,
  install_request JSONB NOT NULL,
  watch_id TEXT,
  acknowledgment JSONB,
  state TEXT NOT NULL DEFAULT 'installing',
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT exchange_provider_watch_lease_state CHECK (state IN ('installing', 'active', 'cleanup', 'removed'))
);
CREATE INDEX exchange_provider_watch_leases_reset_epoch_state_updated_at_idx
  ON exchange_provider_watch_leases(reset_epoch, state, updated_at);
