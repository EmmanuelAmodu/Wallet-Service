ALTER TABLE "ledger_activities"
  ALTER COLUMN "observation_sequence" TYPE BIGINT USING "observation_sequence"::BIGINT;