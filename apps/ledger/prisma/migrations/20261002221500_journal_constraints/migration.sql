ALTER TABLE ledger_accounts
  ADD CONSTRAINT ledger_accounts_kind_check
    CHECK (account_kind IN ('wallet', 'clearing')),
  ADD CONSTRAINT ledger_accounts_normal_side_check
    CHECK (normal_side IN ('debit', 'credit')),
  ADD CONSTRAINT ledger_accounts_balance_state_check
    CHECK (balance_state IN ('provisional', 'confirmed')),
  ADD CONSTRAINT ledger_accounts_wallet_owner_check
    CHECK ((account_kind = 'wallet' AND wallet_id IS NOT NULL) OR
           (account_kind = 'clearing' AND wallet_id IS NULL)),
  ADD CONSTRAINT ledger_accounts_next_sequence_check CHECK (next_sequence > 0);

ALTER TABLE ledger_entries
  ADD CONSTRAINT ledger_entries_side_check CHECK (side IN ('debit', 'credit')),
  ADD CONSTRAINT ledger_entries_amount_check CHECK (amount > 0),
  ADD CONSTRAINT ledger_entries_sequence_check CHECK (sequence > 0),
  ADD CONSTRAINT ledger_entries_state_check CHECK (balance_state IN ('provisional', 'confirmed')),
  ADD CONSTRAINT ledger_entries_kind_check
    CHECK (entry_kind IN ('wallet', 'clearing', 'reversal')),
  ADD CONSTRAINT ledger_entries_account_kind_check
    CHECK ((account_kind = 'wallet' AND wallet_id IS NOT NULL) OR
           (account_kind = 'clearing' AND wallet_id IS NULL)),
  ADD CONSTRAINT ledger_entries_reversal_check
    CHECK ((entry_kind = 'reversal' AND reversal_of_id IS NOT NULL) OR
           (entry_kind <> 'reversal' AND reversal_of_id IS NULL)),
  ADD CONSTRAINT ledger_entries_wallet_clearing_check
    CHECK ((entry_kind = 'wallet' AND account_kind = 'wallet') OR
           (entry_kind = 'clearing' AND account_kind = 'clearing') OR
           entry_kind = 'reversal');

ALTER TABLE ledger_accounts
  ADD CONSTRAINT ledger_accounts_last_entry_fkey
  FOREIGN KEY (last_entry_id) REFERENCES ledger_entries(id)
  ON DELETE NO ACTION ON UPDATE NO ACTION;
