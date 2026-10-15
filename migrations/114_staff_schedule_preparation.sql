-- NULL inherits the current venue attendance policy; 0 is an explicit override.
-- Concrete published shifts retain this value independently of later template edits.
-- Additive rollback: old application code can ignore this nullable column. Do not
-- drop it after use, as that would discard published preparation overrides.
ALTER TABLE staff_schedules ADD COLUMN IF NOT EXISTS preparation_minutes integer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='staff_schedules'::regclass
    AND conname='staff_schedules_preparation_minutes_check') THEN
    ALTER TABLE staff_schedules ADD CONSTRAINT staff_schedules_preparation_minutes_check
      CHECK (preparation_minutes IS NULL OR
        (kind IN ('shift','open_shift') AND preparation_minutes BETWEEN 0 AND 240));
  END IF;
END $$;
