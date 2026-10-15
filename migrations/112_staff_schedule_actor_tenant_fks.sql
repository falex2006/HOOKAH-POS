-- Audit authors may belong to any venue in the same organization (owners can
-- manage sibling venues), but never to another organization.
CREATE OR REPLACE FUNCTION staff_schedule_actor_organization_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor_id uuid; actor_organization_id uuid; venue_organization_id uuid;
BEGIN
  actor_id := NULLIF(to_jsonb(NEW)->>TG_ARGV[0], '')::uuid;
  SELECT venue.organization_id, actor.organization_id
    INTO venue_organization_id, actor_organization_id
    FROM venues venue JOIN users actor ON actor.id=actor_id
    WHERE venue.id=NEW.venue_id;
  IF venue_organization_id IS NULL OR actor_organization_id IS DISTINCT FROM venue_organization_id THEN
    RAISE EXCEPTION 'staff_schedule_actor_organization_mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE item record; actor_position smallint; venue_position smallint; constraint_name text;
BEGIN
  -- These actor references are audit authors, not venue membership. A venue
  -- owner can act on sibling venues in the same organization. Keep the user
  -- existence FK and let the organization guard enforce the tenant boundary.
  FOR item IN SELECT * FROM (VALUES
    ('staff_schedule_venue_policies','created_by','staff_schedule_venue_policies_created_by_user_fk'),
    ('staff_schedule_venue_policies','updated_by','staff_schedule_venue_policies_updated_by_user_fk'),
    ('staff_schedule_venue_business_intervals','created_by','staff_schedule_venue_business_intervals_created_by_user_fk'),
    ('staff_schedule_venue_business_intervals','updated_by','staff_schedule_venue_business_intervals_updated_by_user_fk'),
    ('staff_schedule_series_exceptions','actor_id','staff_schedule_series_exceptions_actor_user_fk'),
    ('staff_schedule_demand_rules','created_by',''),
    ('staff_schedule_demand_rules','updated_by','staff_schedule_demand_rules_updated_by_user_fk')
  ) AS constraints_to_replace(table_name,actor_column,user_fk)
  LOOP
    SELECT attnum INTO venue_position FROM pg_attribute
      WHERE attrelid=format('public.%I',item.table_name)::regclass AND attname='venue_id' AND NOT attisdropped;
    SELECT attnum INTO actor_position FROM pg_attribute
      WHERE attrelid=format('public.%I',item.table_name)::regclass AND attname=item.actor_column AND NOT attisdropped;
    FOR constraint_name IN
      SELECT conname FROM pg_constraint
      WHERE conrelid=format('public.%I',item.table_name)::regclass AND contype='f'
        AND conkey=ARRAY[venue_position,actor_position]::smallint[]
    LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',item.table_name,constraint_name);
    END LOOP;
    IF item.user_fk<>'' AND NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid=format('public.%I',item.table_name)::regclass AND conname=item.user_fk
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.users(id)',item.table_name,item.user_fk,item.actor_column);
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE item record; mismatched_rows bigint;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('staff_schedule_functions','created_by','staff_schedule_functions_actor_org_guard'),
      ('staff_schedule_employee_functions','created_by','staff_schedule_employee_functions_actor_org_guard'),
      ('staff_schedule_template_bindings','created_by','staff_schedule_template_bindings_actor_org_guard'),
      ('staff_schedule_employee_defaults','created_by','staff_schedule_employee_defaults_actor_org_guard'),
      ('staff_schedule_availability_rules','created_by','staff_schedule_availability_rules_actor_org_guard'),
      ('staff_schedule_availability_exceptions','created_by','staff_schedule_availability_exceptions_actor_org_guard'),
      ('staff_schedule_series','created_by','staff_schedule_series_actor_org_guard'),
      ('staff_schedule_config_events','actor_id','staff_schedule_config_events_actor_org_guard'),
      ('staff_schedule_venue_policies','created_by','staff_schedule_venue_policies_created_by_actor_org_guard'),
      ('staff_schedule_venue_policies','updated_by','staff_schedule_venue_policies_updated_by_actor_org_guard'),
      ('staff_schedule_venue_business_intervals','created_by','staff_schedule_venue_business_intervals_created_by_actor_org_guard'),
      ('staff_schedule_venue_business_intervals','updated_by','staff_schedule_venue_business_intervals_updated_by_actor_org_guard'),
      ('staff_schedule_demand_rules','created_by','staff_schedule_demand_rules_created_by_actor_org_guard'),
      ('staff_schedule_demand_rules','updated_by','staff_schedule_demand_rules_updated_by_actor_org_guard'),
      ('staff_schedule_series_exceptions','actor_id','staff_schedule_series_exceptions_actor_org_guard')
    ) AS bindings(table_name,actor_column,trigger_name)
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM public.%I item_row JOIN public.venues venue ON venue.id=item_row.venue_id JOIN public.users actor ON actor.id=item_row.%I WHERE venue.organization_id IS DISTINCT FROM actor.organization_id',
      item.table_name,item.actor_column
    ) INTO mismatched_rows;
    IF mismatched_rows>0 THEN
      RAISE EXCEPTION 'staff_schedule_actor_organization_mismatch in %.% (% rows)',item.table_name,item.actor_column,mismatched_rows;
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I',item.trigger_name,item.table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF venue_id,%I ON public.%I FOR EACH ROW EXECUTE FUNCTION public.staff_schedule_actor_organization_guard(%L)',
      item.trigger_name,item.actor_column,item.table_name,item.actor_column
    );
  END LOOP;
END $$;
