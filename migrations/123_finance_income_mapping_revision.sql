-- Order mapping corrections by serialized revision, not transaction start time.
ALTER TABLE finance_income_category_mappings
  ADD COLUMN IF NOT EXISTS revision integer;

-- The existing append-only trigger also guards metadata. Drop it only inside
-- this transaction and restore it before commit; derive order from the immutable
-- supersedes chain rather than transaction timestamps.
DROP TRIGGER IF EXISTS finance_income_mapping_immutable ON finance_income_category_mappings;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM finance_income_category_mappings child
    JOIN finance_income_category_mappings parent
      ON parent.venue_id=child.venue_id AND parent.id=child.supersedes_mapping_id
    WHERE child.source_key IS DISTINCT FROM parent.source_key
       OR child.effective_from IS DISTINCT FROM parent.effective_from
  ) THEN
    RAISE EXCEPTION 'finance_income_mapping_revision_parent_mismatch';
  END IF;
END $$;

WITH RECURSIVE mapping_chain AS (
  SELECT venue_id,id,source_key,effective_from,1::integer AS revision
  FROM finance_income_category_mappings WHERE supersedes_mapping_id IS NULL
  UNION ALL
  SELECT next.venue_id,next.id,next.source_key,next.effective_from,previous.revision+1
  FROM finance_income_category_mappings next
  JOIN mapping_chain previous ON previous.venue_id=next.venue_id AND previous.id=next.supersedes_mapping_id
    AND previous.source_key=next.source_key AND previous.effective_from=next.effective_from
), assigned AS (
  SELECT venue_id,id,MAX(revision)::integer AS revision
  FROM mapping_chain GROUP BY venue_id,id
)
UPDATE finance_income_category_mappings m
SET revision=assigned.revision
FROM assigned
WHERE assigned.venue_id=m.venue_id AND assigned.id=m.id AND m.revision IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM finance_income_category_mappings WHERE revision IS NULL) THEN
    RAISE EXCEPTION 'finance_income_mapping_revision_chain_invalid';
  END IF;
END $$;

ALTER TABLE finance_income_category_mappings
  ALTER COLUMN revision SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS finance_income_category_mapping_revision_unique_idx
  ON finance_income_category_mappings(venue_id,source_key,effective_from,revision);

DROP INDEX IF EXISTS finance_income_category_mapping_revision_lookup_idx;
CREATE INDEX IF NOT EXISTS finance_income_category_mapping_revision_lookup_idx
  ON finance_income_category_mappings(venue_id,source_key,effective_from DESC,revision DESC,id DESC);

DROP TRIGGER IF EXISTS finance_income_mapping_immutable ON finance_income_category_mappings;
CREATE TRIGGER finance_income_mapping_immutable BEFORE UPDATE OR DELETE ON finance_income_category_mappings
  FOR EACH ROW EXECUTE FUNCTION guard_finance_income_mapping_immutable();
