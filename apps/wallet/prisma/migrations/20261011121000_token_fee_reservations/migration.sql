ALTER TABLE asset_configurations ADD COLUMN transfer_certificate JSONB;
CREATE TABLE token_fee_reservations (
 id UUID PRIMARY KEY, domain_id TEXT NOT NULL, reset_epoch TEXT NOT NULL,
 customer_id UUID NOT NULL, source_wallet_id UUID NOT NULL REFERENCES wallets(id),
 management_wallet_id UUID NOT NULL REFERENCES wallets(id), chain TEXT NOT NULL, network TEXT NOT NULL,
 dependency_key TEXT NOT NULL UNIQUE, request_digest TEXT NOT NULL, kind TEXT NOT NULL,
 principal_units TEXT NOT NULL, maximum_fee_units TEXT NOT NULL, maximum_rent_units TEXT NOT NULL,
 reserved_units TEXT NOT NULL, actual_units TEXT, state TEXT NOT NULL, request JSONB NOT NULL,
 settled_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY (customer_id,domain_id,reset_epoch) REFERENCES exchange_customers(customer_id,domain_id,reset_epoch),
 CONSTRAINT token_fee_state CHECK(state IN ('reserved','uncertain','settled','released','reverted')),
 CONSTRAINT token_fee_kind CHECK(kind IN ('gas_funding','spl_sponsorship')),
 CONSTRAINT token_fee_units CHECK (
 principal_units ~ '^(0|[1-9][0-9]{0,77})$' AND maximum_fee_units ~ '^(0|[1-9][0-9]{0,77})$'
 AND maximum_rent_units ~ '^(0|[1-9][0-9]{0,77})$' AND reserved_units ~ '^[1-9][0-9]{0,77}$'
 AND reserved_units::numeric = principal_units::numeric + maximum_fee_units::numeric + maximum_rent_units::numeric
 AND reserved_units::numeric < power(2::numeric,256)
 AND (actual_units IS NULL OR (actual_units ~ '^(0|[1-9][0-9]{0,77})$' AND actual_units::numeric < power(2::numeric,256)))
 ),
 CONSTRAINT token_fee_settlement CHECK ((state='settled' AND settled_at IS NOT NULL AND actual_units IS NOT NULL)
 OR (state<>'settled' AND settled_at IS NULL AND actual_units IS NULL)),
 CONSTRAINT token_fee_digest CHECK(request_digest ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX one_pending_token_fee_dependency ON token_fee_reservations(domain_id,reset_epoch,source_wallet_id,chain,network) WHERE state IN ('reserved','uncertain','reverted');
CREATE INDEX token_fee_budget_window ON token_fee_reservations(domain_id,reset_epoch,chain,network,settled_at);
CREATE FUNCTION protect_token_fee_identity() RETURNS trigger AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Fee dependencies are retained'; END IF;
 IF (to_jsonb(NEW) - ARRAY['state','actual_units','settled_at','updated_at']) IS DISTINCT FROM
 (to_jsonb(OLD) - ARRAY['state','actual_units','settled_at','updated_at']) THEN
 RAISE EXCEPTION 'Fee dependency identity is immutable'; END IF;
 IF OLD.state IN ('uncertain','reverted') AND NEW.state='released' THEN RAISE EXCEPTION 'Uncertain fee exposure cannot be released'; END IF;
 IF (OLD.state='reserved' AND NEW.state NOT IN ('reserved','uncertain','settled','released'))
 OR (OLD.state='uncertain' AND NEW.state NOT IN ('uncertain','settled','reverted'))
 OR (OLD.state='settled' AND NEW.state NOT IN ('settled','reverted'))
 OR (OLD.state='reverted' AND NEW.state NOT IN ('reverted','settled')) THEN
 RAISE EXCEPTION 'Invalid fee dependency transition'; END IF;
 IF OLD.state='settled' AND NEW.state='settled' AND (NEW.actual_units,NEW.settled_at) IS DISTINCT FROM (OLD.actual_units,OLD.settled_at) THEN
 RAISE EXCEPTION 'Canonical fee settlement is immutable'; END IF;
 IF OLD.state='released' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Released fee dependency is terminal'; END IF;
 RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER protect_token_fee_identity BEFORE UPDATE OR DELETE ON token_fee_reservations FOR EACH ROW EXECUTE FUNCTION protect_token_fee_identity();

CREATE FUNCTION protect_transfer_certificate() RETURNS trigger AS $$ BEGIN
 IF OLD.transfer_certificate IS NOT NULL AND NEW.transfer_certificate IS DISTINCT FROM OLD.transfer_certificate THEN
 RAISE EXCEPTION 'Certified transfer semantics are immutable'; END IF;
 RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER protect_transfer_certificate BEFORE UPDATE ON asset_configurations FOR EACH ROW EXECUTE FUNCTION protect_transfer_certificate();
ALTER TABLE asset_configurations ADD CONSTRAINT enabled_token_certificate CHECK (
 standard='native' OR NOT (observation_enabled OR credit_enabled OR sweep_enabled OR withdrawal_enabled)
 OR ((transfer_certificate IS NOT NULL AND jsonb_typeof(transfer_certificate)='object'
 AND transfer_certificate->>'standard'=standard AND transfer_certificate->>'chain'=chain
 AND transfer_certificate->>'network'=network AND transfer_certificate->>'semantics'='exact-transfer') IS TRUE)
);
