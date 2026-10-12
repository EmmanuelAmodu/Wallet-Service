ALTER TABLE withdrawals DROP CONSTRAINT withdrawal_native_scope;
ALTER TABLE withdrawals ADD CONSTRAINT withdrawal_transfer_scope CHECK (
 (chain IN ('ethereum','bitcoin','solana') AND asset_id='token:'||chain||':native')
 OR (chain='ethereum' AND network='11155111' AND asset_id ~ '^token:ethereum:erc20:0x[0-9a-f]{40}$')
 OR (chain='solana' AND network='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' AND asset_id ~ '^token:solana:spl:TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA:[1-9A-HJ-NP-Za-km-z]{32,44}$')
);
DROP INDEX one_pending_token_fee_dependency;
CREATE UNIQUE INDEX one_pending_token_fee_dependency ON token_fee_reservations(domain_id,reset_epoch,source_wallet_id,chain,network) WHERE state IN ('reserved','uncertain');
