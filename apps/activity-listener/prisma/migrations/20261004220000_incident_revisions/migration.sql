ALTER TABLE exchange_custody_incidents ADD COLUMN state TEXT NOT NULL DEFAULT 'open', ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE exchange_custody_incidents ADD CONSTRAINT exchange_incident_revision CHECK (revision > 0);
