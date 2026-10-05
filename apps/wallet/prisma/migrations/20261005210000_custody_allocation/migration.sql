-- CreateEnum
CREATE TYPE "WalletCustodyRole" AS ENUM ('legacy', 'hot', 'management', 'customer_deposit');

-- AlterTable
ALTER TABLE "wallets" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "configuration_revision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "custody_domain_id" TEXT,
ADD COLUMN     "custody_role" "WalletCustodyRole" NOT NULL DEFAULT 'legacy',
ADD COLUMN     "customer_id" UUID,
ADD COLUMN     "derivation_request_digest" TEXT,
ADD COLUMN     "derivation_request_id" UUID,
ADD COLUMN     "hot_wallet_id" UUID,
ADD COLUMN     "management_purpose" TEXT,
ADD COLUMN     "published_at" TIMESTAMPTZ,
ADD COLUMN     "registry_revision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reset_epoch" TEXT;

-- CreateTable
CREATE TABLE "custody_domains" (
    "id" TEXT NOT NULL,
    "seed_id" TEXT NOT NULL,
    "reset_epoch" TEXT NOT NULL,
    "policy_version" TEXT NOT NULL,
    "configuration_revision" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custody_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custody_networks" (
    "domain_id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "native_asset_id" TEXT NOT NULL,
    "configuration_revision" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custody_networks_pkey" PRIMARY KEY ("domain_id","chain","network")
);

-- CreateTable
CREATE TABLE "management_wallet_purposes" (
    "domain_id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "account" INTEGER NOT NULL,
    "purpose" TEXT NOT NULL,
    "permitted_actions" JSONB NOT NULL,
    "maximum_operation_units" TEXT NOT NULL,
    "maximum_customer_24h_units" TEXT NOT NULL,
    "maximum_domain_24h_units" TEXT NOT NULL,
    "policy_version" TEXT NOT NULL,
    "configuration_revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "management_wallet_purposes_pkey" PRIMARY KEY ("domain_id","chain","network","account")
);

-- CreateTable
CREATE TABLE "asset_configurations" (
    "domain_id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "standard" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contract_address" TEXT,
    "token_program" TEXT,
    "mint" TEXT,
    "observation_enabled" BOOLEAN NOT NULL DEFAULT false,
    "credit_enabled" BOOLEAN NOT NULL DEFAULT false,
    "sweep_enabled" BOOLEAN NOT NULL DEFAULT false,
    "withdrawal_enabled" BOOLEAN NOT NULL DEFAULT false,
    "minimum_credit_units" TEXT NOT NULL,
    "minimum_sweep_units" TEXT NOT NULL,
    "maximum_fee_units" TEXT NOT NULL,
    "policy_version" TEXT NOT NULL,
    "configuration_revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_configurations_pkey" PRIMARY KEY ("domain_id","chain","network","asset_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "custody_domains_id_reset_epoch_seed_id_key" ON "custody_domains"("id", "reset_epoch", "seed_id");

-- CreateIndex
CREATE UNIQUE INDEX "custody_networks_domain_id_chain_key" ON "custody_networks"("domain_id", "chain");

-- CreateIndex
CREATE UNIQUE INDEX "management_wallet_purposes_domain_id_chain_network_account__key" ON "management_wallet_purposes"("domain_id", "chain", "network", "account", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_derivation_request_id_key" ON "wallets"("derivation_request_id");

-- CreateIndex
CREATE INDEX "wallets_custody_domain_id_custody_role_active_idx" ON "wallets"("custody_domain_id", "custody_role", "active");

-- CreateIndex
CREATE UNIQUE INDEX "one_active_hot_per_custody_network" ON "wallets"("custody_domain_id", "chain", "network") WHERE ("custody_role" = 'hot' AND "active");

-- CreateIndex
CREATE UNIQUE INDEX "one_active_customer_deposit_wallet" ON "wallets"("custody_domain_id", "customer_id", "chain", "network") WHERE ("custody_role" = 'customer_deposit' AND "active");

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_custody_domain_id_reset_epoch_seed_id_fkey" FOREIGN KEY ("custody_domain_id", "reset_epoch", "seed_id") REFERENCES "custody_domains"("id", "reset_epoch", "seed_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_custody_domain_id_chain_network_fkey" FOREIGN KEY ("custody_domain_id", "chain", "network") REFERENCES "custody_networks"("domain_id", "chain", "network") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- CreateIndex
CREATE UNIQUE INDEX "exchange_customers_customer_id_domain_id_reset_epoch_key" ON "exchange_customers"("customer_id", "domain_id", "reset_epoch");

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_customer_id_custody_domain_id_reset_epoch_fkey" FOREIGN KEY ("customer_id", "custody_domain_id", "reset_epoch") REFERENCES "exchange_customers"("customer_id", "domain_id", "reset_epoch") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_hot_wallet_id_fkey" FOREIGN KEY ("hot_wallet_id") REFERENCES "wallets"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_custody_domain_id_chain_network_account_management_fkey" FOREIGN KEY ("custody_domain_id", "chain", "network", "account", "management_purpose") REFERENCES "management_wallet_purposes"("domain_id", "chain", "network", "account", "purpose") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "custody_networks" ADD CONSTRAINT "custody_networks_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "custody_domains"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "management_wallet_purposes" ADD CONSTRAINT "management_wallet_purposes_domain_id_chain_network_fkey" FOREIGN KEY ("domain_id", "chain", "network") REFERENCES "custody_networks"("domain_id", "chain", "network") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "asset_configurations" ADD CONSTRAINT "asset_configurations_domain_id_chain_network_fkey" FOREIGN KEY ("domain_id", "chain", "network") REFERENCES "custody_networks"("domain_id", "chain", "network") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Move only the customer allocator forward. Reserved inserts never consume it.
DO $$
DECLARE position BIGINT;
BEGIN
  SELECT last_value INTO position FROM wallets_account_seq;
  IF position < 10 THEN
    PERFORM setval('wallets_account_seq', 10, false);
  END IF;
END $$;
ALTER SEQUENCE wallets_account_seq MINVALUE 10 MAXVALUE 2147483647 START WITH 10 NO CYCLE;

ALTER TABLE custody_domains ADD CONSTRAINT custody_domain_configuration CHECK (
  length(id) BETWEEN 1 AND 128 AND length(seed_id) BETWEEN 1 AND 128
  AND length(reset_epoch) BETWEEN 1 AND 128 AND length(policy_version) BETWEEN 1 AND 64
  AND configuration_revision > 0 AND status IN ('active', 'paused', 'retired')
);
ALTER TABLE custody_networks ADD CONSTRAINT custody_network_configuration CHECK (
  chain IN ('ethereum', 'bitcoin', 'solana') AND length(network) BETWEEN 1 AND 128
  AND native_asset_id = 'token:' || chain || ':native' AND configuration_revision > 0
);
ALTER TABLE management_wallet_purposes ADD CONSTRAINT management_purpose_configuration CHECK (
  account BETWEEN 1 AND 9 AND length(purpose) BETWEEN 1 AND 64
  AND jsonb_typeof(permitted_actions) = 'array' AND jsonb_array_length(permitted_actions) > 0
  AND maximum_operation_units ~ '^[1-9][0-9]{0,77}$'
  AND maximum_customer_24h_units ~ '^[1-9][0-9]{0,77}$'
  AND maximum_domain_24h_units ~ '^[1-9][0-9]{0,77}$'
  AND maximum_domain_24h_units::numeric <= 115792089237316195423570985008687907853269984665640564039457584007913129639935
  AND maximum_operation_units::numeric <= maximum_customer_24h_units::numeric
  AND maximum_customer_24h_units::numeric <= maximum_domain_24h_units::numeric
  AND configuration_revision > 0
);
ALTER TABLE asset_configurations ADD CONSTRAINT custody_asset_metadata CHECK (
  decimals BETWEEN 0 AND 255 AND configuration_revision > 0
  AND minimum_credit_units ~ '^[1-9][0-9]{0,77}$'
  AND minimum_sweep_units ~ '^[1-9][0-9]{0,77}$'
  AND maximum_fee_units ~ '^[1-9][0-9]{0,77}$'
  AND minimum_credit_units::numeric <= 115792089237316195423570985008687907853269984665640564039457584007913129639935
  AND minimum_sweep_units::numeric <= 115792089237316195423570985008687907853269984665640564039457584007913129639935
  AND maximum_fee_units::numeric <= 115792089237316195423570985008687907853269984665640564039457584007913129639935
  AND (
    (standard = 'native' AND asset_id = 'token:' || chain || ':native'
      AND decimals = CASE chain WHEN 'ethereum' THEN 18 WHEN 'bitcoin' THEN 8 WHEN 'solana' THEN 9 END
      AND contract_address IS NULL AND token_program IS NULL AND mint IS NULL)
    OR (standard = 'erc20' AND chain = 'ethereum'
      AND contract_address IS NOT NULL AND contract_address ~ '^0x[0-9a-f]{40}$'
      AND asset_id = 'token:ethereum:erc20:' || contract_address
      AND token_program IS NULL AND mint IS NULL)
    OR (standard = 'spl' AND chain = 'solana' AND contract_address IS NULL
      AND token_program IS NOT NULL AND token_program ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
      AND mint IS NOT NULL AND mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
      AND asset_id = 'token:solana:spl:' || token_program || ':' || mint)
  )
);
ALTER TABLE wallets ADD CONSTRAINT wallet_custody_identity CHECK (
  custody_role = 'legacy' OR (
    custody_domain_id IS NOT NULL AND reset_epoch IS NOT NULL
    AND configuration_revision > 0 AND registry_revision >= 0
    AND derivation_request_id IS NOT NULL AND derivation_request_digest IS NOT NULL
    AND derivation_request_digest ~ '^[a-f0-9]{64}$'
    AND (
      (custody_role = 'hot' AND account = 0 AND customer_id IS NULL
        AND hot_wallet_id IS NULL AND management_purpose IS NULL)
      OR (custody_role = 'management' AND account BETWEEN 1 AND 9 AND customer_id IS NULL
        AND hot_wallet_id IS NULL AND management_purpose IS NOT NULL)
      OR (custody_role = 'customer_deposit' AND account >= 10 AND customer_id IS NOT NULL
        AND hot_wallet_id IS NOT NULL AND management_purpose IS NULL)
    )
  )
);
ALTER TABLE wallets ADD CONSTRAINT wallet_custody_publication CHECK (
  published_at IS NULL OR (custody_role <> 'legacy' AND address IS NOT NULL
    AND status = 'ready' AND registry_revision > 0)
);
CREATE UNIQUE INDEX wallets_canonical_address_key ON wallets
  (chain, network, (CASE WHEN chain = 'ethereum' THEN lower(address) ELSE address END))
  WHERE address IS NOT NULL;

CREATE FUNCTION enforce_wallet_custody_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE customer exchange_customers%ROWTYPE; hot wallets%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.published_at IS NOT NULL THEN
      RAISE EXCEPTION 'Published custody wallets retain immutable ownership evidence';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.custody_role <> 'legacy' THEN
    IF ROW(NEW.id, NEW.external_id, NEW.custody_domain_id, NEW.reset_epoch,
      NEW.custody_role, NEW.customer_id, NEW.hot_wallet_id, NEW.management_purpose,
      NEW.seed_id, NEW.chain, NEW.network, NEW.account, NEW.path,
      NEW.configuration_revision, NEW.derivation_request_id, NEW.derivation_request_digest)
      IS DISTINCT FROM ROW(OLD.id, OLD.external_id, OLD.custody_domain_id, OLD.reset_epoch,
      OLD.custody_role, OLD.customer_id, OLD.hot_wallet_id, OLD.management_purpose,
      OLD.seed_id, OLD.chain, OLD.network, OLD.account, OLD.path,
      OLD.configuration_revision, OLD.derivation_request_id, OLD.derivation_request_digest) THEN
      RAISE EXCEPTION 'Custody wallet derivation and ownership identity are immutable';
    END IF;
    IF OLD.published_at IS NOT NULL AND
      (NEW.address IS DISTINCT FROM OLD.address OR NEW.published_at IS DISTINCT FROM OLD.published_at
        OR NEW.registry_revision < OLD.registry_revision) THEN
      RAISE EXCEPTION 'Published custody address identity is immutable';
    END IF;
  END IF;
  IF NEW.custody_role = 'customer_deposit' THEN
    SELECT * INTO customer FROM exchange_customers WHERE customer_id = NEW.customer_id;
    IF customer.customer_id IS NULL OR customer.domain_id <> NEW.custody_domain_id
      OR customer.reset_epoch <> NEW.reset_epoch THEN
      RAISE EXCEPTION 'Custody wallet customer identity does not match its domain and epoch';
    END IF;
    SELECT * INTO hot FROM wallets WHERE id = NEW.hot_wallet_id;
    IF hot.id IS NULL OR hot.custody_role <> 'hot' OR hot.account <> 0
      OR hot.custody_domain_id IS DISTINCT FROM NEW.custody_domain_id
      OR hot.reset_epoch IS DISTINCT FROM NEW.reset_epoch OR hot.seed_id <> NEW.seed_id
      OR hot.chain <> NEW.chain OR hot.network <> NEW.network THEN
      RAISE EXCEPTION 'Customer custody destination must be the matching hot0 wallet';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wallet_custody_identity BEFORE INSERT OR UPDATE OR DELETE ON wallets
  FOR EACH ROW EXECUTE FUNCTION enforce_wallet_custody_identity();

CREATE FUNCTION enforce_custody_configuration_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'asset_configurations' THEN
    RAISE EXCEPTION 'Pinned custody asset configurations retain immutable policy evidence';
  END IF;
  IF TG_TABLE_NAME = 'custody_domains' THEN
    IF ROW(NEW.id, NEW.seed_id, NEW.reset_epoch, NEW.policy_version, NEW.configuration_revision)
      IS DISTINCT FROM ROW(OLD.id, OLD.seed_id, OLD.reset_epoch, OLD.policy_version, OLD.configuration_revision) THEN
      RAISE EXCEPTION 'Custody generation configuration is immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'custody_networks' THEN
    IF ROW(NEW.domain_id, NEW.chain, NEW.network, NEW.native_asset_id, NEW.configuration_revision)
      IS DISTINCT FROM ROW(OLD.domain_id, OLD.chain, OLD.network, OLD.native_asset_id, OLD.configuration_revision) THEN
      RAISE EXCEPTION 'Custody network identity is immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'management_wallet_purposes' THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Approved management purpose and spending policy are immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'asset_configurations' THEN
    IF ROW(NEW.domain_id, NEW.chain, NEW.network, NEW.asset_id, NEW.standard, NEW.decimals,
      NEW.symbol, NEW.name, NEW.contract_address, NEW.token_program, NEW.mint,
      NEW.minimum_credit_units, NEW.minimum_sweep_units, NEW.maximum_fee_units,
      NEW.policy_version, NEW.configuration_revision)
      IS DISTINCT FROM ROW(OLD.domain_id, OLD.chain, OLD.network, OLD.asset_id, OLD.standard, OLD.decimals,
      OLD.symbol, OLD.name, OLD.contract_address, OLD.token_program, OLD.mint,
      OLD.minimum_credit_units, OLD.minimum_sweep_units, OLD.maximum_fee_units,
      OLD.policy_version, OLD.configuration_revision) THEN
      RAISE EXCEPTION 'Pinned custody asset identity and metadata are immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER custody_domain_identity BEFORE UPDATE ON custody_domains
  FOR EACH ROW EXECUTE FUNCTION enforce_custody_configuration_identity();
CREATE TRIGGER custody_network_identity BEFORE UPDATE ON custody_networks
  FOR EACH ROW EXECUTE FUNCTION enforce_custody_configuration_identity();
CREATE TRIGGER management_purpose_identity BEFORE UPDATE ON management_wallet_purposes
  FOR EACH ROW EXECUTE FUNCTION enforce_custody_configuration_identity();
CREATE TRIGGER custody_asset_identity BEFORE UPDATE ON asset_configurations
  FOR EACH ROW EXECUTE FUNCTION enforce_custody_configuration_identity();
CREATE TRIGGER custody_asset_retention BEFORE DELETE ON asset_configurations
  FOR EACH ROW EXECUTE FUNCTION enforce_custody_configuration_identity();
