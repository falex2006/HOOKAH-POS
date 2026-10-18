-- Preserve historical POS category mappings while allowing an audited correction
-- for the same source and effective month. Existing POS income snapshots remain
-- immutable and are never reclassified by this migration.
ALTER TABLE finance_income_category_mappings
  ADD COLUMN IF NOT EXISTS supersedes_mapping_id uuid;

DO $$
DECLARE unique_constraint record;
BEGIN
  FOR unique_constraint IN
    SELECT conname FROM pg_constraint
    WHERE conrelid='finance_income_category_mappings'::regclass AND contype='u'
      AND pg_get_constraintdef(oid)='UNIQUE (venue_id, source_key, effective_from)'
  LOOP
    EXECUTE format('ALTER TABLE finance_income_category_mappings DROP CONSTRAINT %I',unique_constraint.conname);
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='finance_income_category_mappings'::regclass
      AND conname='finance_income_mapping_supersedes_fk'
  ) THEN
    ALTER TABLE finance_income_category_mappings
      ADD CONSTRAINT finance_income_mapping_supersedes_fk
      FOREIGN KEY (venue_id,supersedes_mapping_id)
      REFERENCES finance_income_category_mappings(venue_id,id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS finance_income_category_mapping_revision_lookup_idx
  ON finance_income_category_mappings(venue_id,source_key,effective_from DESC,created_at DESC,id DESC);
