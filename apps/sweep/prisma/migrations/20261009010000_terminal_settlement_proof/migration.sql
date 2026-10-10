ALTER TABLE sweep_attempts ADD COLUMN terminal_settlement_revision INTEGER;
ALTER TABLE sweep_attempts ADD CONSTRAINT sweep_attempt_terminal_settlement_revision CHECK
  (terminal_settlement_revision IS NULL OR terminal_settlement_revision > 0);
