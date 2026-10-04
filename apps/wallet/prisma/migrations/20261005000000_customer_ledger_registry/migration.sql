ALTER TABLE exchange_customers
  ADD COLUMN ledger_status TEXT NOT NULL DEFAULT 'pending' CHECK (ledger_status IN ('pending', 'ready', 'rejected')),
  ADD COLUMN ledger_registry_revision INTEGER NOT NULL DEFAULT 0 CHECK (ledger_registry_revision >= 0);
