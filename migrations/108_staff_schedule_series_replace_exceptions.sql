-- A replacement occurrence is explicit configuration, distinct from a manual edit
-- of an already-published schedule row.
ALTER TABLE staff_schedule_series_exceptions
  DROP CONSTRAINT IF EXISTS staff_schedule_series_exceptions_exception_kind_check;
ALTER TABLE staff_schedule_series_exceptions
  ADD CONSTRAINT staff_schedule_series_exceptions_exception_kind_check
  CHECK(exception_kind IN ('skip','replace','manual'));
