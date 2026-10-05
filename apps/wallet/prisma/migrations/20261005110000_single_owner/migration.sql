-- Keep historical migrations intact. Refuse conflicting legacy external identities rather than merge owners.
CREATE UNIQUE INDEX "wallets_external_id_chain_network_key" ON "wallets"("external_id", "chain", "network");
CREATE UNIQUE INDEX "transactions_wallet_id_idempotency_key_key" ON "transactions"("wallet_id", "idempotency_key");
CREATE INDEX "transactions_created_at" ON "transactions"("created_at");
DROP INDEX "wallets_tenant_id_external_id_chain_network_key";
DROP INDEX "transactions_tenant_id_idempotency_key_key";
DROP INDEX "transactions_tenant";
ALTER TABLE "wallets" DROP COLUMN "tenant_id";
ALTER TABLE "transactions" DROP COLUMN "tenant_id";
