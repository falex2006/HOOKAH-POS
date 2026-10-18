-- Keep confirmed recurring-payable generation retryable after a lost response.
ALTER TABLE finance_create_idempotency
  DROP CONSTRAINT IF EXISTS finance_create_idempotency_operation_check;
ALTER TABLE finance_create_idempotency
  ADD CONSTRAINT finance_create_idempotency_operation_check
  CHECK (operation IN ('payable_create','recurring_rule_create','recurring_rule_version_create','recurring_payable_generation'));

CREATE OR REPLACE FUNCTION guard_finance_create_idempotency()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.venue_id IS DISTINCT FROM NEW.venue_id OR OLD.operation IS DISTINCT FROM NEW.operation
      OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key OR OLD.request_sha256 IS DISTINCT FROM NEW.request_sha256
      OR OLD.created_by IS DISTINCT FROM NEW.created_by OR OLD.created_at IS DISTINCT FROM NEW.created_at
      OR OLD.entity_id IS NOT NULL OR NEW.entity_id IS NULL OR NEW.response IS NULL THEN
      RAISE EXCEPTION 'finance_create_idempotency_immutable' USING ERRCODE='55000';
    END IF;
  ELSIF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'finance_create_idempotency_append_only' USING ERRCODE='55000';
  END IF;
  IF NEW.entity_id IS NOT NULL AND NOT (
    (NEW.operation='payable_create' AND EXISTS(SELECT 1 FROM finance_payables WHERE venue_id=NEW.venue_id AND id=NEW.entity_id))
    OR (NEW.operation='recurring_rule_create' AND EXISTS(SELECT 1 FROM finance_recurring_rules WHERE venue_id=NEW.venue_id AND id=NEW.entity_id))
    OR (NEW.operation='recurring_rule_version_create' AND EXISTS(SELECT 1 FROM finance_recurring_rule_versions WHERE venue_id=NEW.venue_id AND id=NEW.entity_id))
    OR (NEW.operation='recurring_payable_generation' AND EXISTS(SELECT 1 FROM finance_payables WHERE venue_id=NEW.venue_id AND id=NEW.entity_id))
  ) THEN RAISE EXCEPTION 'finance_create_idempotency_entity_invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
