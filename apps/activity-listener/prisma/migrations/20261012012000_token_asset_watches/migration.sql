CREATE TABLE exchange_token_assets (
 domain_id TEXT NOT NULL,reset_epoch TEXT NOT NULL,chain TEXT NOT NULL,network TEXT NOT NULL,asset_id TEXT NOT NULL,
 certificate JSONB NOT NULL,certificate_digest TEXT NOT NULL,configuration_revision INTEGER NOT NULL,
 observation_enabled BOOLEAN NOT NULL DEFAULT false,credit_enabled BOOLEAN NOT NULL DEFAULT false,request JSONB NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(domain_id,reset_epoch,chain,network,asset_id),
 CHECK(certificate_digest ~ '^[a-f0-9]{64}$' AND configuration_revision>0),CHECK(NOT credit_enabled OR observation_enabled)
);
CREATE TABLE exchange_token_watches (
 id UUID PRIMARY KEY,wallet_id UUID NOT NULL REFERENCES exchange_wallet_registry(wallet_id),domain_id TEXT NOT NULL,reset_epoch TEXT NOT NULL,
 asset_id TEXT NOT NULL,configuration_revision INTEGER NOT NULL,registry_revision INTEGER NOT NULL,generation UUID NOT NULL UNIQUE,
 identity JSONB NOT NULL,watch_id TEXT,start_cursor TEXT,through_cursor TEXT,cursor TEXT,state TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,
 lease_until TIMESTAMPTZ,next_check_at TIMESTAMPTZ NOT NULL DEFAULT now(),last_error TEXT,updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(wallet_id,asset_id),
 CHECK(configuration_revision>0 AND registry_revision>0 AND revision>=0),CHECK(state IN ('installing','backfill','ready','paused','removing')),
 CHECK(state<>'ready' OR (watch_id IS NOT NULL AND cursor IS NOT NULL AND through_cursor IS NOT NULL))
);
CREATE INDEX token_watch_due ON exchange_token_watches(next_check_at);
CREATE FUNCTION protect_token_certification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Token certification evidence is retained'; END IF;
 IF ROW(NEW.domain_id,NEW.reset_epoch,NEW.chain,NEW.network,NEW.asset_id,NEW.certificate,NEW.certificate_digest)
 IS DISTINCT FROM ROW(OLD.domain_id,OLD.reset_epoch,OLD.chain,OLD.network,OLD.asset_id,OLD.certificate,OLD.certificate_digest)
 OR NEW.configuration_revision < OLD.configuration_revision THEN RAISE EXCEPTION 'Token certification identity is immutable'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER token_certification_identity BEFORE UPDATE OR DELETE ON exchange_token_assets FOR EACH ROW EXECUTE FUNCTION protect_token_certification();
