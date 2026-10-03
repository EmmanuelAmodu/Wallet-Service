-- Repair databases that applied the aggregate-opening version of the cutover.
-- Append balanced adjustments; never rewrite or delete existing journal history.
BEGIN;
LOCK TABLE ledger_activities, ledger_entries IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE
  legacy RECORD;
  target RECORD;
  tail RECORD;
  repair_id TEXT;
  posting_activity TEXT;
  posting_revision INTEGER;
  posting_key TEXT;
  posting_kind TEXT;
  posting_delta NUMERIC;
  posting_id UUID;
  restore_original BOOLEAN;
  phase INTEGER;
BEGIN
  IF to_regclass('public.ledger_legacy_entries') IS NULL THEN RETURN; END IF;

  FOR legacy IN
    SELECT e.*, w.chain, w.network, a.revision AS current_revision, a.state AS current_state
    FROM ledger_legacy_entries e
    JOIN ledger_wallets w ON w.wallet_id = e.wallet_id
    JOIN ledger_activities a ON a.identifier = e.activity_identifier
    WHERE e.kind IN ('confirmed', 'provisional')
      AND e.reversed_at IS NULL AND e.reverses_id IS NULL AND e.amount <> 0
      AND NOT EXISTS (SELECT 1 FROM ledger_entries j WHERE j.id = e.id)
    ORDER BY e.activity_identifier, e.wallet_id, e.asset, e.kind, e.id
  LOOP
    repair_id := 'legacy-link-repair:' || legacy.id::text;
    IF EXISTS (SELECT 1 FROM ledger_activities WHERE identifier = repair_id) THEN CONTINUE; END IF;
    -- A migrated activity that has already advanced has its new postings. Remove
    -- only its stranded opening contribution. Otherwise restore reversible lines
    -- under the original activity and revision before removing that contribution.
    restore_original := legacy.current_revision = legacy.revision
      AND legacy.current_state <> 'reverted'
      AND NOT EXISTS (
        SELECT 1 FROM ledger_entries
        WHERE activity_identifier = legacy.activity_identifier AND revision = legacy.revision
          AND wallet_id = legacy.wallet_id AND asset = legacy.asset
          AND balance_state = legacy.kind AND entry_kind = 'wallet'
      );
    INSERT INTO ledger_activities
      (identifier, chain, network, transaction_hash, state, revision, completed_at_ms,
       source_status, payload, updated_at, finalized_at)
    VALUES (repair_id, legacy.chain, legacy.network, repair_id, 'finalized', 0, 0,
      'success', jsonb_build_object('source', 'legacy-activity-link-repair', 'legacyEntryId', legacy.id),
      now(), now());

    FOR phase IN 0..1 LOOP
      IF phase = 1 AND NOT restore_original THEN CONTINUE; END IF;
      posting_activity := CASE WHEN phase = 0 THEN repair_id ELSE legacy.activity_identifier END;
      posting_revision := CASE WHEN phase = 0 THEN 0 ELSE legacy.revision END;
      posting_delta := CASE WHEN phase = 0 THEN -legacy.amount ELSE legacy.amount END;
      FOR target IN SELECT unnest(ARRAY['wallet', 'clearing']) AS kind LOOP
        posting_kind := target.kind;
        posting_key := CASE WHEN posting_kind = 'wallet'
          THEN 'wallet:' || legacy.wallet_id::text || ':' || legacy.asset || ':' || legacy.kind
          ELSE 'clearing:' || legacy.chain || ':' || legacy.network || ':' || legacy.asset || ':' || legacy.kind END;
        SELECT id, sequence, balance_after INTO tail FROM ledger_entries
          WHERE account_key = posting_key ORDER BY sequence DESC LIMIT 1;
        posting_id := CASE WHEN phase = 1 AND posting_kind = 'wallet' THEN legacy.id ELSE gen_random_uuid() END;
        INSERT INTO ledger_entries
          (id, activity_identifier, revision, account_key, sequence, wallet_id, asset,
           account_kind, side, amount, balance_after, balance_state, entry_kind, previous_entry_id)
        VALUES (posting_id, posting_activity, posting_revision, posting_key, coalesce(tail.sequence, 0) + 1,
          CASE WHEN posting_kind = 'wallet' THEN legacy.wallet_id ELSE NULL END, legacy.asset,
          posting_kind,
          CASE WHEN (posting_delta > 0) = (posting_kind = 'wallet') THEN 'debit' ELSE 'credit' END,
          abs(posting_delta), coalesce(tail.balance_after, 0) + posting_delta, legacy.kind, posting_kind, tail.id);
      END LOOP;
    END LOOP;
  END LOOP;
END $$;
COMMIT;
