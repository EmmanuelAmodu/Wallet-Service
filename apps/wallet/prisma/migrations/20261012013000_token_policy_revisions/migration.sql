CREATE OR REPLACE FUNCTION enforce_custody_configuration_identity() RETURNS trigger LANGUAGE plpgsql AS $$
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
      NEW.policy_version)
      IS DISTINCT FROM ROW(OLD.domain_id, OLD.chain, OLD.network, OLD.asset_id, OLD.standard, OLD.decimals,
      OLD.symbol, OLD.name, OLD.contract_address, OLD.token_program, OLD.mint,
      OLD.minimum_credit_units, OLD.minimum_sweep_units, OLD.maximum_fee_units,
      OLD.policy_version) THEN
      RAISE EXCEPTION 'Pinned custody asset identity and metadata are immutable';
    END IF;
    IF NEW.standard='native' AND NEW.configuration_revision<>OLD.configuration_revision THEN
      RAISE EXCEPTION 'Pinned native asset configuration revision is immutable';
    ELSIF NEW.standard<>'native' AND (
      NEW.configuration_revision<OLD.configuration_revision OR
      (ROW(NEW.observation_enabled,NEW.credit_enabled,NEW.sweep_enabled,NEW.withdrawal_enabled)
        IS DISTINCT FROM ROW(OLD.observation_enabled,OLD.credit_enabled,OLD.sweep_enabled,OLD.withdrawal_enabled)
        AND NEW.configuration_revision<=OLD.configuration_revision)) THEN
      RAISE EXCEPTION 'Token policy changes require an advancing configuration revision';
    END IF;
  END IF;
  RETURN NEW;
END $$;
