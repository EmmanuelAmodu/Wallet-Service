CREATE TABLE withdrawal_batch_preparations (
 batch_id uuid PRIMARY KEY REFERENCES withdrawal_batch_drafts(id),
 preparation jsonb NOT NULL, preparation_digest text NOT NULL CHECK(preparation_digest ~ '^[0-9a-f]{64}$'),
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE withdrawal_batch_resources (
 batch_id uuid NOT NULL REFERENCES withdrawal_batch_preparations(batch_id),resource_key text NOT NULL,
 active boolean NOT NULL DEFAULT true,released_at timestamptz,
 PRIMARY KEY(batch_id,resource_key),CHECK(active=(released_at IS NULL))
);
CREATE UNIQUE INDEX one_active_batch_resource ON withdrawal_batch_resources(resource_key) WHERE active;

CREATE FUNCTION protect_batch_preparation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b withdrawal_batch_drafts%ROWTYPE;
DECLARE p jsonb;
DECLARE member jsonb;
DECLARE ordinal bigint;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Unsigned batch preparation history is immutable'; END IF;
 SELECT * INTO STRICT b FROM withdrawal_batch_drafts WHERE id=NEW.batch_id;
 PERFORM pg_advisory_xact_lock(hashtextextended('custody-source:'||b.source_wallet_id::text,0));
 -- Reload after waiting: dissolution may have committed while this writer waited.
 SELECT * INTO STRICT b FROM withdrawal_batch_drafts WHERE id=NEW.batch_id FOR UPDATE;
 p=NEW.preparation;
 IF NOT (p ?& ARRAY['version','batchId','manifestDigest','request','requestDigest','principalUnits','feeUnits','changeUnits','changeOutputIndex','memberOutputs','memberCosts','resourceKeys','expiresAt','preparationDigest'])
  OR p->>'version' IS DISTINCT FROM '1' OR p->>'preparationDigest' IS DISTINCT FROM NEW.preparation_digest
  OR p#>>'{request,transaction,satsPerVbyte}' IS NULL OR (p#>>'{request,transaction,satsPerVbyte}')::integer NOT BETWEEN 1 AND 100
  OR b.state<>'planned' OR b.manifest#>>'{asset,chain}'<>'bitcoin'
  OR p->>'batchId' IS DISTINCT FROM b.id::text OR p->>'manifestDigest' IS DISTINCT FROM b.manifest_digest
  OR p#>>'{request,wallet,address}' IS DISTINCT FROM b.manifest->>'sourceAddress'
  OR p#>>'{request,wallet,seedId}' IS DISTINCT FROM b.manifest->>'seedId'
  OR p#>>'{request,wallet,account}' IS DISTINCT FROM '0'
  OR p#>>'{request,wallet,chain}' IS DISTINCT FROM 'bitcoin' OR p#>>'{request,wallet,network}' IS DISTINCT FROM 'regtest'
  OR p#>>'{request,transaction,chain}' IS DISTINCT FROM 'bitcoin'
  OR p#>'{request,transaction,sweepAll}' IS NOT NULL
  OR p#>>'{request,transaction,changeAmount}' IS DISTINCT FROM p->>'changeUnits'
  OR (p->>'changeUnits')::numeric<546 OR (p->>'feeUnits')::numeric NOT BETWEEN 1 AND 10000
  OR p->>'changeOutputIndex' IS DISTINCT FROM '1'
  OR NEW.expires_at IS DISTINCT FROM (p->>'expiresAt')::timestamptz OR NEW.expires_at<=now()
  OR jsonb_array_length(p#>'{request,transaction,outputs}') IS DISTINCT FROM jsonb_array_length(b.manifest->'members')
  OR jsonb_array_length(p->'memberOutputs') IS DISTINCT FROM jsonb_array_length(b.manifest->'members')
  OR jsonb_array_length(p->'memberCosts') IS DISTINCT FROM jsonb_array_length(b.manifest->'members')
  OR jsonb_array_length(p#>'{request,transaction,utxos}') NOT BETWEEN 1 AND 100
  OR jsonb_array_length(p->'resourceKeys') IS DISTINCT FROM jsonb_array_length(p#>'{request,transaction,utxos}') THEN
   RAISE EXCEPTION 'Unsigned batch preparation must bind its exact live draft and hot change';
 END IF;
 FOR member,ordinal IN SELECT value, ordinality-1 FROM jsonb_array_elements(b.manifest->'members') WITH ORDINALITY LOOP
  IF p#>>ARRAY['request','transaction','outputs',ordinal::text,'address'] IS DISTINCT FROM member->>'destination'
   OR p#>>ARRAY['request','transaction','outputs',ordinal::text,'amount'] IS DISTINCT FROM member->>'principalUnits'
   OR p#>>ARRAY['memberOutputs',ordinal::text,'operationId'] IS DISTINCT FROM member->>'operationId'
   OR p#>>ARRAY['memberOutputs',ordinal::text,'attemptId'] IS DISTINCT FROM member->>'attemptId'
   OR p#>>ARRAY['memberOutputs',ordinal::text,'reservationId'] IS DISTINCT FROM member->>'reservationId'
   OR p#>>ARRAY['memberOutputs',ordinal::text,'outputIndex'] IS DISTINCT FROM (ordinal+(CASE WHEN ordinal>0 THEN 1 ELSE 0 END))::text
   OR p#>>ARRAY['memberOutputs',ordinal::text,'destination'] IS DISTINCT FROM member->>'destination'
   OR p#>>ARRAY['memberOutputs',ordinal::text,'principalUnits'] IS DISTINCT FROM member->>'principalUnits'
   OR p#>>ARRAY['memberCosts',ordinal::text,'operationId'] IS DISTINCT FROM member->>'operationId'
   OR p#>>ARRAY['memberCosts',ordinal::text,'reservationId'] IS DISTINCT FROM member->>'reservationId'
   OR p#>>ARRAY['memberCosts',ordinal::text,'attemptId'] IS DISTINCT FROM member->>'attemptId'
   OR p#>>ARRAY['memberCosts',ordinal::text,'principalUnits'] IS DISTINCT FROM member->>'principalUnits'
   OR p#>>ARRAY['memberCosts',ordinal::text,'rentUnits'] IS DISTINCT FROM '0'
   OR (p#>>ARRAY['memberCosts',ordinal::text,'feeUnits'])::numeric IS DISTINCT FROM
      trunc((p->>'feeUnits')::numeric/jsonb_array_length(b.manifest->'members'))+
      (CASE WHEN ordinal<mod((p->>'feeUnits')::numeric,jsonb_array_length(b.manifest->'members')) THEN 1 ELSE 0 END)
   OR (p#>>ARRAY['memberCosts',ordinal::text,'feeUnits'])::numeric>(member->>'maximumFeeUnits')::numeric THEN
    RAISE EXCEPTION 'Batch preparation changed an original payout or fee allocation';
  END IF;
 END LOOP;
 IF (SELECT sum((value->>'amount')::numeric) FROM jsonb_array_elements(p#>'{request,transaction,utxos}')) IS DISTINCT FROM
  (p->>'principalUnits')::numeric+(p->>'feeUnits')::numeric+(p->>'changeUnits')::numeric
  OR (SELECT sum((value->>'principalUnits')::numeric) FROM jsonb_array_elements(b.manifest->'members')) IS DISTINCT FROM (p->>'principalUnits')::numeric THEN
   RAISE EXCEPTION 'Batch input/principal/fee/change conservation failed'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_batch_preparation BEFORE INSERT OR UPDATE OR DELETE ON withdrawal_batch_preparations FOR EACH ROW EXECUTE FUNCTION protect_batch_preparation();

CREATE FUNCTION protect_batch_resource() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b withdrawal_batch_drafts%ROWTYPE;
DECLARE p jsonb;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Batch resource history is retained'; END IF;
 SELECT * INTO STRICT b FROM withdrawal_batch_drafts WHERE id=NEW.batch_id;
 SELECT preparation INTO STRICT p FROM withdrawal_batch_preparations WHERE batch_id=NEW.batch_id;
 PERFORM pg_advisory_xact_lock(hashtextextended('execution-resource:'||NEW.resource_key,0));
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.batch_id,NEW.resource_key) IS DISTINCT FROM ROW(OLD.batch_id,OLD.resource_key)
   OR NOT OLD.active OR NEW.active OR b.state<>'released' OR NEW.released_at IS NULL THEN
    RAISE EXCEPTION 'Batch resource identity is immutable; only unsigned dissolution can release it'; END IF;
 ELSE
  IF b.state<>'planned' OR NOT NEW.active OR NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(p#>'{request,transaction,utxos}') u
    WHERE NEW.resource_key=b.domain_id||':'||b.reset_epoch||':bitcoin:regtest:utxo:'||(u->>'txid')||':'||(u->>'vout'))
   OR EXISTS(SELECT 1 FROM execution_resource_claims WHERE resource_key=NEW.resource_key AND active) THEN
    RAISE EXCEPTION 'Batch resource is not owned or is already retained by an individual attempt'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_batch_resource BEFORE INSERT OR UPDATE OR DELETE ON withdrawal_batch_resources FOR EACH ROW EXECUTE FUNCTION protect_batch_resource();

CREATE FUNCTION individual_batch_resource_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.active THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('execution-resource:'||NEW.resource_key,0));
  IF EXISTS(SELECT 1 FROM withdrawal_batch_resources WHERE resource_key=NEW.resource_key AND active) THEN
   RAISE EXCEPTION 'Canonical resource is reserved by an unsigned batch'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER individual_batch_resource_fence BEFORE INSERT OR UPDATE ON execution_resource_claims FOR EACH ROW EXECUTE FUNCTION individual_batch_resource_fence();

CREATE FUNCTION release_unsigned_batch_resources() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state='released' THEN UPDATE withdrawal_batch_resources SET active=false,released_at=NEW.released_at WHERE batch_id=NEW.id AND active; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER release_unsigned_batch_resources AFTER UPDATE ON withdrawal_batch_drafts FOR EACH ROW EXECUTE FUNCTION release_unsigned_batch_resources();

CREATE FUNCTION complete_batch_resources() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch_uuid uuid;
DECLARE b withdrawal_batch_drafts%ROWTYPE;
DECLARE p jsonb;
BEGIN
 batch_uuid=NEW.batch_id;
 SELECT * INTO STRICT b FROM withdrawal_batch_drafts WHERE id=batch_uuid;
 SELECT preparation INTO STRICT p FROM withdrawal_batch_preparations WHERE batch_id=batch_uuid;
 IF (SELECT count(*) FROM withdrawal_batch_resources WHERE batch_id=batch_uuid)<>jsonb_array_length(p#>'{request,transaction,utxos}')
  OR (b.state='planned' AND EXISTS(SELECT 1 FROM withdrawal_batch_resources WHERE batch_id=batch_uuid AND NOT active))
  OR (b.state='released' AND EXISTS(SELECT 1 FROM withdrawal_batch_resources WHERE batch_id=batch_uuid AND active)) THEN
   RAISE EXCEPTION 'Unsigned batch must retain its complete exact input reservations'; END IF;
 RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER complete_batch_preparation AFTER INSERT ON withdrawal_batch_preparations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION complete_batch_resources();
CREATE CONSTRAINT TRIGGER complete_batch_resource AFTER INSERT OR UPDATE ON withdrawal_batch_resources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION complete_batch_resources();
