CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM ('owner','admin','manager','senior_bartender','senior_hookah_master','bartender','hookah_master','developer','platform_owner','cleaner','security','technician','other_staff');
CREATE TYPE table_status AS ENUM ('free','occupied','reserved','awaiting_payment','blocked');
CREATE TYPE order_status AS ENUM ('open','in_progress','ready','closed','cancelled');
CREATE TYPE payment_status AS ENUM ('pending','paid','refunded','partially_paid');
CREATE TYPE discount_status AS ENUM ('requested','approved','rejected','applied','cancelled');
CREATE TYPE stock_direction AS ENUM ('in','out','transfer','adjustment','waste');

CREATE TABLE venues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  format text NOT NULL DEFAULT 'кальян-бар',
  city text,
  is_current boolean NOT NULL DEFAULT false,
  phone text,
  address text,
  logo_url text,
  timezone text NOT NULL DEFAULT 'Europe/Moscow',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  plan text NOT NULL DEFAULT 'starter' CHECK (plan IN ('starter','growth','network','enterprise')),
  timezone text NOT NULL DEFAULT 'Europe/Moscow',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE venues ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations(id);
ALTER TABLE venues ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS phone_numbers jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS logo_url text;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS format text NOT NULL DEFAULT 'кальян-бар';
ALTER TABLE venues ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT false;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid REFERENCES venues(id),
  full_name text NOT NULL,
  login text NOT NULL UNIQUE,
  password_hash text,
  pin_hash text,
  avatar_url text,
  photo_url text,
  birth_date date,
  role user_role NOT NULL,
  permission_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_url text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_date date;
ALTER TABLE users ADD COLUMN IF NOT EXISTS permission_scopes jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_data_encrypted text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_data_iv text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_data_tag text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_updated_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS contact_email text;

CREATE TABLE IF NOT EXISTS organization_memberships (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  membership_role text NOT NULL DEFAULT 'member' CHECK (membership_role IN ('owner','admin','member')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited','suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE TABLE IF NOT EXISTS organization_subscriptions (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'starter' CHECK (plan IN ('starter','growth','network','enterprise')),
  status text NOT NULL DEFAULT 'trialing' CHECK (status IN ('trialing','active','past_due','cancelled')),
  seats_limit integer NOT NULL DEFAULT 5 CHECK (seats_limit > 0),
  venues_limit integer NOT NULL DEFAULT 1 CHECK (venues_limit > 0),
  current_period_end timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  billing_mode text NOT NULL DEFAULT 'test_free' CHECK (billing_mode IN ('test_free','live')),
  monthly_price_cents integer NOT NULL DEFAULT 0 CHECK (monthly_price_cents >= 0),
  trial_ends_at timestamptz
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL DEFAULT gen_random_uuid()::text,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions (expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_auth_sessions_user_device ON auth_sessions (user_id, device_id);

CREATE TABLE zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name text NOT NULL,
  sort_order int NOT NULL DEFAULT 0
);

CREATE TABLE tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id uuid NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  name text NOT NULL,
  capacity int NOT NULL DEFAULT 2 CHECK (capacity > 0),
  status table_status NOT NULL DEFAULT 'free',
  min_deposit numeric(12,2) NOT NULL DEFAULT 0,
  min_order_total numeric(12,2) NOT NULL DEFAULT 0,
  minimum_order_start_time time,
  minimum_order_end_time time,
  layout jsonb NOT NULL DEFAULT '{}'::jsonb,
  archived_at timestamptz,
  archive_version bigint NOT NULL DEFAULT 0,
  CHECK ((minimum_order_start_time IS NULL) = (minimum_order_end_time IS NULL)),
  CHECK (minimum_order_start_time IS NULL OR minimum_order_start_time <> minimum_order_end_time)
);
CREATE INDEX IF NOT EXISTS tables_active_zone_idx ON tables (zone_id) WHERE archived_at IS NULL;

CREATE TABLE guest_discount_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  discount_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
  bonus_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (bonus_percent BETWEEN 0 AND 100),
  deposit_min numeric(12,2) NOT NULL DEFAULT 0 CHECK (deposit_min >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, id)
);
CREATE UNIQUE INDEX guest_discount_groups_venue_name_uq
  ON guest_discount_groups (venue_id, lower(name));

CREATE TABLE loyalty_program_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  bonus_ruble_rate numeric(8,4) NOT NULL DEFAULT 1 CHECK (bonus_ruble_rate > 0 AND bonus_ruble_rate <= 100),
  max_redemption_percent numeric(5,2) NOT NULL DEFAULT 100 CHECK (max_redemption_percent BETWEEN 0 AND 100),
  min_redemption_points integer NOT NULL DEFAULT 1 CHECK (min_redemption_points >= 1 AND min_redemption_points <= 1000000),
  bonus_expiration_days integer CHECK (bonus_expiration_days IS NULL OR bonus_expiration_days BETWEEN 1 AND 3650),
  created_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  effective_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,version),
  UNIQUE (venue_id,id),
  CHECK (bonus_expiration_days IS NULL)
);
CREATE INDEX loyalty_program_settings_current_idx
  ON loyalty_program_settings (venue_id,version DESC,effective_at DESC);

CREATE TABLE guests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid REFERENCES venues(id),
  phone text,
  full_name text,
  nickname text NOT NULL DEFAULT '',
  email text,
  loyalty_points int NOT NULL DEFAULT 0,
  discount_group_id uuid,
  deposit_balance numeric(12,2) NOT NULL DEFAULT 0 CHECK (deposit_balance >= 0),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guests_discount_group_fk FOREIGN KEY (venue_id, discount_group_id)
    REFERENCES guest_discount_groups (venue_id, id)
    ON DELETE SET NULL (discount_group_id),
  UNIQUE (venue_id, phone)
);
CREATE UNIQUE INDEX IF NOT EXISTS guests_venue_id_id_uq ON guests (venue_id,id);
CREATE TABLE IF NOT EXISTS guest_account_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  guest_id uuid NOT NULL REFERENCES guests(id) ON DELETE RESTRICT,
  account_type text NOT NULL CHECK (account_type IN ('bonus','deposit')),
  amount numeric(12,2) NOT NULL CHECK (amount <> 0),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  source_type text NOT NULL CHECK (source_type IN ('opening_balance','manual_adjustment','order','reservation','refund','reversal')),
  source_id uuid,
  source_key text,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (account_type <> 'bonus' OR amount = trunc(amount)),
  UNIQUE (venue_id, id),
  UNIQUE (venue_id,guest_id,id),
  UNIQUE (guest_id, account_type, source_key),
  CONSTRAINT guest_account_entries_guest_venue_fk FOREIGN KEY (venue_id,guest_id)
    REFERENCES guests (venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS guest_account_entries_guest_created_idx
  ON guest_account_entries (venue_id, guest_id, account_type, created_at DESC, id);
CREATE INDEX IF NOT EXISTS guest_account_entries_source_idx
  ON guest_account_entries (source_type, source_id) WHERE source_id IS NOT NULL;
ALTER TABLE guest_account_entries DROP CONSTRAINT IF EXISTS guest_account_entries_source_type_check;
ALTER TABLE guest_account_entries ADD CONSTRAINT guest_account_entries_source_type_check
  CHECK (source_type IN ('opening_balance','manual_adjustment','order','reservation','refund','reversal','deposit_top_up'));
ALTER TABLE guests ADD COLUMN IF NOT EXISTS phone_numbers jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS telegram text;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS tobacco_preferences text[] NOT NULL DEFAULT '{}';
ALTER TABLE guests ADD COLUMN IF NOT EXISTS bowl_preferences text[] NOT NULL DEFAULT '{}';
ALTER TABLE guests ADD COLUMN IF NOT EXISTS bar_preferences text[] NOT NULL DEFAULT '{}';
ALTER TABLE guests ADD COLUMN IF NOT EXISTS allergies text;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS loyalty_tier text NOT NULL DEFAULT 'base';

CREATE TABLE reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  table_id uuid REFERENCES tables(id),
  guest_id uuid REFERENCES guests(id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  guests_count int NOT NULL DEFAULT 1,
  deposit_required numeric(12,2) NOT NULL DEFAULT 0,
  deposit_paid numeric(12,2) NOT NULL DEFAULT 0,
  verified_deposit_paid numeric(12,2) NOT NULL DEFAULT 0 CHECK (verified_deposit_paid >= 0),
  status text NOT NULL DEFAULT 'new',
  notes text
);
CREATE UNIQUE INDEX IF NOT EXISTS reservations_venue_id_id_uq ON reservations (venue_id,id);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  name text NOT NULL,
  category text NOT NULL,
  preparation_station text CHECK (preparation_station IN ('bar','hookah')),
  sale_price numeric(12,2) NOT NULL DEFAULT 0 CHECK (sale_price >= 0),
  image_url text,
  is_active boolean NOT NULL DEFAULT true,
  search_aliases text[] NOT NULL DEFAULT '{}',
  inventory_mode text NOT NULL DEFAULT 'tracked'
    CHECK (inventory_mode IN ('tracked','non_stock','needs_review'))
);
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url text;

CREATE TABLE IF NOT EXISTS product_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, name)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_categories_active_name
  ON product_categories (venue_id, lower(name)) WHERE is_active;

CREATE TABLE ingredients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  name text NOT NULL,
  category text NOT NULL DEFAULT 'Ингредиенты',
  unit text NOT NULL,
  cost numeric(12,4) NOT NULL DEFAULT 0,
  min_stock numeric(15,6) NOT NULL DEFAULT 0,
  is_marked boolean NOT NULL DEFAULT false,
  pack_multiplier numeric(15,6) NOT NULL DEFAULT 1 CHECK (pack_multiplier > 0)
);
ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS pack_multiplier numeric(15,6) NOT NULL DEFAULT 1 CHECK (pack_multiplier > 0);
ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'Ингредиенты';

-- Alcohol is described in its own tenant-scoped catalog. Stock and recipe
-- ownership remains on ingredients; this nullable link is metadata only.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='venues_id_organization_id_uq' AND conrelid='venues'::regclass) THEN
    ALTER TABLE venues ADD CONSTRAINT venues_id_organization_id_uq UNIQUE (id,organization_id);
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS alcohol_catalog_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  scope text NOT NULL DEFAULT 'organization' CHECK (scope IN ('organization','venue')),
  venue_id uuid,
  brand text NOT NULL,
  product_line text,
  name text NOT NULL,
  spirit_type text NOT NULL,
  spirit_subtype text,
  country text,
  abv numeric(5,2) CHECK (abv IS NULL OR (abv >= 0 AND abv <= 100)),
  bottle_ml numeric(12,3) CHECK (bottle_ml IS NULL OR bottle_ml > 0),
  age_years numeric(6,2) CHECK (age_years IS NULL OR age_years >= 0),
  barcode text,
  aliases text[] NOT NULL DEFAULT '{}',
  description text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (organization_id,id),
  FOREIGN KEY (venue_id,organization_id) REFERENCES venues(id,organization_id) ON DELETE RESTRICT,
  CHECK ((scope='organization' AND venue_id IS NULL) OR (scope='venue' AND venue_id IS NOT NULL)),
  CHECK ((is_active AND archived_at IS NULL) OR (NOT is_active AND archived_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS alcohol_catalog_items_org_barcode_uq
  ON alcohol_catalog_items (organization_id,barcode) WHERE barcode IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS alcohol_catalog_items_variant_uq
  ON alcohol_catalog_items (organization_id,scope,COALESCE(venue_id,'00000000-0000-0000-0000-000000000000'::uuid),lower(brand),lower(COALESCE(product_line,'')),lower(name),spirit_type,lower(COALESCE(spirit_subtype,'')),COALESCE(bottle_ml,0))
  WHERE is_active;
ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS alcohol_catalog_item_id uuid;
UPDATE ingredients i SET organization_id=v.organization_id FROM venues v
  WHERE v.id=i.venue_id AND i.organization_id IS DISTINCT FROM v.organization_id;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM ingredients WHERE organization_id IS NULL) THEN
    RAISE EXCEPTION 'cannot add alcohol catalog: every ingredient venue must have an organization_id';
  END IF;
END $$;
ALTER TABLE ingredients ALTER COLUMN organization_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ingredients_venue_organization_fk' AND conrelid='ingredients'::regclass) THEN
    ALTER TABLE ingredients ADD CONSTRAINT ingredients_venue_organization_fk
      FOREIGN KEY (venue_id,organization_id) REFERENCES venues(id,organization_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ingredients_alcohol_catalog_org_fk' AND conrelid='ingredients'::regclass) THEN
    ALTER TABLE ingredients ADD CONSTRAINT ingredients_alcohol_catalog_org_fk
      FOREIGN KEY (organization_id,alcohol_catalog_item_id) REFERENCES alcohol_catalog_items(organization_id,id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION guard_alcohol_catalog_item_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'alcohol catalog items must be soft archived' USING ERRCODE='55000';
  END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.venue_id IS DISTINCT FROM OLD.venue_id THEN
    RAISE EXCEPTION 'alcohol catalog tenant scope is immutable' USING ERRCODE='23514';
  END IF;
  NEW.updated_at := now();
  IF NEW.is_active THEN
    NEW.archived_at := NULL;
  ELSIF OLD.is_active THEN
    NEW.archived_at := COALESCE(NEW.archived_at,now());
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS alcohol_catalog_items_identity_guard ON alcohol_catalog_items;
CREATE TRIGGER alcohol_catalog_items_identity_guard
  BEFORE UPDATE OR DELETE ON alcohol_catalog_items
  FOR EACH ROW EXECUTE FUNCTION guard_alcohol_catalog_item_identity();

CREATE OR REPLACE FUNCTION guard_ingredient_alcohol_catalog_link() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE venue_org uuid; item_org uuid; item_scope text; item_venue uuid; item_active boolean;
BEGIN
  SELECT organization_id INTO venue_org FROM venues WHERE id=NEW.venue_id FOR SHARE;
  IF NOT FOUND OR venue_org IS NULL THEN
    RAISE EXCEPTION 'ingredient venue must belong to an organization' USING ERRCODE='23514';
  END IF;
  NEW.organization_id := venue_org;
  IF TG_OP='UPDATE' AND OLD.venue_id IS DISTINCT FROM NEW.venue_id
     AND OLD.alcohol_catalog_item_id IS NOT NULL THEN
    RAISE EXCEPTION 'linked ingredient cannot be reassigned to another venue' USING ERRCODE='23514';
  END IF;
  IF NEW.alcohol_catalog_item_id IS NOT NULL THEN
    SELECT organization_id,scope,venue_id,is_active INTO item_org,item_scope,item_venue,item_active
      FROM alcohol_catalog_items WHERE id=NEW.alcohol_catalog_item_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'alcohol catalog item does not exist' USING ERRCODE='23503';
    END IF;
    IF item_org IS DISTINCT FROM venue_org THEN
      RAISE EXCEPTION 'alcohol catalog item belongs to another organization' USING ERRCODE='23514';
    END IF;
    IF item_scope='venue' AND item_venue IS DISTINCT FROM NEW.venue_id THEN
      RAISE EXCEPTION 'venue-scoped alcohol item belongs to another venue' USING ERRCODE='23514';
    END IF;
    IF NOT item_active AND (TG_OP='INSERT' OR OLD.alcohol_catalog_item_id IS DISTINCT FROM NEW.alcohol_catalog_item_id) THEN
      RAISE EXCEPTION 'inactive alcohol catalog items cannot be newly linked' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS ingredients_alcohol_catalog_link_guard ON ingredients;
CREATE TRIGGER ingredients_alcohol_catalog_link_guard
  BEFORE INSERT OR UPDATE OF venue_id,organization_id,alcohol_catalog_item_id ON ingredients
  FOR EACH ROW EXECUTE FUNCTION guard_ingredient_alcohol_catalog_link();

CREATE TABLE recipes (
  product_id uuid PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  instructions text
);
CREATE TABLE recipe_items (
  product_id uuid NOT NULL REFERENCES recipes(product_id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES ingredients(id),
  quantity numeric(15,6) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (product_id, ingredient_id)
);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  table_id uuid REFERENCES tables(id),
  reservation_id uuid REFERENCES reservations(id),
  guest_id uuid REFERENCES guests(id),
  opened_by uuid NOT NULL REFERENCES users(id),
  status order_status NOT NULL DEFAULT 'open',
  vip_minimum numeric(12,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS orders_venue_id_id_uq ON orders (venue_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS orders_venue_reservation_id_uq ON orders (venue_id,reservation_id) WHERE reservation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS orders_venue_reservation_id_triplet_uq ON orders (venue_id,reservation_id,id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_venue_reservation_fk' AND conrelid='orders'::regclass) THEN
    ALTER TABLE orders ADD CONSTRAINT orders_venue_reservation_fk
      FOREIGN KEY (venue_id,reservation_id) REFERENCES reservations (venue_id,id) ON DELETE RESTRICT;
  END IF;
END $$;

-- Documentary, append-only review of legacy reservation deposit_paid values.
-- This table is never a cash receipt and never changes verified guest funds.
CREATE TABLE IF NOT EXISTS reservation_legacy_deposit_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  legacy_amount_snapshot numeric(12,2) NOT NULL CHECK (legacy_amount_snapshot > 0),
  sequence integer NOT NULL CHECK (sequence > 0),
  disposition text NOT NULL CHECK (disposition IN ('unreviewed','documents_found','documents_not_found','disputed')),
  review_note text NOT NULL CHECK (length(btrim(review_note)) BETWEEN 1 AND 500),
  evidence_reference text NOT NULL DEFAULT '' CHECK (length(evidence_reference) <= 250),
  supersedes_id uuid,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  actor_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,idempotency_key), UNIQUE (venue_id,reservation_id,sequence), UNIQUE (venue_id,supersedes_id), UNIQUE (venue_id,reservation_id,id),
  FOREIGN KEY (venue_id,reservation_id) REFERENCES reservations (venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,reservation_id,supersedes_id) REFERENCES reservation_legacy_deposit_reviews (venue_id,reservation_id,id) ON DELETE RESTRICT,
  CHECK (disposition <> 'documents_found' OR length(btrim(evidence_reference)) > 0),
  CHECK ((sequence=1 AND supersedes_id IS NULL) OR (sequence>1 AND supersedes_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS reservation_legacy_deposit_reviews_head_idx ON reservation_legacy_deposit_reviews (venue_id,reservation_id,sequence DESC);
CREATE OR REPLACE FUNCTION guard_reservation_legacy_deposit_review_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owning_reservation_exists boolean;
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'legacy reservation deposit review history is immutable' USING ERRCODE='55000'; END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.reservations WHERE id=$1 AND venue_id=$2)',TG_TABLE_SCHEMA) INTO owning_reservation_exists USING OLD.reservation_id,OLD.venue_id;
  IF owning_reservation_exists THEN RAISE EXCEPTION 'legacy reservation deposit review history is immutable' USING ERRCODE='55000'; END IF;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS reservation_legacy_deposit_reviews_immutable ON reservation_legacy_deposit_reviews;
CREATE TRIGGER reservation_legacy_deposit_reviews_immutable BEFORE UPDATE OR DELETE ON reservation_legacy_deposit_reviews FOR EACH ROW EXECUTE FUNCTION guard_reservation_legacy_deposit_review_history();
INSERT INTO reservation_legacy_deposit_reviews
  (venue_id,reservation_id,legacy_amount_snapshot,sequence,disposition,review_note,evidence_reference,idempotency_key)
SELECT venue_id,id,deposit_paid,1,'unreviewed','Исходная сумма прежней системы; получение денег не подтверждено.','','baseline:'||id::text
FROM reservations WHERE deposit_paid>0 ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION seed_reservation_legacy_deposit_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head reservation_legacy_deposit_reviews%ROWTYPE;
        next_sequence integer;
BEGIN
  IF NEW.deposit_paid<=0 THEN RETURN NEW; END IF;
  SELECT * INTO head FROM reservation_legacy_deposit_reviews WHERE venue_id=NEW.venue_id AND reservation_id=NEW.id ORDER BY sequence DESC LIMIT 1;
  IF NOT FOUND THEN next_sequence:=1;
  ELSIF head.legacy_amount_snapshot=NEW.deposit_paid THEN RETURN NEW;
  ELSE next_sequence:=head.sequence+1;
  END IF;
  INSERT INTO reservation_legacy_deposit_reviews (venue_id,reservation_id,legacy_amount_snapshot,sequence,disposition,review_note,evidence_reference,supersedes_id,idempotency_key)
  VALUES (NEW.venue_id,NEW.id,NEW.deposit_paid,next_sequence,'unreviewed','Исходная сумма прежней системы; получение денег не подтверждено.','',CASE WHEN next_sequence=1 THEN NULL ELSE head.id END,'baseline:'||NEW.id::text||':'||next_sequence::text)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS reservations_legacy_deposit_review_seed ON reservations;
CREATE TRIGGER reservations_legacy_deposit_review_seed AFTER INSERT OR UPDATE OF deposit_paid ON reservations FOR EACH ROW EXECUTE FUNCTION seed_reservation_legacy_deposit_review();
ALTER TABLE orders ADD COLUMN IF NOT EXISTS loyalty_bonus_percent numeric(5,2) CHECK (loyalty_bonus_percent BETWEEN 0 AND 100);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS loyalty_bonus_base numeric(12,2) CHECK (loyalty_bonus_base >= 0);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS loyalty_bonus_earned int CHECK (loyalty_bonus_earned >= 0);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS loyalty_redemption_policy_version integer;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS loyalty_redemption_rate numeric(8,4);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS loyalty_redemption_cap_percent numeric(5,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS loyalty_redemption_min_points integer;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS loyalty_redemption_base numeric(12,2);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_loyalty_redemption_snapshot_check' AND conrelid='orders'::regclass) THEN
    ALTER TABLE orders ADD CONSTRAINT orders_loyalty_redemption_snapshot_check CHECK (
      (loyalty_redemption_policy_version IS NULL AND loyalty_redemption_rate IS NULL AND loyalty_redemption_cap_percent IS NULL AND loyalty_redemption_min_points IS NULL AND loyalty_redemption_base IS NULL)
      OR (loyalty_redemption_policy_version IS NOT NULL AND loyalty_redemption_policy_version >= 0 AND loyalty_redemption_rate IS NOT NULL AND loyalty_redemption_rate > 0 AND loyalty_redemption_cap_percent BETWEEN 0 AND 100 AND loyalty_redemption_min_points >= 1 AND (loyalty_redemption_base IS NULL OR loyalty_redemption_base >= 0))
    );
  END IF;
END $$;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS group_discount_group_id uuid;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS group_discount_name text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS group_discount_percent numeric(5,2) CHECK (group_discount_percent BETWEEN 0 AND 100);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS group_discount_base numeric(12,2) CHECK (group_discount_base >= 0);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS group_discount_amount numeric(12,2) CHECK (group_discount_amount >= 0 AND group_discount_amount <= group_discount_base);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS effective_discount_source text CHECK (effective_discount_source IN ('none','guest_group','manual'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal_snapshot numeric(12,2) CHECK (subtotal_snapshot >= 0);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_total_snapshot numeric(12,2) CHECK (discount_total_snapshot >= 0);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS minimum_adjustment_snapshot numeric(12,2) CHECK (minimum_adjustment_snapshot >= 0);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS final_total_snapshot numeric(12,2) CHECK (final_total_snapshot >= 0);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pricing_version smallint CHECK (pricing_version > 0);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pricing_locked_at timestamptz;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_group_discount_amount_check;
ALTER TABLE orders ADD CONSTRAINT orders_group_discount_amount_check CHECK ((group_discount_base IS NULL AND group_discount_amount IS NULL) OR (group_discount_base IS NOT NULL AND group_discount_amount IS NOT NULL AND group_discount_base >= 0 AND group_discount_amount >= 0 AND group_discount_amount <= group_discount_base));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS notes text;
CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  quantity numeric(12,3) NOT NULL CHECK (quantity > 0),
  unit_price numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  station text,
  status text NOT NULL DEFAULT 'new',
  guest_number int,
  sales_employee_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  sold_at timestamptz,
  CHECK ((sales_employee_id IS NULL AND sold_at IS NULL) OR (sales_employee_id IS NOT NULL AND sold_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS order_item_execution (
  order_item_id uuid PRIMARY KEY REFERENCES order_items(id) ON DELETE CASCADE,
  station text CHECK (station IN ('bar','hookah')),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','queued','in_progress','ready')),
  dispatched_at timestamptz,
  started_at timestamptz,
  ready_at timestamptz
);
CREATE INDEX IF NOT EXISTS order_item_execution_station_status_idx ON order_item_execution(station,status);

CREATE OR REPLACE FUNCTION validate_order_item_sales_attribution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_venue_id uuid; order_organization_id uuid; employee_venue_id uuid; employee_organization_id uuid;
BEGIN
  IF NEW.sales_employee_id IS NULL THEN RETURN NEW; END IF;
  SELECT o.venue_id,v.organization_id INTO order_venue_id,order_organization_id
    FROM orders o JOIN venues v ON v.id=o.venue_id WHERE o.id=NEW.order_id;
  SELECT u.venue_id,u.organization_id INTO employee_venue_id,employee_organization_id
    FROM users u WHERE u.id=NEW.sales_employee_id AND u.is_active=true AND u.deleted_at IS NULL;
  IF order_venue_id IS NULL OR employee_venue_id IS NULL
      OR (employee_venue_id IS DISTINCT FROM order_venue_id
        AND (order_organization_id IS NULL OR (employee_organization_id IS DISTINCT FROM order_organization_id
          AND NOT EXISTS (SELECT 1 FROM organization_memberships m WHERE m.organization_id=order_organization_id AND m.user_id=NEW.sales_employee_id AND m.status='active')))) THEN
    RAISE EXCEPTION 'order_item_sales_employee_venue_mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS order_items_sales_attribution_validate ON order_items;
CREATE TRIGGER order_items_sales_attribution_validate
  BEFORE INSERT OR UPDATE OF order_id,sales_employee_id,sold_at ON order_items
  FOR EACH ROW EXECUTE FUNCTION validate_order_item_sales_attribution();

CREATE TABLE discounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  requested_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  type text NOT NULL CHECK (type IN ('percent','fixed')),
  value numeric(12,2) NOT NULL CHECK (value >= 0),
  reason text NOT NULL,
  status discount_status NOT NULL DEFAULT 'requested',
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  method text NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  status payment_status NOT NULL DEFAULT 'pending',
  external_id text,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS payments_order_id_id_uq ON payments (order_id,id);
CREATE INDEX IF NOT EXISTS idx_payments_order_status ON payments (order_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS payments_order_idempotency_key_uq
  ON payments (order_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_bonus_whole_points_check;
ALTER TABLE payments ADD CONSTRAINT payments_bonus_whole_points_check CHECK (method <> 'bonus' OR amount = trunc(amount));

CREATE TABLE stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  ingredient_id uuid NOT NULL REFERENCES ingredients(id),
  direction stock_direction NOT NULL,
  quantity numeric(15,6) NOT NULL CHECK (quantity > 0),
  reason text,
  order_id uuid REFERENCES orders(id),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS inventory_auto_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'partially_received', 'received', 'cancelled')),
  lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  note text,
  total_estimate numeric(12,2) NOT NULL DEFAULT 0,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inventory_auto_orders_venue_idx ON inventory_auto_orders(venue_id, created_at DESC);
CREATE TABLE shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  opened_by uuid NOT NULL REFERENCES users(id),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  opening_cash numeric(12,2) NOT NULL DEFAULT 0,
  closing_cash numeric(12,2)
);
CREATE UNIQUE INDEX IF NOT EXISTS shifts_venue_id_id_uq ON shifts (venue_id,id);

CREATE TABLE IF NOT EXISTS shift_close_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  shift_id uuid NOT NULL,
  schema_version smallint NOT NULL DEFAULT 1 CHECK (schema_version=1),
  checklist_version smallint NOT NULL DEFAULT 1 CHECK (checklist_version=1),
  snapshot_payload jsonb NOT NULL CHECK (jsonb_typeof(snapshot_payload)='object'),
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  closed_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  captured_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shift_close_snapshots_one_per_shift UNIQUE (venue_id,shift_id),
  CONSTRAINT shift_close_snapshots_shift_fk FOREIGN KEY (venue_id,shift_id)
    REFERENCES shifts(venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS shift_close_snapshots_venue_captured_idx
  ON shift_close_snapshots (venue_id,captured_at DESC,id DESC);

CREATE OR REPLACE FUNCTION guard_shift_close_snapshot_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'shift close snapshots are immutable' USING ERRCODE='55000';
END;
$$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='shift_close_snapshots_immutable' AND tgrelid='shift_close_snapshots'::regclass) THEN
    CREATE TRIGGER shift_close_snapshots_immutable
      BEFORE UPDATE OR DELETE ON shift_close_snapshots
      FOR EACH ROW EXECUTE FUNCTION guard_shift_close_snapshot_immutable();
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS reservations_venue_id_id_uq ON reservations (venue_id,id);

CREATE TABLE IF NOT EXISTS reservation_pre_payment_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  payment_method text NOT NULL CHECK (payment_method IN ('cash','card','qr')),
  reason text NOT NULL DEFAULT 'Предоплата по бронированию' CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,idempotency_key),
  UNIQUE (venue_id,id),
  FOREIGN KEY (venue_id,reservation_id) REFERENCES reservations (venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,shift_id) REFERENCES shifts (venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS reservation_pre_payment_receipts_booking_idx
  ON reservation_pre_payment_receipts (venue_id,reservation_id,created_at,id);
CREATE INDEX IF NOT EXISTS reservation_pre_payment_receipts_shift_cash_idx
  ON reservation_pre_payment_receipts (venue_id,shift_id,created_at) WHERE payment_method='cash';
CREATE UNIQUE INDEX IF NOT EXISTS reservation_pre_payment_receipts_venue_reservation_id_uq ON reservation_pre_payment_receipts (venue_id,reservation_id,id);

CREATE TABLE IF NOT EXISTS reservation_pre_payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  order_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,idempotency_key),
  UNIQUE (venue_id,id),
  FOREIGN KEY (venue_id,reservation_id) REFERENCES reservations (venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,receipt_id) REFERENCES reservation_pre_payment_receipts (venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,order_id) REFERENCES orders (venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (order_id,payment_id) REFERENCES payments (order_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,shift_id) REFERENCES shifts (venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,reservation_id,receipt_id) REFERENCES reservation_pre_payment_receipts (venue_id,reservation_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,reservation_id,order_id) REFERENCES orders (venue_id,reservation_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS reservation_pre_payment_allocations_receipt_idx
  ON reservation_pre_payment_allocations (venue_id,receipt_id,created_at,id);
CREATE INDEX IF NOT EXISTS reservation_pre_payment_allocations_order_idx
  ON reservation_pre_payment_allocations (venue_id,order_id,created_at,id);
CREATE UNIQUE INDEX IF NOT EXISTS reservation_pre_payment_allocations_venue_reservation_id_uq ON reservation_pre_payment_allocations (venue_id,reservation_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS reservation_pre_payment_allocations_venue_order_id_uq ON reservation_pre_payment_allocations (venue_id,order_id,id);
CREATE TABLE IF NOT EXISTS reservation_pre_payment_allocation_reversals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),venue_id uuid NOT NULL,reservation_id uuid NOT NULL,allocation_id uuid NOT NULL,order_id uuid NOT NULL,payment_id uuid NOT NULL,shift_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE (venue_id,idempotency_key),UNIQUE (venue_id,allocation_id),UNIQUE (venue_id,id),
  FOREIGN KEY (venue_id,reservation_id,allocation_id) REFERENCES reservation_pre_payment_allocations (venue_id,reservation_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,reservation_id,order_id) REFERENCES orders (venue_id,reservation_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (order_id,payment_id) REFERENCES payments (order_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,shift_id) REFERENCES shifts (venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS reservation_pre_payment_allocation_reversals_order_idx ON reservation_pre_payment_allocation_reversals (venue_id,order_id,created_at,id);
CREATE TABLE IF NOT EXISTS reservation_pre_payment_receipt_reversals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),venue_id uuid NOT NULL,reservation_id uuid NOT NULL,receipt_id uuid NOT NULL,shift_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),payout_method text NOT NULL CHECK (payout_method IN ('cash','card','qr')),reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE (venue_id,idempotency_key),UNIQUE (venue_id,id),
  FOREIGN KEY (venue_id,reservation_id,receipt_id) REFERENCES reservation_pre_payment_receipts (venue_id,reservation_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,shift_id) REFERENCES shifts (venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS reservation_pre_payment_receipt_reversals_receipt_idx ON reservation_pre_payment_receipt_reversals (venue_id,receipt_id,created_at,id);
CREATE INDEX IF NOT EXISTS reservation_pre_payment_receipt_reversals_shift_idx ON reservation_pre_payment_receipt_reversals (venue_id,shift_id,created_at) WHERE payout_method='cash';
CREATE TABLE IF NOT EXISTS guest_deposit_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  guest_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  payment_method text NOT NULL CHECK (payment_method IN ('cash','card','qr')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,idempotency_key),
  UNIQUE (venue_id,id),
  FOREIGN KEY (venue_id,guest_id) REFERENCES guests (venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,shift_id) REFERENCES shifts (venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS guest_deposit_receipts_guest_created_idx
  ON guest_deposit_receipts (venue_id,guest_id,created_at DESC,id);
CREATE INDEX IF NOT EXISTS guest_deposit_receipts_shift_cash_idx
  ON guest_deposit_receipts (venue_id,shift_id,created_at) WHERE payment_method='cash';
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid REFERENCES venues(id),
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS notification_reads (
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_key text NOT NULL CHECK (length(notification_key) BETWEEN 1 AND 180),
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venue_id, user_id, notification_key)
);
CREATE INDEX IF NOT EXISTS notification_reads_user_venue_read_at_idx
  ON notification_reads (user_id, venue_id, read_at DESC);
CREATE TABLE integration_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid REFERENCES venues(id),
  provider text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'disabled',
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_table_status ON orders(table_id, status);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_stock_ingredient_time ON stock_movements(ingredient_id, created_at);
CREATE INDEX idx_audit_entity_time ON audit_events(entity_type, entity_id, created_at);

-- Операционные индексы для CRM
CREATE INDEX IF NOT EXISTS idx_orders_venue_status ON orders (venue_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_table_open ON orders (table_id, status) WHERE status IN ('open');
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_ingredient_time ON stock_movements (ingredient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_venue_time ON audit_events (venue_id, created_at DESC);

CREATE TABLE IF NOT EXISTS finance_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  kind text NOT NULL CHECK (kind IN ('income','expense')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS finance_categories_active_name_uq
  ON finance_categories (venue_id, kind, lower(name)) WHERE active=true;

-- Delivery records belong to a venue and survive application restarts.
CREATE TABLE IF NOT EXISTS deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  customer_name text NOT NULL CHECK (char_length(customer_name) BETWEEN 1 AND 120),
  phone text NOT NULL DEFAULT '',
  address text NOT NULL CHECK (char_length(address) BETWEEN 1 AND 500),
  comment text NOT NULL DEFAULT '' CHECK (char_length(comment) <= 500),
  total numeric(14,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  payment_method text NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash','card','qr')),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','confirmed','in_delivery','delivered','cancelled')),
  courier text NOT NULL DEFAULT '' CHECK (char_length(courier) <= 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deliveries_venue_created_idx ON deliveries(venue_id,created_at DESC,id);

-- Informational tobacco catalog; inventory quantities and prices remain venue-scoped.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='venues_id_organization_unique' AND conrelid='venues'::regclass) THEN
    ALTER TABLE venues ADD CONSTRAINT venues_id_organization_unique UNIQUE (id, organization_id);
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS tobacco_catalog_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('organization','venue')),
  venue_id uuid,
  brand text NOT NULL,
  product_line text,
  flavor text NOT NULL,
  product_type text NOT NULL DEFAULT 'tobacco' CHECK (product_type IN ('tobacco','tobacco_free')),
  package_grams numeric(10,3) CHECK (package_grams IS NULL OR package_grams > 0),
  strength text,
  country text,
  leaf_type text,
  barcode text,
  aliases text[] NOT NULL DEFAULT '{}',
  description text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tobacco_catalog_scope_owner_check CHECK (
    (scope='organization' AND venue_id IS NULL) OR
    (scope='venue' AND venue_id IS NOT NULL)
  ),
  CONSTRAINT tobacco_catalog_venue_organization_fk FOREIGN KEY (venue_id, organization_id)
    REFERENCES venues(id, organization_id) ON DELETE CASCADE,
  CONSTRAINT tobacco_catalog_brand_length CHECK (length(btrim(brand)) BETWEEN 1 AND 120),
  CONSTRAINT tobacco_catalog_flavor_length CHECK (length(btrim(flavor)) BETWEEN 1 AND 160),
  CONSTRAINT tobacco_catalog_line_length CHECK (product_line IS NULL OR length(btrim(product_line)) <= 120),
  CONSTRAINT tobacco_catalog_description_length CHECK (length(description) <= 1200)
);
CREATE INDEX IF NOT EXISTS tobacco_catalog_org_active_idx
  ON tobacco_catalog_items (organization_id, is_active, brand, flavor) WHERE scope='organization';
CREATE INDEX IF NOT EXISTS tobacco_catalog_venue_active_idx
  ON tobacco_catalog_items (organization_id, venue_id, is_active, brand, flavor) WHERE scope='venue';
CREATE INDEX IF NOT EXISTS tobacco_catalog_barcode_idx
  ON tobacco_catalog_items (organization_id, barcode) WHERE barcode IS NOT NULL AND is_active=true;
CREATE UNIQUE INDEX IF NOT EXISTS tobacco_catalog_org_variant_unique
  ON tobacco_catalog_items (organization_id, lower(btrim(brand)), lower(btrim(COALESCE(product_line,''))), lower(btrim(flavor)), product_type, COALESCE(package_grams,0))
  WHERE scope='organization' AND is_active=true;
CREATE UNIQUE INDEX IF NOT EXISTS tobacco_catalog_venue_variant_unique
  ON tobacco_catalog_items (organization_id, venue_id, lower(btrim(brand)), lower(btrim(COALESCE(product_line,''))), lower(btrim(flavor)), product_type, COALESCE(package_grams,0))
  WHERE scope='venue' AND is_active=true;

CREATE TABLE IF NOT EXISTS inventory_deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('department','subdepartment','category')),
  entity_id text NOT NULL,
  entity_name text NOT NULL,
  parent_name text,
  reason text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_by_name text NOT NULL DEFAULT '',
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_by_name text NOT NULL DEFAULT '',
  decided_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_deletion_requests_pending_entity_uq
  ON inventory_deletion_requests (venue_id, entity_type, entity_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS inventory_deletion_requests_venue_status_idx
  ON inventory_deletion_requests (venue_id, status, requested_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS orders_venue_guest_id_uq ON orders(venue_id,guest_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS guest_account_entries_venue_guest_id_uq ON guest_account_entries(venue_id,guest_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS guest_account_entries_venue_guest_type_id_uq ON guest_account_entries(venue_id,guest_id,account_type,id);
CREATE TABLE IF NOT EXISTS guest_account_reversals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  guest_id uuid NOT NULL,
  source_entry_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  account_type text NOT NULL CHECK (account_type IN ('bonus','deposit')),
  amount numeric(12,2) NOT NULL CHECK (amount > 0 AND (account_type <> 'bonus' OR amount=trunc(amount))),
  payout_method text NOT NULL CHECK (payout_method IN ('wallet','cash','card','qr','clawback')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,idempotency_key),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,guest_id,id),
  CHECK ((account_type='bonus' AND payout_method IN ('wallet','clawback') OR account_type='deposit' AND payout_method IN ('wallet','cash','card','qr'))),
  FOREIGN KEY (venue_id,guest_id) REFERENCES guests (venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,guest_id,account_type,source_entry_id) REFERENCES guest_account_entries (venue_id,guest_id,account_type,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,shift_id) REFERENCES shifts (venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS guest_account_reversals_source_idx ON guest_account_reversals (venue_id,source_entry_id,created_at,id);
CREATE INDEX IF NOT EXISTS guest_account_reversals_shift_idx ON guest_account_reversals (venue_id,shift_id,created_at);

-- Immutable positive rows create a bonus hold; negative rows release it
-- against a future award. Outstanding liability is derived by summing entries.
CREATE TABLE IF NOT EXISTS guest_bonus_clawback_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  guest_id uuid NOT NULL,
  reversal_id uuid NOT NULL,
  order_id uuid,
  amount integer NOT NULL CHECK (amount <> 0),
  source_key text NOT NULL CHECK (length(source_key) BETWEEN 8 AND 160),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,source_key),
  UNIQUE (venue_id,id),
  FOREIGN KEY (venue_id,guest_id) REFERENCES guests (venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,guest_id,reversal_id) REFERENCES guest_account_reversals (venue_id,guest_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,guest_id,order_id) REFERENCES orders (venue_id,guest_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS guest_bonus_clawback_entries_guest_idx ON guest_bonus_clawback_entries (venue_id,guest_id,created_at,id);
-- Venue-scoped immutable versions for configurable promotions. No row is active by default.
CREATE UNIQUE INDEX IF NOT EXISTS products_venue_id_id_uq ON products (venue_id,id);

CREATE TABLE IF NOT EXISTS loyalty_promotions (
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  promotion_id uuid NOT NULL DEFAULT gen_random_uuid(),
  version integer NOT NULL CHECK (version > 0),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  timezone text NOT NULL CHECK (length(timezone) BETWEEN 1 AND 80),
  benefit_kind text NOT NULL CHECK (benefit_kind IN ('percent','fixed')),
  benefit_value numeric(10,2) NOT NULL CHECK (benefit_value > 0 AND benefit_value <= 1000000),
  priority integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100000 AND 100000),
  created_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venue_id,promotion_id,version),
  CHECK (ends_at > starts_at),
  CHECK (benefit_kind <> 'percent' OR benefit_value <= 100)
);

CREATE INDEX IF NOT EXISTS loyalty_promotions_latest_idx
  ON loyalty_promotions (venue_id,promotion_id,version DESC);
CREATE INDEX IF NOT EXISTS loyalty_promotions_active_period_idx
  ON loyalty_promotions (venue_id,status,starts_at,ends_at);

CREATE TABLE IF NOT EXISTS loyalty_promotion_scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  promotion_id uuid NOT NULL,
  version integer NOT NULL,
  scope_kind text NOT NULL CHECK (scope_kind IN ('include_product','exclude_product','include_category','exclude_category')),
  product_id uuid,
  category_name text,
  FOREIGN KEY (venue_id,promotion_id,version)
    REFERENCES loyalty_promotions (venue_id,promotion_id,version) ON DELETE CASCADE,
  CONSTRAINT loyalty_promotion_scopes_venue_id_product_id_fkey
    FOREIGN KEY (venue_id,product_id)
    REFERENCES products (venue_id,id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CHECK (
    (scope_kind IN ('include_product','exclude_product') AND product_id IS NOT NULL AND category_name IS NULL)
    OR (scope_kind IN ('include_category','exclude_category') AND product_id IS NULL AND length(btrim(category_name)) BETWEEN 1 AND 80)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS loyalty_promotion_scopes_unique_idx
  ON loyalty_promotion_scopes (venue_id,promotion_id,version,scope_kind,product_id,category_name) NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS loyalty_promotion_scopes_product_idx
  ON loyalty_promotion_scopes (venue_id,product_id) WHERE product_id IS NOT NULL;

CREATE OR REPLACE FUNCTION guard_loyalty_immutable_history() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owning_venue_exists boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'loyalty history is immutable' USING ERRCODE = '55000';
  END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.venues WHERE id = $1)', TG_TABLE_SCHEMA)
    INTO owning_venue_exists USING OLD.venue_id;
  IF owning_venue_exists THEN
    RAISE EXCEPTION 'loyalty history is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS loyalty_program_settings_immutable ON loyalty_program_settings;
CREATE TRIGGER loyalty_program_settings_immutable BEFORE UPDATE OR DELETE ON loyalty_program_settings
  FOR EACH ROW EXECUTE FUNCTION guard_loyalty_immutable_history();
DROP TRIGGER IF EXISTS loyalty_promotions_immutable ON loyalty_promotions;
CREATE TRIGGER loyalty_promotions_immutable BEFORE UPDATE OR DELETE ON loyalty_promotions
  FOR EACH ROW EXECUTE FUNCTION guard_loyalty_immutable_history();
DROP TRIGGER IF EXISTS loyalty_promotion_scopes_immutable ON loyalty_promotion_scopes;
CREATE TRIGGER loyalty_promotion_scopes_immutable BEFORE UPDATE OR DELETE ON loyalty_promotion_scopes
  FOR EACH ROW EXECUTE FUNCTION guard_loyalty_immutable_history();

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS selected_promotion_id uuid,
  ADD COLUMN IF NOT EXISTS selected_promotion_version integer,
  ADD COLUMN IF NOT EXISTS selected_promotion_name text,
  ADD COLUMN IF NOT EXISTS selected_promotion_benefit_kind text,
  ADD COLUMN IF NOT EXISTS selected_promotion_benefit_value numeric(10,2),
  ADD COLUMN IF NOT EXISTS selected_promotion_basis numeric(12,2),
  ADD COLUMN IF NOT EXISTS selected_promotion_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS pricing_offers_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_effective_discount_source_check;
ALTER TABLE orders ADD CONSTRAINT orders_effective_discount_source_check CHECK (effective_discount_source IN ('none','guest_group','manual','promotion'));
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_selected_promotion_version_fk' AND conrelid='orders'::regclass) THEN
    ALTER TABLE orders ADD CONSTRAINT orders_selected_promotion_version_fk FOREIGN KEY (venue_id,selected_promotion_id,selected_promotion_version) REFERENCES loyalty_promotions (venue_id,promotion_id,version) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_promotion_pricing_snapshot_check' AND conrelid='orders'::regclass) THEN
    ALTER TABLE orders ADD CONSTRAINT orders_promotion_pricing_snapshot_check CHECK (
      (selected_promotion_id IS NULL AND selected_promotion_version IS NULL AND selected_promotion_name IS NULL AND selected_promotion_benefit_kind IS NULL AND selected_promotion_benefit_value IS NULL AND selected_promotion_basis IS NULL AND selected_promotion_amount IS NULL)
      OR (selected_promotion_id IS NOT NULL AND selected_promotion_version > 0 AND length(btrim(selected_promotion_name)) > 0 AND selected_promotion_benefit_kind IN ('percent','fixed') AND selected_promotion_benefit_value > 0 AND selected_promotion_basis >= 0 AND selected_promotion_amount >= 0 AND selected_promotion_amount <= selected_promotion_basis)
    );
  END IF;
END $$;
-- Canonical immutable line pricing evidence created by the first tender or direct close.
CREATE TABLE IF NOT EXISTS pos_order_pricing_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version=1),
  policy_version integer NOT NULL DEFAULT 1 CHECK (policy_version=1),
  currency_code text NOT NULL DEFAULT 'RUB' CHECK (currency_code='RUB'),
  currency_scale smallint NOT NULL DEFAULT 2 CHECK (currency_scale=2),
  sold_at timestamptz NOT NULL,
  transaction_at timestamptz NOT NULL DEFAULT now(),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor>=0),
  discount_minor bigint NOT NULL CHECK (discount_minor>=0 AND discount_minor<=subtotal_minor),
  minimum_adjustment_minor bigint NOT NULL CHECK (minimum_adjustment_minor>=0),
  final_total_minor bigint NOT NULL CHECK (final_total_minor=subtotal_minor-discount_minor+minimum_adjustment_minor),
  discount_source text NOT NULL CHECK (discount_source IN ('none','manual','guest_group','promotion')),
  winner_source_id text,
  winner_source_ids uuid[] NOT NULL DEFAULT '{}',
  winner_terms jsonb NOT NULL DEFAULT '{}'::jsonb,
  eligible_item_ids uuid[] NOT NULL DEFAULT '{}',
  frozen_terms jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (venue_id,order_id),
  UNIQUE (venue_id,id,order_id),
  FOREIGN KEY (venue_id,order_id) REFERENCES orders(venue_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS order_items_order_id_id_uq ON order_items(order_id,id);
CREATE TABLE IF NOT EXISTS pos_order_pricing_snapshot_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  order_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  seller_id uuid,
  sold_at timestamptz,
  quantity numeric(12,3) NOT NULL CHECK(quantity>0),
  unit_price numeric(12,2) NOT NULL CHECK(unit_price>=0),
  gross_minor bigint NOT NULL CHECK(gross_minor>=0),
  discount_minor bigint NOT NULL CHECK(discount_minor>=0 AND discount_minor<=gross_minor),
  net_minor bigint NOT NULL CHECK(net_minor=gross_minor-discount_minor),
  eligible boolean NOT NULL DEFAULT false,
  product_facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(snapshot_id,order_item_id),
  FOREIGN KEY(venue_id,snapshot_id,order_id) REFERENCES pos_order_pricing_snapshots(venue_id,id,order_id) ON DELETE RESTRICT,
  FOREIGN KEY(order_id,order_item_id) REFERENCES order_items(order_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(seller_id) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS pos_order_pricing_snapshot_lines_item_idx ON pos_order_pricing_snapshot_lines(order_id,order_item_id);

CREATE OR REPLACE FUNCTION validate_pos_order_pricing_snapshot_line_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_item record; source_product record;
BEGIN
  SELECT oi.*,o.venue_id AS source_venue_id INTO source_item
    FROM order_items oi JOIN orders o ON o.id=oi.order_id
    WHERE oi.order_id=NEW.order_id AND oi.id=NEW.order_item_id;
  IF NOT FOUND OR source_item.source_venue_id IS DISTINCT FROM NEW.venue_id THEN
    RAISE EXCEPTION 'pos_order_pricing_snapshot_line_source_missing_or_tenant_mismatch' USING ERRCODE='23514';
  END IF;
  SELECT p.* INTO source_product FROM products p
    WHERE p.id=source_item.product_id AND p.venue_id=NEW.venue_id;
  IF NOT FOUND
      OR NEW.quantity IS DISTINCT FROM source_item.quantity
      OR NEW.unit_price IS DISTINCT FROM source_item.unit_price
      OR NEW.seller_id IS DISTINCT FROM source_item.sales_employee_id
      OR NEW.sold_at IS DISTINCT FROM source_item.sold_at
      OR NEW.product_facts->>'productId' IS DISTINCT FROM source_item.product_id::text
      OR NEW.product_facts->>'productName' IS DISTINCT FROM source_product.name
      OR NEW.product_facts->>'category' IS DISTINCT FROM source_product.category
      OR NEW.product_facts->'productActive' IS DISTINCT FROM to_jsonb(source_product.is_active)
      OR NEW.product_facts->>'station' IS DISTINCT FROM source_item.station THEN
    RAISE EXCEPTION 'pos_order_pricing_snapshot_line_source_mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pos_order_pricing_snapshot_line_source_validate ON pos_order_pricing_snapshot_lines;
CREATE TRIGGER pos_order_pricing_snapshot_line_source_validate BEFORE INSERT ON pos_order_pricing_snapshot_lines FOR EACH ROW EXECUTE FUNCTION validate_pos_order_pricing_snapshot_line_source();

CREATE OR REPLACE FUNCTION guard_pos_order_pricing_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'pos_order_pricing_snapshot_immutable' USING ERRCODE='55000'; END $$;
DROP TRIGGER IF EXISTS pos_order_pricing_snapshot_immutable ON pos_order_pricing_snapshots;
CREATE TRIGGER pos_order_pricing_snapshot_immutable BEFORE UPDATE OR DELETE ON pos_order_pricing_snapshots FOR EACH ROW EXECUTE FUNCTION guard_pos_order_pricing_snapshot_immutable();
DROP TRIGGER IF EXISTS pos_order_pricing_snapshot_no_truncate ON pos_order_pricing_snapshots;
CREATE TRIGGER pos_order_pricing_snapshot_no_truncate BEFORE TRUNCATE ON pos_order_pricing_snapshots FOR EACH STATEMENT EXECUTE FUNCTION guard_pos_order_pricing_snapshot_immutable();
DROP TRIGGER IF EXISTS pos_order_pricing_snapshot_lines_immutable ON pos_order_pricing_snapshot_lines;
CREATE TRIGGER pos_order_pricing_snapshot_lines_immutable BEFORE UPDATE OR DELETE ON pos_order_pricing_snapshot_lines FOR EACH ROW EXECUTE FUNCTION guard_pos_order_pricing_snapshot_immutable();
DROP TRIGGER IF EXISTS pos_order_pricing_snapshot_lines_no_truncate ON pos_order_pricing_snapshot_lines;
CREATE TRIGGER pos_order_pricing_snapshot_lines_no_truncate BEFORE TRUNCATE ON pos_order_pricing_snapshot_lines FOR EACH STATEMENT EXECUTE FUNCTION guard_pos_order_pricing_snapshot_immutable();

CREATE OR REPLACE FUNCTION guard_pos_order_item_after_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP='UPDATE' AND (EXISTS (SELECT 1 FROM pos_order_pricing_snapshots s WHERE s.order_id=OLD.order_id) OR EXISTS (SELECT 1 FROM pos_order_pricing_snapshots s WHERE s.order_id=NEW.order_id)))
    OR (TG_OP='DELETE' AND EXISTS (SELECT 1 FROM pos_order_pricing_snapshots s WHERE s.order_id=OLD.order_id))
    OR (TG_OP='INSERT' AND EXISTS (SELECT 1 FROM pos_order_pricing_snapshots s WHERE s.order_id=NEW.order_id)) THEN
    RAISE EXCEPTION 'order_item_pricing_snapshot_locked' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pos_order_item_after_snapshot ON order_items;
CREATE TRIGGER pos_order_item_after_snapshot BEFORE INSERT OR UPDATE OR DELETE ON order_items FOR EACH ROW EXECUTE FUNCTION guard_pos_order_item_after_snapshot();

CREATE OR REPLACE FUNCTION validate_pos_order_pricing_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_snapshot_id uuid; expected_count bigint; actual_count bigint; gross_sum bigint; discount_sum bigint; net_sum bigint; header pos_order_pricing_snapshots%ROWTYPE;
BEGIN
  v_snapshot_id := COALESCE(NEW.snapshot_id,OLD.snapshot_id);
  SELECT * INTO header FROM pos_order_pricing_snapshots s WHERE s.id=v_snapshot_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*) INTO expected_count FROM order_items WHERE order_id=header.order_id;
  SELECT count(*),COALESCE(sum(gross_minor),0),COALESCE(sum(discount_minor),0),COALESCE(sum(net_minor),0)
    INTO actual_count,gross_sum,discount_sum,net_sum FROM pos_order_pricing_snapshot_lines l WHERE l.snapshot_id=v_snapshot_id;
  IF actual_count<>expected_count OR gross_sum<>header.subtotal_minor OR discount_sum<>header.discount_minor OR net_sum<>header.subtotal_minor-header.discount_minor THEN
    RAISE EXCEPTION 'pos_order_pricing_snapshot_reconciliation_failed' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS pos_order_pricing_snapshot_lines_validate ON pos_order_pricing_snapshot_lines;
CREATE CONSTRAINT TRIGGER pos_order_pricing_snapshot_lines_validate AFTER INSERT ON pos_order_pricing_snapshot_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_pos_order_pricing_snapshot();
CREATE OR REPLACE FUNCTION validate_pos_order_pricing_snapshot_header() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_count bigint; actual_count bigint; gross_sum bigint; discount_sum bigint; net_sum bigint; eligible_ids uuid[];
BEGIN
  SELECT count(*) INTO expected_count FROM order_items WHERE order_id=NEW.order_id;
  SELECT count(*),COALESCE(sum(gross_minor),0),COALESCE(sum(discount_minor),0),COALESCE(sum(net_minor),0)
    INTO actual_count,gross_sum,discount_sum,net_sum FROM pos_order_pricing_snapshot_lines WHERE snapshot_id=NEW.id;
  SELECT COALESCE(array_agg(l.order_item_id ORDER BY l.order_item_id) FILTER(WHERE l.eligible),'{}'::uuid[]) INTO eligible_ids FROM pos_order_pricing_snapshot_lines l WHERE l.snapshot_id=NEW.id;
  IF actual_count<>expected_count OR gross_sum<>NEW.subtotal_minor OR discount_sum<>NEW.discount_minor OR net_sum<>NEW.subtotal_minor-NEW.discount_minor OR eligible_ids<>NEW.eligible_item_ids THEN
    RAISE EXCEPTION 'pos_order_pricing_snapshot_reconciliation_failed' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS pos_order_pricing_snapshot_header_validate ON pos_order_pricing_snapshots;
CREATE CONSTRAINT TRIGGER pos_order_pricing_snapshot_header_validate AFTER INSERT ON pos_order_pricing_snapshots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_pos_order_pricing_snapshot_header();

-- Mirror of additive 088 Finance payout ledger for fresh-schema parity.
-- Finance-owned append-only POS payout ledger.
-- This migration records factual external refunds only; it does not infer
-- employee attribution or rewrite payments/orders.
CREATE TABLE IF NOT EXISTS order_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  order_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0 AND amount = round(amount, 2)),
  item_attribution_status text NOT NULL DEFAULT 'unattributed'
    CHECK (item_attribution_status = 'unattributed'),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 120),
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, id),
  UNIQUE (venue_id, id, order_id),
  UNIQUE (venue_id, idempotency_key),
  FOREIGN KEY (venue_id, order_id) REFERENCES orders (venue_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id, shift_id) REFERENCES shifts (venue_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS order_refund_tenders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  refund_id uuid NOT NULL,
  order_id uuid NOT NULL,
  source_payment_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0 AND amount = round(amount, 2)),
  payout_method text NOT NULL CHECK (payout_method IN ('cash','card','qr')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, id),
  FOREIGN KEY (venue_id, refund_id, order_id) REFERENCES order_refunds (venue_id, id, order_id) ON DELETE RESTRICT,
  FOREIGN KEY (order_id, source_payment_id) REFERENCES payments (order_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS order_refunds_order_idx
  ON order_refunds (venue_id, order_id, created_at, id);
CREATE INDEX IF NOT EXISTS order_refunds_shift_idx
  ON order_refunds (venue_id, shift_id, created_at);
CREATE INDEX IF NOT EXISTS order_refund_tenders_refund_idx
  ON order_refund_tenders (venue_id, refund_id, created_at);
CREATE INDEX IF NOT EXISTS order_refund_tenders_payment_cap_idx
  ON order_refund_tenders (venue_id, order_id, source_payment_id, created_at);

CREATE OR REPLACE FUNCTION reject_order_refund_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'order refunds are append-only' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS order_refunds_immutable ON order_refunds;
CREATE TRIGGER order_refunds_immutable
  BEFORE UPDATE OR DELETE ON order_refunds
  FOR EACH ROW EXECUTE FUNCTION reject_order_refund_mutation();

DROP TRIGGER IF EXISTS order_refunds_no_truncate ON order_refunds;
CREATE TRIGGER order_refunds_no_truncate
  BEFORE TRUNCATE ON order_refunds
  FOR EACH STATEMENT EXECUTE FUNCTION reject_order_refund_mutation();

DROP TRIGGER IF EXISTS order_refund_tenders_immutable ON order_refund_tenders;
CREATE TRIGGER order_refund_tenders_immutable
  BEFORE UPDATE OR DELETE ON order_refund_tenders
  FOR EACH ROW EXECUTE FUNCTION reject_order_refund_mutation();

DROP TRIGGER IF EXISTS order_refund_tenders_no_truncate ON order_refund_tenders;
CREATE TRIGGER order_refund_tenders_no_truncate
  BEFORE TRUNCATE ON order_refund_tenders
  FOR EACH STATEMENT EXECUTE FUNCTION reject_order_refund_mutation();

-- Mirror of additive 091 POS item return facts and database guards.
-- Immutable item-sale return facts. Actual cash/card/QR payout remains in 088.
ALTER TABLE order_refunds DROP CONSTRAINT IF EXISTS order_refunds_item_attribution_status_check;
ALTER TABLE order_refunds ADD CONSTRAINT order_refunds_item_attribution_status_check
  CHECK (item_attribution_status IN ('unattributed','complete','not_applicable'));

CREATE UNIQUE INDEX IF NOT EXISTS pos_order_pricing_snapshot_lines_return_source_uq
  ON pos_order_pricing_snapshot_lines (venue_id,snapshot_id,order_id,order_item_id);

CREATE TABLE IF NOT EXISTS pos_order_item_return_balances (
  venue_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  order_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  returned_quantity numeric(12,3) NOT NULL DEFAULT 0 CHECK (returned_quantity>=0),
  returned_item_value_minor bigint NOT NULL DEFAULT 0 CHECK (returned_item_value_minor>=0),
  PRIMARY KEY (venue_id,snapshot_id,order_id,order_item_id),
  FOREIGN KEY (venue_id,snapshot_id,order_id,order_item_id)
    REFERENCES pos_order_pricing_snapshot_lines (venue_id,snapshot_id,order_id,order_item_id) ON DELETE RESTRICT
);

-- This mutable row is a serialization/cap guard only. Append-only return rows remain the evidence.
-- The migration runner replays all files. Suspend only the balance-row guard for this
-- idempotent seed; the migration is applied atomically, then the guard is recreated below.
DROP TRIGGER IF EXISTS pos_order_item_return_balance_internal ON pos_order_item_return_balances;
INSERT INTO pos_order_item_return_balances (venue_id,snapshot_id,order_id,order_item_id)
SELECT venue_id,snapshot_id,order_id,order_item_id FROM pos_order_pricing_snapshot_lines
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION guard_pos_order_item_return_balance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='TRUNCATE' OR TG_OP='DELETE' OR pg_trigger_depth()<2 THEN
    RAISE EXCEPTION 'pos_order_item_return_balance_internal_only' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pos_order_item_return_balance_internal BEFORE INSERT OR UPDATE OR DELETE ON pos_order_item_return_balances
  FOR EACH ROW EXECUTE FUNCTION guard_pos_order_item_return_balance();
DROP TRIGGER IF EXISTS pos_order_item_return_balance_no_truncate ON pos_order_item_return_balances;
CREATE TRIGGER pos_order_item_return_balance_no_truncate BEFORE TRUNCATE ON pos_order_item_return_balances
  FOR EACH STATEMENT EXECUTE FUNCTION guard_pos_order_item_return_balance();

CREATE OR REPLACE FUNCTION seed_pos_order_item_return_balance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO pos_order_item_return_balances (venue_id,snapshot_id,order_id,order_item_id)
  VALUES (NEW.venue_id,NEW.snapshot_id,NEW.order_id,NEW.order_item_id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pos_order_item_return_balance_seed ON pos_order_pricing_snapshot_lines;
CREATE TRIGGER pos_order_item_return_balance_seed AFTER INSERT ON pos_order_pricing_snapshot_lines
  FOR EACH ROW EXECUTE FUNCTION seed_pos_order_item_return_balance();

CREATE TABLE IF NOT EXISTS order_refund_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  refund_id uuid NOT NULL,
  order_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  returned_quantity numeric(12,3) NOT NULL CHECK (returned_quantity>0),
  returned_item_value_minor bigint NOT NULL CHECK (returned_item_value_minor>=0),
  return_policy_version integer NOT NULL DEFAULT 1 CHECK (return_policy_version=1),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,refund_id,order_item_id),
  FOREIGN KEY (venue_id,refund_id,order_id)
    REFERENCES order_refunds (venue_id,id,order_id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,snapshot_id,order_id)
    REFERENCES pos_order_pricing_snapshots (venue_id,id,order_id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,snapshot_id,order_id,order_item_id)
    REFERENCES pos_order_pricing_snapshot_lines (venue_id,snapshot_id,order_id,order_item_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS order_refund_items_source_idx
  ON order_refund_items (venue_id,snapshot_id,order_item_id,created_at,id);
CREATE INDEX IF NOT EXISTS order_refund_items_refund_idx
  ON order_refund_items (venue_id,refund_id,created_at,id);

CREATE OR REPLACE FUNCTION guard_order_refund_item_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'order refund items are append-only' USING ERRCODE='55000'; END $$;
DROP TRIGGER IF EXISTS order_refund_items_immutable ON order_refund_items;
CREATE TRIGGER order_refund_items_immutable BEFORE UPDATE OR DELETE ON order_refund_items
  FOR EACH ROW EXECUTE FUNCTION guard_order_refund_item_mutation();
DROP TRIGGER IF EXISTS order_refund_items_no_truncate ON order_refund_items;
CREATE TRIGGER order_refund_items_no_truncate BEFORE TRUNCATE ON order_refund_items
  FOR EACH STATEMENT EXECUTE FUNCTION guard_order_refund_item_mutation();

CREATE OR REPLACE FUNCTION validate_order_refund_item_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE refund_status text; header_created_at timestamptz; line record; next_quantity numeric(12,3); next_value bigint;
BEGIN
  SELECT item_attribution_status,created_at INTO refund_status,header_created_at
    FROM order_refunds WHERE venue_id=NEW.venue_id AND id=NEW.refund_id AND order_id=NEW.order_id;
  IF refund_status IS DISTINCT FROM 'complete' THEN
    RAISE EXCEPTION 'order_refund_item_requires_complete_attribution' USING ERRCODE='23514';
  END IF;
  SELECT quantity,net_minor INTO line FROM pos_order_pricing_snapshot_lines
    WHERE venue_id=NEW.venue_id AND snapshot_id=NEW.snapshot_id AND order_id=NEW.order_id AND order_item_id=NEW.order_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_refund_item_source_unavailable' USING ERRCODE='23514'; END IF;
  UPDATE pos_order_item_return_balances b
    SET returned_quantity=b.returned_quantity+NEW.returned_quantity,
        returned_item_value_minor=round(line.net_minor::numeric*(b.returned_quantity+NEW.returned_quantity)/line.quantity,0)::bigint
    WHERE b.venue_id=NEW.venue_id AND b.snapshot_id=NEW.snapshot_id AND b.order_id=NEW.order_id AND b.order_item_id=NEW.order_item_id
      AND b.returned_quantity+NEW.returned_quantity<=line.quantity
    RETURNING b.returned_quantity,b.returned_item_value_minor INTO next_quantity,next_value;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_refund_item_quantity_exceeds_remaining' USING ERRCODE='23514'; END IF;
  NEW.returned_item_value_minor:=next_value-round(line.net_minor::numeric*(next_quantity-NEW.returned_quantity)/line.quantity,0)::bigint;
  NEW.created_at:=header_created_at;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS order_refund_items_validate_insert ON order_refund_items;
CREATE TRIGGER order_refund_items_validate_insert BEFORE INSERT ON order_refund_items
  FOR EACH ROW EXECUTE FUNCTION validate_order_refund_item_insert();

CREATE OR REPLACE FUNCTION validate_order_refund_item_attribution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item_count bigint; has_snapshot boolean;
BEGIN
  SELECT count(*) INTO item_count FROM order_refund_items WHERE venue_id=NEW.venue_id AND refund_id=NEW.id;
  SELECT EXISTS(SELECT 1 FROM pos_order_pricing_snapshots s WHERE s.venue_id=NEW.venue_id AND s.order_id=NEW.order_id) INTO has_snapshot;
  IF (NEW.item_attribution_status='complete' AND item_count=0)
      OR (NEW.item_attribution_status='unattributed' AND item_count>0)
      OR (NEW.item_attribution_status='not_applicable' AND (item_count>0 OR NOT has_snapshot)) THEN
    RAISE EXCEPTION 'order_refund_item_attribution_reconciliation_failed' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS order_refund_item_attribution_validate ON order_refunds;
CREATE CONSTRAINT TRIGGER order_refund_item_attribution_validate AFTER INSERT ON order_refunds
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_order_refund_item_attribution();

-- Verify the 090 evaluator's deterministic largest-remainder allocation at the database boundary.
CREATE OR REPLACE FUNCTION validate_pos_order_pricing_snapshot_allocations(p_snapshot_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE header pos_order_pricing_snapshots%ROWTYPE; mismatch boolean;
BEGIN
  SELECT * INTO header FROM pos_order_pricing_snapshots WHERE id=p_snapshot_id;
  IF NOT FOUND THEN RETURN; END IF;
  WITH raw AS (
    SELECT l.order_item_id,l.gross_minor,l.discount_minor,l.eligible,
      l.quantity*l.unit_price*100 AS exact_gross,
      floor(l.quantity*l.unit_price*100)::bigint AS floor_gross
    FROM pos_order_pricing_snapshot_lines l WHERE l.snapshot_id=p_snapshot_id
  ), ranked AS (
    SELECT r.*,row_number() OVER (ORDER BY (exact_gross-floor_gross) DESC,order_item_id) AS gross_rank,
      sum(floor_gross) OVER () AS floor_total
    FROM raw r
  )
  SELECT EXISTS(SELECT 1 FROM ranked r WHERE r.gross_minor<>r.floor_gross+CASE WHEN r.gross_rank<=header.subtotal_minor-r.floor_total THEN 1 ELSE 0 END)
    INTO mismatch;
  IF mismatch THEN RAISE EXCEPTION 'pos_order_pricing_snapshot_gross_allocation_mismatch' USING ERRCODE='23514'; END IF;
  WITH raw AS (
    SELECT l.order_item_id,l.discount_minor,l.eligible,l.gross_minor,
      sum(l.gross_minor) FILTER (WHERE l.eligible) OVER () AS eligible_total
    FROM pos_order_pricing_snapshot_lines l WHERE l.snapshot_id=p_snapshot_id
  ), parts AS (
    SELECT r.*,CASE WHEN eligible AND eligible_total>0 THEN floor(header.discount_minor::numeric*gross_minor/eligible_total)::bigint ELSE 0::bigint END AS floor_discount,
      CASE WHEN eligible AND eligible_total>0 THEN mod(header.discount_minor::numeric*gross_minor,eligible_total)::bigint ELSE 0::bigint END AS discount_remainder
    FROM raw r
  ), ranked AS (
    SELECT p.*,row_number() OVER (ORDER BY CASE WHEN eligible THEN discount_remainder END DESC NULLS LAST,order_item_id) AS discount_rank,
      sum(floor_discount) OVER () AS floor_total
    FROM parts p
  )
  SELECT EXISTS(SELECT 1 FROM ranked r WHERE r.discount_minor<>r.floor_discount+CASE WHEN r.eligible AND r.discount_rank<=header.discount_minor-r.floor_total THEN 1 ELSE 0 END)
    INTO mismatch;
  IF mismatch THEN RAISE EXCEPTION 'pos_order_pricing_snapshot_discount_allocation_mismatch' USING ERRCODE='23514'; END IF;
END $$;

CREATE OR REPLACE FUNCTION trigger_validate_pos_order_pricing_snapshot_allocations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='pos_order_pricing_snapshots' THEN
    PERFORM validate_pos_order_pricing_snapshot_allocations(NEW.id);
  ELSE
    PERFORM validate_pos_order_pricing_snapshot_allocations(NEW.snapshot_id);
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS pos_order_pricing_snapshot_allocations_header_validate ON pos_order_pricing_snapshots;
CREATE CONSTRAINT TRIGGER pos_order_pricing_snapshot_allocations_header_validate AFTER INSERT ON pos_order_pricing_snapshots
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trigger_validate_pos_order_pricing_snapshot_allocations();
DROP TRIGGER IF EXISTS pos_order_pricing_snapshot_allocations_lines_validate ON pos_order_pricing_snapshot_lines;
CREATE CONSTRAINT TRIGGER pos_order_pricing_snapshot_allocations_lines_validate AFTER INSERT ON pos_order_pricing_snapshot_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trigger_validate_pos_order_pricing_snapshot_allocations();

-- Mirror of additive 092 POS item return ordering facts for fresh-schema parity.
-- Attested per-source ordering for POS item returns. Existing 091 rows remain unsequenced.
ALTER TABLE pos_order_item_return_balances
  ADD COLUMN IF NOT EXISTS return_sequence bigint NOT NULL DEFAULT 0;
ALTER TABLE pos_order_item_return_balances
  DROP CONSTRAINT IF EXISTS pos_order_item_return_balances_sequence_check;
ALTER TABLE pos_order_item_return_balances
  ADD CONSTRAINT pos_order_item_return_balances_sequence_check CHECK (return_sequence>=0);

ALTER TABLE order_refund_items ADD COLUMN IF NOT EXISTS producer_sequence bigint;
ALTER TABLE order_refund_items ADD COLUMN IF NOT EXISTS previous_returned_quantity numeric(12,3);
ALTER TABLE order_refund_items ADD COLUMN IF NOT EXISTS cumulative_returned_quantity numeric(12,3);
ALTER TABLE order_refund_items ADD COLUMN IF NOT EXISTS previous_returned_item_value_minor bigint;
ALTER TABLE order_refund_items ADD COLUMN IF NOT EXISTS cumulative_returned_item_value_minor bigint;
ALTER TABLE order_refund_items
  DROP CONSTRAINT IF EXISTS order_refund_items_sequence_lineage_check;
ALTER TABLE order_refund_items
  ADD CONSTRAINT order_refund_items_sequence_lineage_check CHECK (
    (producer_sequence IS NULL
      AND previous_returned_quantity IS NULL
      AND cumulative_returned_quantity IS NULL
      AND previous_returned_item_value_minor IS NULL
      AND cumulative_returned_item_value_minor IS NULL)
    OR
    (producer_sequence IS NOT NULL AND producer_sequence>0
      AND previous_returned_quantity IS NOT NULL AND previous_returned_quantity>=0
      AND cumulative_returned_quantity IS NOT NULL
      AND previous_returned_item_value_minor IS NOT NULL AND previous_returned_item_value_minor>=0
      AND cumulative_returned_item_value_minor IS NOT NULL
      AND cumulative_returned_quantity=previous_returned_quantity+returned_quantity
      AND cumulative_returned_item_value_minor=previous_returned_item_value_minor+returned_item_value_minor)
  );
CREATE UNIQUE INDEX IF NOT EXISTS order_refund_items_source_sequence_uq
  ON order_refund_items (venue_id,snapshot_id,order_id,order_item_id,producer_sequence)
  WHERE producer_sequence IS NOT NULL;

-- Do not derive sequence from 091 created_at/id. Validate, but preserve, the existing aggregate baseline.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pos_order_pricing_snapshot_lines l
    LEFT JOIN pos_order_item_return_balances b
      ON b.venue_id=l.venue_id AND b.snapshot_id=l.snapshot_id AND b.order_id=l.order_id AND b.order_item_id=l.order_item_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(ri.returned_quantity),0) AS quantity,
        COALESCE(sum(ri.returned_item_value_minor),0) AS value_minor
      FROM order_refund_items ri
      WHERE ri.venue_id=l.venue_id AND ri.snapshot_id=l.snapshot_id AND ri.order_id=l.order_id AND ri.order_item_id=l.order_item_id
    ) e ON true
    WHERE b.order_item_id IS NULL
      OR b.returned_quantity<>e.quantity
      OR b.returned_item_value_minor<>e.value_minor
  ) THEN
    RAISE EXCEPTION 'pos_order_item_return_balance_legacy_reconciliation_failed' USING ERRCODE='23514';
  END IF;
END $$;

-- Replace the 091 writer with an ordered append-only producer. The balance row lock assigns
-- sequence and freezes both sides of the transition in the same transaction.
CREATE OR REPLACE FUNCTION validate_order_refund_item_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  refund_status text;
  header_created_at timestamptz;
  line record;
  previous_sequence bigint;
  previous_quantity numeric(12,3);
  previous_value bigint;
  next_quantity numeric(12,3);
  next_value bigint;
BEGIN
  SELECT item_attribution_status,created_at INTO refund_status,header_created_at
    FROM order_refunds WHERE venue_id=NEW.venue_id AND id=NEW.refund_id AND order_id=NEW.order_id;
  IF refund_status IS DISTINCT FROM 'complete' THEN
    RAISE EXCEPTION 'order_refund_item_requires_complete_attribution' USING ERRCODE='23514';
  END IF;
  SELECT quantity,net_minor INTO line FROM pos_order_pricing_snapshot_lines
    WHERE venue_id=NEW.venue_id AND snapshot_id=NEW.snapshot_id AND order_id=NEW.order_id AND order_item_id=NEW.order_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_refund_item_source_unavailable' USING ERRCODE='23514'; END IF;

  SELECT return_sequence,returned_quantity,returned_item_value_minor
    INTO previous_sequence,previous_quantity,previous_value
    FROM pos_order_item_return_balances
    WHERE venue_id=NEW.venue_id AND snapshot_id=NEW.snapshot_id AND order_id=NEW.order_id AND order_item_id=NEW.order_item_id
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_refund_item_balance_unavailable' USING ERRCODE='23514'; END IF;
  next_quantity:=previous_quantity+NEW.returned_quantity;
  IF next_quantity>line.quantity THEN
    RAISE EXCEPTION 'order_refund_item_quantity_exceeds_remaining' USING ERRCODE='23514';
  END IF;
  next_value:=round(line.net_minor::numeric*next_quantity/line.quantity,0)::bigint;
  IF previous_value>next_value THEN
    RAISE EXCEPTION 'order_refund_item_value_reconciliation_failed' USING ERRCODE='23514';
  END IF;

  UPDATE pos_order_item_return_balances
    SET return_sequence=previous_sequence+1,
        returned_quantity=next_quantity,
        returned_item_value_minor=next_value
    WHERE venue_id=NEW.venue_id AND snapshot_id=NEW.snapshot_id AND order_id=NEW.order_id AND order_item_id=NEW.order_item_id;

  NEW.producer_sequence:=previous_sequence+1;
  NEW.previous_returned_quantity:=previous_quantity;
  NEW.cumulative_returned_quantity:=next_quantity;
  NEW.previous_returned_item_value_minor:=previous_value;
  NEW.cumulative_returned_item_value_minor:=next_value;
  NEW.returned_item_value_minor:=next_value-previous_value;
  NEW.created_at:=header_created_at;
  RETURN NEW;
END $$;
