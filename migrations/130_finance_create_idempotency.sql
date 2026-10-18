-- Idempotent creation for manual obligations and recurring payment rules.
-- The reservation and entity are committed in the same transaction, so no incomplete
-- idempotency row can become visible after a successful commit.
CREATE TABLE IF NOT EXISTS finance_create_idempotency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (operation IN ('payable_create','recurring_rule_create')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  entity_id uuid,
  response jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,operation,idempotency_key),
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  CHECK ((entity_id IS NULL AND response IS NULL) OR (entity_id IS NOT NULL AND response IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS finance_create_idempotency_entity_idx
  ON finance_create_idempotency(venue_id,operation,entity_id);

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
  ) THEN RAISE EXCEPTION 'finance_create_idempotency_entity_invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_create_idempotency_guard ON finance_create_idempotency;
CREATE TRIGGER finance_create_idempotency_guard BEFORE INSERT OR UPDATE OR DELETE ON finance_create_idempotency
  FOR EACH ROW EXECUTE FUNCTION guard_finance_create_idempotency();
