ALTER TABLE sweep_work ADD COLUMN last_operation_id UUID;
ALTER TABLE sweep_operations ADD COLUMN revision INTEGER NOT NULL DEFAULT 1,
ADD COLUMN supersedes_operation_id UUID;
ALTER TABLE sweep_operations ADD CONSTRAINT sweep_operation_revision CHECK (revision > 0);

CREATE OR REPLACE FUNCTION sweep_operation_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['state','reason','terminal_at','updated_at','revision'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state','reason','terminal_at','updated_at','revision']) THEN
    RAISE EXCEPTION 'Sweep operation identity is immutable';
  END IF;
  IF NEW.revision < OLD.revision THEN
    RAISE EXCEPTION 'Sweep operation revision cannot decrease';
  END IF;
  RETURN NEW;
END;
$$;
