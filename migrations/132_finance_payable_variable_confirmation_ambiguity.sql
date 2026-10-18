CREATE OR REPLACE FUNCTION validate_finance_payable_posting()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line_total numeric(14,2); category_kind text; category_active boolean; is_variable_amount boolean;
BEGIN
  IF OLD.status='draft' AND NEW.status='approved' THEN
    SELECT kind,active INTO category_kind,category_active FROM finance_categories
      WHERE venue_id=NEW.venue_id AND id=NEW.category_id FOR KEY SHARE;
    IF category_kind IS DISTINCT FROM 'expense' OR category_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'finance_payable_category_invalid' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(bool_or(v.variable_amount),false) INTO is_variable_amount
      FROM finance_recurring_rule_versions v
      WHERE v.venue_id=NEW.venue_id AND v.rule_id=NEW.recurring_rule_id AND v.id=NEW.recurring_version_id;
    IF is_variable_amount AND (NEW.variable_amount_confirmed_at IS NULL OR NEW.variable_amount_confirmed_by IS NULL) THEN
      RAISE EXCEPTION 'finance_payable_variable_amount_confirmation_required' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(SUM(amount),0)::numeric(14,2) INTO line_total
      FROM finance_payable_lines WHERE venue_id=NEW.venue_id AND payable_id=NEW.id;
    IF line_total <> NEW.total_amount THEN
      RAISE EXCEPTION 'finance_payable_lines_total_mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
