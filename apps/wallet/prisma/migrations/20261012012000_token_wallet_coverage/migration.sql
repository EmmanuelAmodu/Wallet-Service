CREATE TABLE token_wallet_coverage (
 wallet_id UUID NOT NULL REFERENCES wallets(id),asset_id TEXT NOT NULL,domain_id TEXT NOT NULL,reset_epoch TEXT NOT NULL,
 certificate_digest TEXT NOT NULL,configuration_revision INTEGER NOT NULL,registry_revision INTEGER NOT NULL,generation UUID NOT NULL,
 readiness_revision INTEGER NOT NULL DEFAULT 0, ready BOOLEAN NOT NULL DEFAULT false,cursor TEXT,updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(wallet_id,asset_id),
 CHECK(certificate_digest ~ '^[a-f0-9]{64}$' AND configuration_revision>0 AND registry_revision>0),CHECK(NOT ready OR cursor IS NOT NULL)
);
