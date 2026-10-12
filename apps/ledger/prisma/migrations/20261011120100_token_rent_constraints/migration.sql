ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_normal_side_check;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_normal_side_check CHECK (
 (type IN ('custody_deposit','custody_hot','custody_management','custody_in_transit','custody_rent','fee_expense','deficit','reconciliation') AND normal_side='debit')
 OR (type IN ('customer_available','customer_reserved','customer_frozen','customer_pending','fee_revenue','equity') AND normal_side='credit')
);
ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_owner_check;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_owner_check CHECK (
 (type IN ('customer_available','customer_reserved','customer_frozen','customer_pending') AND owner_kind='customer')
 OR (type IN ('custody_deposit','custody_hot','custody_management','custody_rent') AND owner_kind='wallet')
 OR (type IN ('fee_expense','fee_revenue','equity') AND owner_kind='exchange')
 OR type IN ('custody_in_transit','deficit','reconciliation')
);
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_rent_asset_check CHECK (
 type <> 'custody_rent' OR (chain='solana' AND asset_id='token:solana:native')
);
