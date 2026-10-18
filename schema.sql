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
CREATE UNIQUE INDEX IF NOT EXISTS users_venue_id_id_uq ON users (venue_id, id);

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
DROP TRIGGER IF EXISTS pos_order_item_return_balance_internal ON pos_order_item_return_balances;
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

CREATE TABLE IF NOT EXISTS staff_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date date NOT NULL,
  planned_start timestamptz,
  planned_end timestamptz,
  note text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, user_id, work_date)
);
CREATE INDEX IF NOT EXISTS staff_schedules_venue_date_idx ON staff_schedules(venue_id, work_date);

CREATE TABLE IF NOT EXISTS staff_work_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','shift','device')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_work_logs_venue_user_idx ON staff_work_logs(venue_id, user_id, started_at);

CREATE TABLE IF NOT EXISTS payroll_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name text NOT NULL,
  rule_type text NOT NULL CHECK (rule_type IN ('hourly','monthly','percent_revenue','per_shift')),
  rate numeric(12,2) NOT NULL CHECK (rate >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payroll_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_id uuid REFERENCES payroll_rules(id),
  period_from date NOT NULL,
  period_to date NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  expense_id uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','paid')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, user_id, period_from, period_to, rule_id)
);
CREATE INDEX IF NOT EXISTS payroll_entries_venue_period_idx ON payroll_entries(venue_id, period_from, period_to);

CREATE TABLE IF NOT EXISTS expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  category text NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  expense_date date NOT NULL,
  description text,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','payroll','purchase','other')),
  document_url text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS expenses_venue_date_idx ON expenses(venue_id, expense_date);
-- The deployment script may replay every migration against an existing volume.
-- Add the relation only when it is not already present.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'payroll_entries_expense_fk'
      AND conrelid = 'payroll_entries'::regclass
  ) THEN
    ALTER TABLE payroll_entries
      ADD CONSTRAINT payroll_entries_expense_fk
      FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE SET NULL;
  END IF;
END
$$;

-- Persisted purchase / receipt documents.
--
-- This migration is additive and intentionally does not backfill existing
-- stock_movements. Existing movements remain the source of truth for their
-- historical quantities and costs. New receiving code should create a
-- document, its lines, and the linked stock_movements in one transaction.
--
-- Compatibility:
--   * supplier_name and document_number are document metadata; no supplier
--     master table is required by this migration.
--   * document_date is the date printed on the supplier document.
--   * recorded_at is the CRM/server time when the document was recorded.
--   * receipt_unit_cost is the immutable normalized cost snapshot used for
--     future audit/reporting. ingredients.cost may continue to change as a
--     weighted current cost and must not be used to rewrite this snapshot.
--   * source_movement_id is nullable so a draft can exist before posting and
--     so legacy movements do not need synthetic document rows. Once linked,
--     the movement is RESTRICT-protected: the stock ledger must retain the
--     source link; corrections use an adjustment movement instead of delete.
--   * source_auto_order_id is nullable because manual receipts are valid.
--
-- Rollback (only before the API starts creating documents):
--   DROP TABLE IF EXISTS inventory_purchase_document_lines;
--   DROP TABLE IF EXISTS inventory_purchase_documents;
--   DROP FUNCTION IF EXISTS inventory_purchase_document_status_guard();
--   DROP FUNCTION IF EXISTS inventory_purchase_document_immutable_guard();
--   DROP FUNCTION IF EXISTS inventory_purchase_line_price_guard();
--   DROP FUNCTION IF EXISTS inventory_purchase_line_scope_guard();
--   DROP FUNCTION IF EXISTS inventory_purchase_line_lifecycle_guard();
--   DROP FUNCTION IF EXISTS inventory_purchase_document_delete_guard();
--   DROP FUNCTION IF EXISTS inventory_purchase_source_order_scope_guard();
-- This removes only the new tables and never deletes historical stock rows.

CREATE TABLE IF NOT EXISTS inventory_purchase_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  supplier_name text NOT NULL DEFAULT 'Не указан',
  document_number text,
  document_date date NOT NULL DEFAULT CURRENT_DATE,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'posted', 'voided')),
  note text,
  source_auto_order_id uuid REFERENCES inventory_auto_orders(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  posted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  posted_at timestamptz,
  CHECK (length(btrim(supplier_name)) BETWEEN 1 AND 160),
  CHECK (document_number IS NULL OR length(btrim(document_number)) BETWEEN 1 AND 80),
  CHECK (note IS NULL OR length(note) <= 2000),
  UNIQUE (venue_id, document_number)
);

CREATE INDEX IF NOT EXISTS inventory_purchase_documents_venue_date_idx
  ON inventory_purchase_documents(venue_id, document_date DESC, recorded_at DESC);
CREATE INDEX IF NOT EXISTS inventory_purchase_documents_venue_status_idx
  ON inventory_purchase_documents(venue_id, status, recorded_at DESC);
CREATE INDEX IF NOT EXISTS inventory_purchase_documents_auto_order_idx
  ON inventory_purchase_documents(source_auto_order_id)
  WHERE source_auto_order_id IS NOT NULL;

CREATE OR REPLACE FUNCTION inventory_purchase_source_order_scope_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_venue uuid;
BEGIN
  IF NEW.source_auto_order_id IS NULL THEN RETURN NEW; END IF;
  SELECT venue_id INTO source_venue FROM inventory_auto_orders WHERE id=NEW.source_auto_order_id;
  IF source_venue IS NULL OR source_venue IS DISTINCT FROM NEW.venue_id THEN
    RAISE EXCEPTION 'invalid_source_auto_order'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_purchase_source_order_scope_guard
  ON inventory_purchase_documents;
CREATE TRIGGER inventory_purchase_source_order_scope_guard
BEFORE INSERT OR UPDATE OF source_auto_order_id, venue_id ON inventory_purchase_documents
FOR EACH ROW
EXECUTE FUNCTION inventory_purchase_source_order_scope_guard();

CREATE TABLE IF NOT EXISTS inventory_purchase_document_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES inventory_purchase_documents(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
  ingredient_name_snapshot text NOT NULL,
  stock_unit text NOT NULL,
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit text NOT NULL,
  pack_multiplier numeric(14,6) NOT NULL DEFAULT 1 CHECK (pack_multiplier > 0),
  stock_quantity numeric(14,6) NOT NULL CHECK (stock_quantity > 0),
  unit_cost numeric(14,4) NOT NULL CHECK (unit_cost >= 0),
  receipt_unit_cost numeric(14,6) NOT NULL CHECK (receipt_unit_cost >= 0),
  line_total numeric(14,2) NOT NULL CHECK (line_total >= 0),
  source_movement_id uuid UNIQUE REFERENCES stock_movements(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(btrim(ingredient_name_snapshot)) BETWEEN 1 AND 160),
  CHECK (length(btrim(stock_unit)) BETWEEN 1 AND 30),
  CHECK (length(btrim(unit)) BETWEEN 1 AND 30)
);

CREATE INDEX IF NOT EXISTS inventory_purchase_lines_document_idx
  ON inventory_purchase_document_lines(document_id);
CREATE INDEX IF NOT EXISTS inventory_purchase_lines_venue_ingredient_idx
  ON inventory_purchase_document_lines(venue_id, ingredient_id, created_at DESC);

-- A posted receipt cannot be voided until a reversal workflow exists. Drafts
-- may be voided; posted documents remain immutable and corrections use a
-- separate stock adjustment document.
CREATE OR REPLACE FUNCTION inventory_purchase_document_status_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status
     AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('posted', 'voided'))
     ) THEN
    RAISE EXCEPTION 'inventory_purchase_status_transition_invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_purchase_document_status_guard
  ON inventory_purchase_documents;
CREATE TRIGGER inventory_purchase_document_status_guard
BEFORE UPDATE OF status ON inventory_purchase_documents
FOR EACH ROW
EXECUTE FUNCTION inventory_purchase_document_status_guard();

CREATE OR REPLACE FUNCTION inventory_purchase_document_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('posted', 'voided') AND (
       OLD.venue_id IS DISTINCT FROM NEW.venue_id
       OR OLD.supplier_name IS DISTINCT FROM NEW.supplier_name
       OR OLD.document_number IS DISTINCT FROM NEW.document_number
       OR OLD.document_date IS DISTINCT FROM NEW.document_date
       OR OLD.recorded_at IS DISTINCT FROM NEW.recorded_at
       OR OLD.note IS DISTINCT FROM NEW.note
       OR OLD.source_auto_order_id IS DISTINCT FROM NEW.source_auto_order_id
       OR OLD.created_by IS DISTINCT FROM NEW.created_by
       OR OLD.posted_by IS DISTINCT FROM NEW.posted_by
       OR OLD.posted_at IS DISTINCT FROM NEW.posted_at
     ) THEN
    RAISE EXCEPTION 'inventory_purchase_document_immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_purchase_document_immutable_guard
  ON inventory_purchase_documents;
CREATE TRIGGER inventory_purchase_document_immutable_guard
BEFORE UPDATE ON inventory_purchase_documents
FOR EACH ROW
EXECUTE FUNCTION inventory_purchase_document_immutable_guard();

-- Price and quantity snapshots may be edited while a document is draft. Once
-- posted, they are immutable; a correction must be represented by a new
-- document/stock adjustment rather than rewriting history.
CREATE OR REPLACE FUNCTION inventory_purchase_line_price_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  document_status text;
BEGIN
  SELECT status INTO document_status
    FROM inventory_purchase_documents
   WHERE id = OLD.document_id;
  IF document_status IN ('posted', 'voided') AND (
       OLD.document_id IS DISTINCT FROM NEW.document_id
       OR OLD.venue_id IS DISTINCT FROM NEW.venue_id
       OR OLD.ingredient_id IS DISTINCT FROM NEW.ingredient_id
       OR OLD.ingredient_name_snapshot IS DISTINCT FROM NEW.ingredient_name_snapshot
       OR OLD.stock_unit IS DISTINCT FROM NEW.stock_unit
       OR OLD.quantity IS DISTINCT FROM NEW.quantity
       OR OLD.unit IS DISTINCT FROM NEW.unit
       OR OLD.pack_multiplier IS DISTINCT FROM NEW.pack_multiplier
       OR OLD.stock_quantity IS DISTINCT FROM NEW.stock_quantity
       OR OLD.unit_cost IS DISTINCT FROM NEW.unit_cost
       OR OLD.receipt_unit_cost IS DISTINCT FROM NEW.receipt_unit_cost
       OR OLD.line_total IS DISTINCT FROM NEW.line_total
       OR OLD.source_movement_id IS DISTINCT FROM NEW.source_movement_id
     ) THEN
    RAISE EXCEPTION 'inventory_purchase_line_immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_purchase_line_price_guard
  ON inventory_purchase_document_lines;
CREATE TRIGGER inventory_purchase_line_price_guard
BEFORE UPDATE ON inventory_purchase_document_lines
FOR EACH ROW
EXECUTE FUNCTION inventory_purchase_line_price_guard();

-- Keep the document/ingredient/movement references inside one venue. The
-- application must still filter every query by venue_id; this trigger adds a
-- database-level guard against an accidental cross-venue receipt link.
CREATE OR REPLACE FUNCTION inventory_purchase_line_scope_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  document_venue uuid;
  ingredient_venue uuid;
  movement_venue uuid;
  movement_ingredient uuid;
BEGIN
  SELECT venue_id INTO document_venue
    FROM inventory_purchase_documents WHERE id = NEW.document_id;
  SELECT venue_id INTO ingredient_venue
    FROM ingredients WHERE id = NEW.ingredient_id;
  IF document_venue IS NULL OR ingredient_venue IS NULL
     OR NEW.venue_id IS DISTINCT FROM document_venue
     OR NEW.venue_id IS DISTINCT FROM ingredient_venue THEN
    RAISE EXCEPTION 'inventory_purchase_line_scope_invalid'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.source_movement_id IS NOT NULL THEN
    SELECT venue_id, ingredient_id INTO movement_venue, movement_ingredient
      FROM stock_movements WHERE id = NEW.source_movement_id;
    IF movement_venue IS NULL
       OR movement_venue IS DISTINCT FROM NEW.venue_id
       OR movement_ingredient IS DISTINCT FROM NEW.ingredient_id THEN
      RAISE EXCEPTION 'inventory_purchase_source_movement_invalid'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_purchase_line_scope_guard
  ON inventory_purchase_document_lines;
CREATE TRIGGER inventory_purchase_line_scope_guard
BEFORE INSERT OR UPDATE ON inventory_purchase_document_lines
FOR EACH ROW
EXECUTE FUNCTION inventory_purchase_line_scope_guard();

CREATE OR REPLACE FUNCTION inventory_purchase_line_lifecycle_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  document_status text;
BEGIN
  SELECT status INTO document_status
    FROM inventory_purchase_documents
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.document_id ELSE NEW.document_id END
   FOR UPDATE;
  IF document_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'inventory_purchase_line_immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_purchase_line_lifecycle_guard
  ON inventory_purchase_document_lines;
CREATE TRIGGER inventory_purchase_line_lifecycle_guard
BEFORE INSERT OR UPDATE OR DELETE ON inventory_purchase_document_lines
FOR EACH ROW
EXECUTE FUNCTION inventory_purchase_line_lifecycle_guard();

CREATE OR REPLACE FUNCTION inventory_purchase_document_delete_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('posted', 'voided') THEN
    RAISE EXCEPTION 'inventory_purchase_document_immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS inventory_purchase_document_delete_guard
  ON inventory_purchase_documents;
CREATE TRIGGER inventory_purchase_document_delete_guard
BEFORE DELETE ON inventory_purchase_documents
FOR EACH ROW
EXECUTE FUNCTION inventory_purchase_document_delete_guard();

-- Explicit shift attribution for payments and closed orders.
-- Existing records remain NULL: their historical shift cannot be determined
-- reliably from timestamps (especially across overnight/overlapping shifts).
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS shift_id uuid REFERENCES shifts(id) ON DELETE RESTRICT;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS closed_in_shift_id uuid REFERENCES shifts(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_payments_shift_status
  ON payments (shift_id, status) WHERE shift_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_closed_shift
  ON orders (closed_in_shift_id) WHERE closed_in_shift_id IS NOT NULL;

CREATE OR REPLACE FUNCTION payment_shift_venue_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_venue uuid; shift_venue uuid;
BEGIN
  IF NEW.shift_id IS NULL THEN RETURN NEW; END IF;
  SELECT venue_id INTO order_venue FROM orders WHERE id=NEW.order_id;
  SELECT venue_id INTO shift_venue FROM shifts WHERE id=NEW.shift_id;
  IF order_venue IS NULL OR shift_venue IS NULL OR order_venue IS DISTINCT FROM shift_venue THEN
    RAISE EXCEPTION 'payment_shift_venue_mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payment_shift_venue_guard ON payments;
CREATE TRIGGER payment_shift_venue_guard
BEFORE INSERT OR UPDATE OF order_id, shift_id ON payments
FOR EACH ROW EXECUTE FUNCTION payment_shift_venue_guard();

CREATE OR REPLACE FUNCTION order_closed_shift_venue_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE shift_venue uuid;
BEGIN
  IF NEW.closed_in_shift_id IS NULL THEN RETURN NEW; END IF;
  SELECT venue_id INTO shift_venue FROM shifts WHERE id=NEW.closed_in_shift_id;
  IF shift_venue IS NULL OR NEW.venue_id IS DISTINCT FROM shift_venue THEN
    RAISE EXCEPTION 'order_closed_shift_venue_mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS order_closed_shift_venue_guard ON orders;
CREATE TRIGGER order_closed_shift_venue_guard
BEFORE INSERT OR UPDATE OF venue_id, closed_in_shift_id ON orders
FOR EACH ROW EXECUTE FUNCTION order_closed_shift_venue_guard();

-- Link supplier-payment cash movements to their posted receipt documents.
-- Existing manual purchase expenses remain intact and unlinked.
ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS purchase_document_id uuid
    REFERENCES inventory_purchase_documents(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS payment_method text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'expenses_purchase_source_check'
      AND conrelid = 'expenses'::regclass
  ) THEN
    ALTER TABLE expenses
      ADD CONSTRAINT expenses_purchase_source_check
      CHECK (purchase_document_id IS NULL OR source = 'purchase');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'expenses_purchase_payment_method_check'
      AND conrelid = 'expenses'::regclass
  ) THEN
    ALTER TABLE expenses
      ADD CONSTRAINT expenses_purchase_payment_method_check
      CHECK (payment_method IS NULL OR payment_method IN ('cash','card','bank_transfer','other'));
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS expenses_venue_idempotency_key_uq
  ON expenses(venue_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS expenses_purchase_document_idx
  ON expenses(venue_id, purchase_document_id, expense_date)
  WHERE purchase_document_id IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_expense_purchase_document_venue()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.purchase_document_id IS NOT NULL THEN
    IF NEW.source <> 'purchase' THEN
      RAISE EXCEPTION 'purchase_document_requires_purchase_source';
    END IF;
    PERFORM 1
      FROM inventory_purchase_documents d
      WHERE d.id = NEW.purchase_document_id
        AND d.venue_id = NEW.venue_id
        AND d.status = 'posted';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'purchase_document_missing_wrong_venue_or_not_posted';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS expenses_purchase_document_venue_guard ON expenses;
CREATE TRIGGER expenses_purchase_document_venue_guard
  BEFORE INSERT OR UPDATE OF venue_id,source,purchase_document_id ON expenses
  FOR EACH ROW EXECUTE FUNCTION enforce_expense_purchase_document_venue();

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

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS category_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='expenses_finance_category_fk'
      AND conrelid='expenses'::regclass
  ) THEN
    ALTER TABLE expenses
      ADD CONSTRAINT expenses_finance_category_fk
      FOREIGN KEY (venue_id, category_id)
      REFERENCES finance_categories (venue_id, id)
      ON DELETE SET NULL (category_id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS expenses_venue_category_idx
  ON expenses (venue_id, category_id) WHERE category_id IS NOT NULL;

-- Manual business obligations (rent, connectivity, services) with recurring
-- templates. Actual cash outflows remain in expenses; this is not a new ledger.

CREATE UNIQUE INDEX IF NOT EXISTS expenses_venue_id_uq ON expenses(venue_id,id);

CREATE TABLE IF NOT EXISTS finance_recurring_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  category_id uuid NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  counterparty_name text NOT NULL DEFAULT '' CHECK (length(counterparty_name) <= 160),
  basis text NOT NULL DEFAULT '' CHECK (length(basis) <= 500),
  cadence text NOT NULL DEFAULT 'monthly' CHECK (cadence = 'monthly'),
  day_of_month smallint NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  starts_on date NOT NULL,
  ends_on date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','ended')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  FOREIGN KEY (venue_id,category_id) REFERENCES finance_categories(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);

CREATE TABLE IF NOT EXISTS finance_recurring_rule_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  effective_from date NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount >= 0),
  lines jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(lines) = 'array'),
  variable_amount boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,rule_id,id),
  UNIQUE (venue_id,rule_id,version_number),
  FOREIGN KEY (venue_id,rule_id) REFERENCES finance_recurring_rules(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS finance_recurring_versions_effective_idx
  ON finance_recurring_rule_versions(venue_id,rule_id,effective_from DESC,version_number DESC);

CREATE TABLE IF NOT EXISTS finance_payables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  category_id uuid NOT NULL,
  category_name_snapshot text NOT NULL CHECK (length(btrim(category_name_snapshot)) BETWEEN 1 AND 80),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  counterparty_name text NOT NULL DEFAULT '' CHECK (length(counterparty_name) <= 160),
  basis text NOT NULL DEFAULT '' CHECK (length(basis) <= 500),
  period_from date NOT NULL,
  period_to date NOT NULL,
  due_date date NOT NULL,
  currency text NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
  total_amount numeric(14,2) NOT NULL CHECK (total_amount >= 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','cancelled')),
  recurring_rule_id uuid,
  recurring_version_id uuid,
  period_key text,
  supersedes_id uuid,
  correction_reason text,
  created_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  FOREIGN KEY (venue_id,category_id) REFERENCES finance_categories(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,recurring_rule_id) REFERENCES finance_recurring_rules(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,recurring_rule_id,recurring_version_id) REFERENCES finance_recurring_rule_versions(venue_id,rule_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,supersedes_id) REFERENCES finance_payables(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,approved_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  CHECK (period_to >= period_from),
  CHECK ((recurring_rule_id IS NULL AND recurring_version_id IS NULL AND period_key IS NULL)
      OR (recurring_rule_id IS NOT NULL AND recurring_version_id IS NOT NULL AND period_key IS NOT NULL)),
  CHECK ((supersedes_id IS NULL AND correction_reason IS NULL)
      OR (supersedes_id IS NOT NULL AND length(btrim(correction_reason)) BETWEEN 1 AND 500))
);
CREATE UNIQUE INDEX IF NOT EXISTS finance_payables_recurring_period_uq
  ON finance_payables(venue_id,recurring_rule_id,period_key)
  WHERE recurring_rule_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS finance_payables_venue_due_idx
  ON finance_payables(venue_id,due_date,status,category_id);

CREATE TABLE IF NOT EXISTS finance_payable_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  payable_id uuid NOT NULL,
  description_snapshot text NOT NULL CHECK (length(btrim(description_snapshot)) BETWEEN 1 AND 200),
  amount numeric(14,2) NOT NULL CHECK (amount >= 0),
  ordinal smallint NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,payable_id,ordinal),
  FOREIGN KEY (venue_id,payable_id) REFERENCES finance_payables(venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS finance_payable_lines_parent_idx ON finance_payable_lines(venue_id,payable_id,ordinal);

-- Association only: the referenced expenses row is the canonical cash event.
CREATE TABLE IF NOT EXISTS finance_payable_payment_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  payable_id uuid NOT NULL,
  expense_id uuid NOT NULL,
  applied_amount numeric(14,2) NOT NULL CHECK (applied_amount > 0),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,expense_id),
  UNIQUE (venue_id,idempotency_key),
  FOREIGN KEY (venue_id,payable_id) REFERENCES finance_payables(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,expense_id) REFERENCES expenses(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS finance_payable_payment_links_parent_idx
  ON finance_payable_payment_links(venue_id,payable_id,created_at,id);

CREATE OR REPLACE FUNCTION guard_finance_payable_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (
    OLD.venue_id IS DISTINCT FROM NEW.venue_id OR OLD.category_id IS DISTINCT FROM NEW.category_id
    OR OLD.category_name_snapshot IS DISTINCT FROM NEW.category_name_snapshot
    OR OLD.title IS DISTINCT FROM NEW.title OR OLD.counterparty_name IS DISTINCT FROM NEW.counterparty_name
    OR OLD.basis IS DISTINCT FROM NEW.basis OR OLD.period_from IS DISTINCT FROM NEW.period_from
    OR OLD.period_to IS DISTINCT FROM NEW.period_to OR OLD.due_date IS DISTINCT FROM NEW.due_date
    OR OLD.total_amount IS DISTINCT FROM NEW.total_amount OR OLD.recurring_rule_id IS DISTINCT FROM NEW.recurring_rule_id
    OR OLD.recurring_version_id IS DISTINCT FROM NEW.recurring_version_id OR OLD.period_key IS DISTINCT FROM NEW.period_key
  ) THEN RAISE EXCEPTION 'finance_payable_immutable' USING ERRCODE='55000'; END IF;
  IF OLD.status='approved' AND NEW.status='cancelled' THEN
    IF EXISTS (SELECT 1 FROM finance_payable_payment_links WHERE venue_id=OLD.venue_id AND payable_id=OLD.id) THEN
      RAISE EXCEPTION 'finance_payable_has_payments' USING ERRCODE='23514';
    END IF;
  ELSIF OLD.status <> NEW.status AND NOT (OLD.status='draft' AND NEW.status IN ('approved','cancelled')) THEN
    RAISE EXCEPTION 'finance_payable_transition_invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_payables_immutable_guard ON finance_payables;
CREATE TRIGGER finance_payables_immutable_guard BEFORE UPDATE ON finance_payables
  FOR EACH ROW EXECUTE FUNCTION guard_finance_payable_immutable();

CREATE OR REPLACE FUNCTION guard_finance_payable_line_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p finance_payables%ROWTYPE;
BEGIN
  SELECT * INTO p FROM finance_payables WHERE venue_id=COALESCE(NEW.venue_id,OLD.venue_id)
    AND id=COALESCE(NEW.payable_id,OLD.payable_id) FOR UPDATE;
  IF p.id IS NULL OR p.status <> 'draft' THEN
    RAISE EXCEPTION 'finance_payable_lines_immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_payable_lines_mutable_only_draft ON finance_payable_lines;
CREATE TRIGGER finance_payable_lines_mutable_only_draft BEFORE INSERT OR UPDATE OR DELETE ON finance_payable_lines
  FOR EACH ROW EXECUTE FUNCTION guard_finance_payable_line_mutation();

CREATE OR REPLACE FUNCTION validate_finance_payable_posting()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line_total numeric(14,2); category_kind text; category_active boolean;
BEGIN
  IF OLD.status='draft' AND NEW.status='approved' THEN
    SELECT kind,active INTO category_kind,category_active FROM finance_categories
      WHERE venue_id=NEW.venue_id AND id=NEW.category_id FOR KEY SHARE;
    IF category_kind IS DISTINCT FROM 'expense' OR category_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'finance_payable_category_invalid' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(SUM(amount),0)::numeric(14,2) INTO line_total
      FROM finance_payable_lines WHERE venue_id=NEW.venue_id AND payable_id=NEW.id;
    IF line_total <> NEW.total_amount THEN
      RAISE EXCEPTION 'finance_payable_lines_total_mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_payables_validate_posting ON finance_payables;
CREATE TRIGGER finance_payables_validate_posting BEFORE UPDATE OF status ON finance_payables
  FOR EACH ROW EXECUTE FUNCTION validate_finance_payable_posting();

CREATE OR REPLACE FUNCTION guard_finance_payable_payment_link()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p finance_payables%ROWTYPE; e expenses%ROWTYPE; paid numeric(14,2);
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'finance_payable_payment_links_append_only' USING ERRCODE='55000'; END IF;
  SELECT * INTO p FROM finance_payables WHERE venue_id=NEW.venue_id AND id=NEW.payable_id FOR UPDATE;
  SELECT * INTO e FROM expenses WHERE venue_id=NEW.venue_id AND id=NEW.expense_id FOR KEY SHARE;
  IF p.id IS NULL OR p.status <> 'approved' OR e.id IS NULL OR e.source <> 'manual'
      OR e.amount <> NEW.applied_amount OR e.category_id <> p.category_id THEN
    RAISE EXCEPTION 'finance_payable_payment_link_invalid' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(SUM(applied_amount),0)::numeric(14,2) INTO paid FROM finance_payable_payment_links
    WHERE venue_id=NEW.venue_id AND payable_id=NEW.payable_id;
  IF paid + NEW.applied_amount > p.total_amount THEN
    RAISE EXCEPTION 'finance_payable_payment_exceeds_balance' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_payable_payment_links_guard ON finance_payable_payment_links;
CREATE TRIGGER finance_payable_payment_links_guard BEFORE INSERT OR UPDATE OR DELETE ON finance_payable_payment_links
  FOR EACH ROW EXECUTE FUNCTION guard_finance_payable_payment_link();

CREATE OR REPLACE FUNCTION guard_finance_recurring_version_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'finance_recurring_rule_versions_append_only' USING ERRCODE='55000';
END $$;
DROP TRIGGER IF EXISTS finance_recurring_versions_immutable ON finance_recurring_rule_versions;
CREATE TRIGGER finance_recurring_versions_immutable BEFORE UPDATE OR DELETE ON finance_recurring_rule_versions
  FOR EACH ROW EXECUTE FUNCTION guard_finance_recurring_version_immutable();
-- Effective-dated classification for POS income. This supplements, and never
-- replaces, the canonical immutable pricing/refund ledgers.

CREATE TABLE IF NOT EXISTS finance_income_category_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  source_key text NOT NULL CHECK (length(source_key) BETWEEN 1 AND 500),
  category_id uuid NOT NULL,
  category_name_snapshot text NOT NULL CHECK (length(btrim(category_name_snapshot)) BETWEEN 1 AND 80),
  effective_from date NOT NULL CHECK (date_trunc('month',effective_from)::date=effective_from),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,source_key,effective_from),
  FOREIGN KEY (venue_id,category_id) REFERENCES finance_categories(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  CHECK (source_key<>'@minimum-adjustment' OR length(btrim(source_key))>0)
);
CREATE INDEX IF NOT EXISTS finance_income_category_mapping_lookup_idx
  ON finance_income_category_mappings(venue_id,source_key,effective_from DESC);

CREATE TABLE IF NOT EXISTS pos_order_income_category_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  order_id uuid NOT NULL,
  pricing_snapshot_id uuid NOT NULL,
  closed_at timestamptz NOT NULL,
  venue_date date NOT NULL,
  recognized_total_minor bigint NOT NULL CHECK (recognized_total_minor>=0),
  unmapped_minor bigint NOT NULL DEFAULT 0 CHECK (unmapped_minor>=0 AND unmapped_minor<=recognized_total_minor),
  status text NOT NULL DEFAULT 'building' CHECK (status IN ('building','complete','unmapped')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,order_id),
  UNIQUE (venue_id,id,order_id),
  FOREIGN KEY (venue_id,order_id) REFERENCES orders(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,pricing_snapshot_id,order_id) REFERENCES pos_order_pricing_snapshots(venue_id,id,order_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS pos_order_income_category_snapshots_date_idx
  ON pos_order_income_category_snapshots(venue_id,venue_date,status);

CREATE TABLE IF NOT EXISTS pos_order_income_category_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  income_snapshot_id uuid NOT NULL,
  order_id uuid NOT NULL,
  allocation_kind text NOT NULL CHECK (allocation_kind IN ('item','minimum_adjustment')),
  order_item_id uuid,
  source_key text NOT NULL CHECK (length(source_key) BETWEEN 1 AND 500),
  source_station_snapshot text NOT NULL DEFAULT '' CHECK (length(source_station_snapshot)<=80),
  source_menu_category text NOT NULL DEFAULT '',
  source_product_name text NOT NULL DEFAULT '' CHECK (length(source_product_name)<=200),
  mapping_id uuid,
  category_id uuid,
  category_name_snapshot text NOT NULL CHECK (length(btrim(category_name_snapshot)) BETWEEN 1 AND 80),
  amount_minor bigint NOT NULL CHECK (amount_minor>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (venue_id,income_snapshot_id,order_id) REFERENCES pos_order_income_category_snapshots(venue_id,id,order_id) ON DELETE RESTRICT,
  FOREIGN KEY (order_id,order_item_id) REFERENCES order_items(order_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,mapping_id) REFERENCES finance_income_category_mappings(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,category_id) REFERENCES finance_categories(venue_id,id) ON DELETE RESTRICT,
  CHECK ((allocation_kind='item' AND order_item_id IS NOT NULL AND source_key<>'@minimum-adjustment')
      OR (allocation_kind='minimum_adjustment' AND order_item_id IS NULL AND source_key='@minimum-adjustment')),
  CHECK ((category_id IS NULL AND mapping_id IS NULL AND category_name_snapshot='Не распределено')
      OR (category_id IS NOT NULL AND mapping_id IS NOT NULL AND category_name_snapshot<>'Не распределено'))
);
CREATE UNIQUE INDEX IF NOT EXISTS pos_order_income_category_item_uq
  ON pos_order_income_category_allocations(venue_id,income_snapshot_id,order_item_id)
  WHERE allocation_kind='item';
CREATE UNIQUE INDEX IF NOT EXISTS pos_order_income_category_adjustment_uq
  ON pos_order_income_category_allocations(venue_id,income_snapshot_id)
  WHERE allocation_kind='minimum_adjustment';
CREATE INDEX IF NOT EXISTS pos_order_income_category_category_idx
  ON pos_order_income_category_allocations(venue_id,category_id,income_snapshot_id);

CREATE OR REPLACE FUNCTION guard_finance_income_mapping_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'finance_income_category_mappings_append_only' USING ERRCODE='55000'; END $$;
DROP TRIGGER IF EXISTS finance_income_mapping_immutable ON finance_income_category_mappings;
CREATE TRIGGER finance_income_mapping_immutable BEFORE UPDATE OR DELETE ON finance_income_category_mappings
  FOR EACH ROW EXECUTE FUNCTION guard_finance_income_mapping_immutable();

CREATE OR REPLACE FUNCTION guard_pos_order_income_snapshot_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snapshot_state text;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'pos_order_income_category_history_immutable' USING ERRCODE='55000'; END IF;
  SELECT status INTO snapshot_state FROM pos_order_income_category_snapshots
    WHERE venue_id=NEW.venue_id AND id=NEW.income_snapshot_id FOR UPDATE;
  IF snapshot_state IS DISTINCT FROM 'building' THEN
    RAISE EXCEPTION 'pos_order_income_category_snapshot_sealed' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pos_order_income_allocations_immutable ON pos_order_income_category_allocations;
CREATE TRIGGER pos_order_income_allocations_immutable BEFORE INSERT OR UPDATE OR DELETE ON pos_order_income_category_allocations
  FOR EACH ROW EXECUTE FUNCTION guard_pos_order_income_snapshot_mutation();

CREATE OR REPLACE FUNCTION validate_pos_order_income_category_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allocation_total bigint; unmapped_total bigint; source_total bigint; item_count bigint; allocation_count bigint;
BEGIN
  IF TG_OP<>'UPDATE' OR OLD.status<>'building' OR NEW.status NOT IN ('complete','unmapped')
      OR NEW.venue_id IS DISTINCT FROM OLD.venue_id OR NEW.order_id IS DISTINCT FROM OLD.order_id
      OR NEW.pricing_snapshot_id IS DISTINCT FROM OLD.pricing_snapshot_id OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
      OR NEW.venue_date IS DISTINCT FROM OLD.venue_date OR NEW.recognized_total_minor IS DISTINCT FROM OLD.recognized_total_minor
      OR NEW.unmapped_minor IS DISTINCT FROM OLD.unmapped_minor OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'pos_order_income_snapshot_transition_invalid' USING ERRCODE='55000';
  END IF;
  SELECT COALESCE(SUM(amount_minor),0),COALESCE(SUM(amount_minor) FILTER(WHERE category_id IS NULL),0),COUNT(*)
    INTO allocation_total,unmapped_total,allocation_count
    FROM pos_order_income_category_allocations WHERE venue_id=NEW.venue_id AND income_snapshot_id=NEW.id;
  SELECT final_total_minor INTO source_total FROM pos_order_pricing_snapshots
    WHERE venue_id=NEW.venue_id AND id=NEW.pricing_snapshot_id AND order_id=NEW.order_id;
  SELECT COUNT(*) INTO item_count FROM pos_order_pricing_snapshot_lines
    WHERE venue_id=NEW.venue_id AND snapshot_id=NEW.pricing_snapshot_id AND order_id=NEW.order_id;
  IF allocation_total<>NEW.recognized_total_minor OR source_total<>NEW.recognized_total_minor
      OR unmapped_total<>NEW.unmapped_minor OR allocation_count<>item_count + (CASE WHEN EXISTS(
        SELECT 1 FROM pos_order_pricing_snapshots WHERE venue_id=NEW.venue_id AND id=NEW.pricing_snapshot_id AND minimum_adjustment_minor>0
      ) THEN 1 ELSE 0 END)
      OR NEW.status IS DISTINCT FROM (CASE WHEN unmapped_total>0 THEN 'unmapped' ELSE 'complete' END) THEN
    RAISE EXCEPTION 'pos_order_income_category_snapshot_reconciliation_failed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pos_order_income_snapshot_validate ON pos_order_income_category_snapshots;
CREATE TRIGGER pos_order_income_snapshot_validate BEFORE UPDATE ON pos_order_income_category_snapshots
  FOR EACH ROW EXECUTE FUNCTION validate_pos_order_income_category_snapshot();
CREATE OR REPLACE FUNCTION guard_pos_order_income_snapshot_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.status='building' AND NEW.status IN ('complete','unmapped') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'pos_order_income_category_snapshots_immutable' USING ERRCODE='55000';
END $$;
DROP TRIGGER IF EXISTS pos_order_income_snapshot_no_mutation ON pos_order_income_category_snapshots;
CREATE TRIGGER pos_order_income_snapshot_no_mutation BEFORE UPDATE OR DELETE ON pos_order_income_category_snapshots
  FOR EACH ROW EXECUTE FUNCTION guard_pos_order_income_snapshot_immutable();
-- Explicit finance-category classification for persisted payroll accruals and
-- supplier documents. Historical source records remain unclassified.

ALTER TABLE payroll_entries
  ADD COLUMN IF NOT EXISTS finance_category_id uuid,
  ADD COLUMN IF NOT EXISTS finance_category_name_snapshot text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='payroll_entries_finance_category_fk' AND conrelid='payroll_entries'::regclass) THEN
    ALTER TABLE payroll_entries ADD CONSTRAINT payroll_entries_finance_category_fk
      FOREIGN KEY (venue_id,finance_category_id) REFERENCES finance_categories(venue_id,id) ON DELETE RESTRICT;
  END IF;
END $$;

ALTER TABLE inventory_purchase_documents
  ADD COLUMN IF NOT EXISTS finance_category_id uuid,
  ADD COLUMN IF NOT EXISTS finance_category_name_snapshot text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_purchase_documents_finance_category_fk' AND conrelid='inventory_purchase_documents'::regclass) THEN
    ALTER TABLE inventory_purchase_documents ADD CONSTRAINT inventory_purchase_documents_finance_category_fk
      FOREIGN KEY (venue_id,finance_category_id) REFERENCES finance_categories(venue_id,id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS payroll_entries_venue_finance_category_idx
  ON payroll_entries(venue_id,finance_category_id) WHERE finance_category_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inventory_purchase_documents_venue_finance_category_idx
  ON inventory_purchase_documents(venue_id,finance_category_id) WHERE finance_category_id IS NOT NULL;

CREATE OR REPLACE FUNCTION validate_payroll_finance_category()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE category_name text; category_kind text; category_active boolean;
BEGIN
  -- Never allow a classified historical entry to be moved between tenants.
  IF TG_OP='UPDATE' AND OLD.venue_id IS DISTINCT FROM NEW.venue_id
     AND (OLD.finance_category_id IS NOT NULL OR NEW.finance_category_id IS NOT NULL
       OR OLD.finance_category_name_snapshot IS NOT NULL OR NEW.finance_category_name_snapshot IS NOT NULL) THEN
    RAISE EXCEPTION 'payroll_finance_category_venue_immutable' USING ERRCODE='55000';
  END IF;

  IF TG_OP='UPDATE' AND OLD.status <> 'draft' THEN
    IF OLD.finance_category_id IS DISTINCT FROM NEW.finance_category_id
       OR OLD.finance_category_name_snapshot IS DISTINCT FROM NEW.finance_category_name_snapshot THEN
      RAISE EXCEPTION 'payroll_finance_category_immutable' USING ERRCODE='55000';
    END IF;
    -- Approval/payment/cancellation transitions preserve the exact snapshot.
    -- In particular, an archived category must not block a later transition.
    RETURN NEW;
  END IF;

  IF TG_OP='UPDATE' AND OLD.status='draft' AND NEW.status='cancelled' THEN
    IF OLD.finance_category_id IS DISTINCT FROM NEW.finance_category_id
       OR OLD.finance_category_name_snapshot IS DISTINCT FROM NEW.finance_category_name_snapshot THEN
      RAISE EXCEPTION 'payroll_finance_category_immutable' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;

  -- Legacy rows remain NULL. A snapshot without a stable category ID is never
  -- accepted, including when supplied by a caller during draft editing.
  IF NEW.finance_category_id IS NULL THEN
    IF TG_OP='UPDATE' AND OLD.finance_category_id IS NOT NULL THEN
      -- Explicitly clearing a draft classification also clears its snapshot.
      NEW.finance_category_name_snapshot := NULL;
      RETURN NEW;
    ELSIF NEW.finance_category_name_snapshot IS NOT NULL THEN
      RAISE EXCEPTION 'payroll_finance_category_snapshot_without_id' USING ERRCODE='23514';
    END IF;
    NEW.finance_category_name_snapshot := NULL;
    RETURN NEW;
  END IF;

  IF TG_OP='UPDATE'
     AND OLD.finance_category_id IS NOT DISTINCT FROM NEW.finance_category_id
     AND OLD.finance_category_name_snapshot IS NOT DISTINCT FROM NEW.finance_category_name_snapshot
     AND NEW.status <> 'approved' THEN
    -- Unrelated draft edits preserve an existing snapshot, even if its
    -- category was archived. Active status is required on assignment/approval.
    RETURN NEW;
  END IF;

  -- Validate whenever a draft is classified and again at draft -> approved.
  -- FOR SHARE serializes against category rename/archive/kind changes.
  SELECT name,kind,active INTO category_name,category_kind,category_active
    FROM finance_categories WHERE venue_id=NEW.venue_id AND id=NEW.finance_category_id FOR SHARE;
  IF NOT FOUND OR category_kind <> 'expense' OR NOT category_active THEN
    RAISE EXCEPTION 'invalid_payroll_finance_category' USING ERRCODE='23514';
  END IF;
  NEW.finance_category_name_snapshot := category_name;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS payroll_entries_finance_category_guard ON payroll_entries;
CREATE TRIGGER payroll_entries_finance_category_guard
  BEFORE INSERT OR UPDATE OF venue_id,status,finance_category_id,finance_category_name_snapshot
  ON payroll_entries FOR EACH ROW EXECUTE FUNCTION validate_payroll_finance_category();

CREATE OR REPLACE FUNCTION validate_purchase_document_finance_category()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE category_name text; category_kind text; category_active boolean;
BEGIN
  IF TG_OP='UPDATE' AND OLD.venue_id IS DISTINCT FROM NEW.venue_id
     AND (OLD.finance_category_id IS NOT NULL OR NEW.finance_category_id IS NOT NULL
       OR OLD.finance_category_name_snapshot IS NOT NULL OR NEW.finance_category_name_snapshot IS NOT NULL) THEN
    RAISE EXCEPTION 'purchase_document_finance_category_venue_immutable' USING ERRCODE='55000';
  END IF;

  IF TG_OP='UPDATE' AND OLD.status IN ('posted','voided') THEN
    IF OLD.finance_category_id IS DISTINCT FROM NEW.finance_category_id
       OR OLD.finance_category_name_snapshot IS DISTINCT FROM NEW.finance_category_name_snapshot THEN
      RAISE EXCEPTION 'purchase_document_finance_category_immutable' USING ERRCODE='55000';
    END IF;
    -- Posting/void/reversal lifecycle changes preserve history even after the
    -- category is archived; do not revalidate its current active flag here.
    RETURN NEW;
  END IF;

  IF TG_OP='UPDATE' AND OLD.status='draft' AND NEW.status='voided' THEN
    IF OLD.finance_category_id IS DISTINCT FROM NEW.finance_category_id
       OR OLD.finance_category_name_snapshot IS DISTINCT FROM NEW.finance_category_name_snapshot THEN
      RAISE EXCEPTION 'purchase_document_finance_category_immutable' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;

  -- A snapshot cannot be forged or retained without its stable category ID.
  IF NEW.finance_category_id IS NULL THEN
    IF TG_OP='UPDATE' AND OLD.finance_category_id IS NOT NULL THEN
      -- Clearing a draft classification clears its captured name as well.
      NEW.finance_category_name_snapshot := NULL;
      RETURN NEW;
    ELSIF NEW.finance_category_name_snapshot IS NOT NULL THEN
      RAISE EXCEPTION 'purchase_document_finance_category_snapshot_without_id' USING ERRCODE='23514';
    END IF;
    NEW.finance_category_name_snapshot := NULL;
    RETURN NEW;
  END IF;

  IF TG_OP='UPDATE'
     AND OLD.finance_category_id IS NOT DISTINCT FROM NEW.finance_category_id
     AND OLD.finance_category_name_snapshot IS NOT DISTINCT FROM NEW.finance_category_name_snapshot
     AND NEW.status <> 'posted' THEN
    -- Unrelated draft edits preserve the snapshot; posting still revalidates.
    RETURN NEW;
  END IF;

  -- Draft assignment and draft -> posted both require a current expense
  -- category. The lock serializes assignment against category kind/archive.
  SELECT name,kind,active INTO category_name,category_kind,category_active
    FROM finance_categories WHERE venue_id=NEW.venue_id AND id=NEW.finance_category_id FOR SHARE;
  IF NOT FOUND OR category_kind <> 'expense' OR NOT category_active THEN
    RAISE EXCEPTION 'invalid_purchase_document_finance_category' USING ERRCODE='23514';
  END IF;
  NEW.finance_category_name_snapshot := category_name;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS inventory_purchase_documents_finance_category_guard ON inventory_purchase_documents;
CREATE TRIGGER inventory_purchase_documents_finance_category_guard
  BEFORE INSERT OR UPDATE OF venue_id,status,finance_category_id,finance_category_name_snapshot
  ON inventory_purchase_documents FOR EACH ROW EXECUTE FUNCTION validate_purchase_document_finance_category();

-- Category direction is immutable once any payroll or purchase source uses it.
-- Assignment triggers take FOR SHARE on the category row, so this UPDATE's
-- row lock serializes the check with concurrent classifications.
CREATE OR REPLACE FUNCTION guard_finance_category_source_kind()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind AND (
       EXISTS (SELECT 1 FROM payroll_entries pe WHERE pe.venue_id=OLD.venue_id AND pe.finance_category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM inventory_purchase_documents d WHERE d.venue_id=OLD.venue_id AND d.finance_category_id=OLD.id)
     ) THEN
    RAISE EXCEPTION 'finance_category_source_kind_immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS finance_category_source_kind_guard ON finance_categories;
CREATE TRIGGER finance_category_source_kind_guard
  BEFORE UPDATE OF kind ON finance_categories
  FOR EACH ROW EXECUTE FUNCTION guard_finance_category_source_kind();
-- Non-POS business income has its own recognition document and cash-receipt
-- events. Do not reuse POS tenders or the expense ledger.
CREATE TABLE IF NOT EXISTS finance_other_income_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  category_id uuid NOT NULL,
  category_name_snapshot text NOT NULL CHECK (length(btrim(category_name_snapshot)) BETWEEN 1 AND 80),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  counterparty_name text NOT NULL DEFAULT '' CHECK (length(counterparty_name) <= 160),
  basis text NOT NULL DEFAULT '' CHECK (length(basis) <= 500),
  document_reference text NOT NULL DEFAULT '' CHECK (length(document_reference) <= 160),
  recognition_date date NOT NULL,
  total_amount numeric(14,2) NOT NULL CHECK (total_amount > 0),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','cancelled')),
  created_by uuid,
  posted_by uuid,
  posted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,idempotency_key),
  FOREIGN KEY (venue_id,category_id) REFERENCES finance_categories(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,posted_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  CHECK ((status='posted' AND posted_by IS NOT NULL AND posted_at IS NOT NULL)
      OR (status<>'posted' AND posted_by IS NULL AND posted_at IS NULL))
);
CREATE INDEX IF NOT EXISTS finance_other_income_documents_date_idx
  ON finance_other_income_documents(venue_id,recognition_date,status,category_id);

CREATE TABLE IF NOT EXISTS finance_other_income_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  document_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  receipt_date date NOT NULL,
  payment_method text NOT NULL CHECK (payment_method IN ('cash','card','qr','bank_transfer','other')),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,idempotency_key),
  FOREIGN KEY (venue_id,document_id) REFERENCES finance_other_income_documents(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS finance_other_income_receipts_document_idx
  ON finance_other_income_receipts(venue_id,document_id,receipt_date,created_at,id);
CREATE INDEX IF NOT EXISTS finance_other_income_receipts_date_idx
  ON finance_other_income_receipts(venue_id,receipt_date,document_id);

CREATE OR REPLACE FUNCTION guard_finance_other_income_document()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE category_name text; category_kind text; category_active boolean;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'finance_other_income_document_immutable' USING ERRCODE='55000'; END IF;
  IF TG_OP='UPDATE' AND OLD.status<>'draft' THEN
    RAISE EXCEPTION 'finance_other_income_document_immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='UPDATE' AND OLD.venue_id IS DISTINCT FROM NEW.venue_id THEN
    RAISE EXCEPTION 'finance_other_income_venue_immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='draft' AND NEW.status NOT IN ('draft','posted','cancelled') THEN
    RAISE EXCEPTION 'finance_other_income_document_transition_invalid' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='draft' AND NEW.status='cancelled'
      AND (OLD.venue_id IS DISTINCT FROM NEW.venue_id OR OLD.category_id IS DISTINCT FROM NEW.category_id
        OR OLD.title IS DISTINCT FROM NEW.title OR OLD.counterparty_name IS DISTINCT FROM NEW.counterparty_name
        OR OLD.basis IS DISTINCT FROM NEW.basis OR OLD.document_reference IS DISTINCT FROM NEW.document_reference
        OR OLD.recognition_date IS DISTINCT FROM NEW.recognition_date OR OLD.total_amount IS DISTINCT FROM NEW.total_amount) THEN
    RAISE EXCEPTION 'finance_other_income_document_transition_invalid' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    SELECT name,kind,active INTO category_name,category_kind,category_active
      FROM finance_categories WHERE venue_id=NEW.venue_id AND id=NEW.category_id FOR KEY SHARE;
    IF category_kind IS DISTINCT FROM 'income' OR category_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'finance_other_income_category_invalid' USING ERRCODE='23514';
    END IF;
    NEW.category_name_snapshot := category_name;
  ELSIF TG_OP='UPDATE' AND OLD.category_id IS DISTINCT FROM NEW.category_id THEN
    SELECT name,kind,active INTO category_name,category_kind,category_active
      FROM finance_categories WHERE venue_id=NEW.venue_id AND id=NEW.category_id FOR KEY SHARE;
    IF category_kind IS DISTINCT FROM 'income' OR category_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'finance_other_income_category_invalid' USING ERRCODE='23514';
    END IF;
    NEW.category_name_snapshot := category_name;
  ELSIF TG_OP='UPDATE' THEN
    NEW.category_name_snapshot := OLD.category_name_snapshot;
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='draft' AND NEW.status='posted' THEN
    SELECT name,kind,active INTO category_name,category_kind,category_active
      FROM finance_categories WHERE venue_id=NEW.venue_id AND id=NEW.category_id FOR KEY SHARE;
    IF category_kind IS DISTINCT FROM 'income' OR category_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'finance_other_income_category_invalid' USING ERRCODE='23514';
    END IF;
    NEW.category_name_snapshot := category_name;
    NEW.posted_at := COALESCE(NEW.posted_at,now());
    IF NEW.posted_by IS NULL THEN RAISE EXCEPTION 'finance_other_income_actor_required' USING ERRCODE='23514'; END IF;
  ELSE
    NEW.posted_at := NULL;
    NEW.posted_by := NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_other_income_document_guard ON finance_other_income_documents;
CREATE TRIGGER finance_other_income_document_guard
  BEFORE INSERT OR UPDATE OR DELETE ON finance_other_income_documents
  FOR EACH ROW EXECUTE FUNCTION guard_finance_other_income_document();

CREATE OR REPLACE FUNCTION guard_finance_other_income_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE document finance_other_income_documents%ROWTYPE; received numeric(14,2);
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'finance_other_income_receipts_append_only' USING ERRCODE='55000'; END IF;
  SELECT * INTO document FROM finance_other_income_documents
    WHERE venue_id=NEW.venue_id AND id=NEW.document_id FOR UPDATE;
  IF document.id IS NULL OR document.status<>'posted' THEN
    RAISE EXCEPTION 'finance_other_income_document_not_receivable' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(SUM(amount),0)::numeric(14,2) INTO received FROM finance_other_income_receipts
    WHERE venue_id=NEW.venue_id AND document_id=NEW.document_id;
  IF received+NEW.amount>document.total_amount THEN
    RAISE EXCEPTION 'finance_other_income_receipt_exceeds_balance' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_other_income_receipt_guard ON finance_other_income_receipts;
CREATE TRIGGER finance_other_income_receipt_guard
  BEFORE INSERT OR UPDATE OR DELETE ON finance_other_income_receipts
  FOR EACH ROW EXECUTE FUNCTION guard_finance_other_income_receipt();

CREATE OR REPLACE FUNCTION guard_finance_other_income_category_kind()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind AND EXISTS (
    SELECT 1 FROM finance_other_income_documents d WHERE d.venue_id=OLD.venue_id AND d.category_id=OLD.id
  ) THEN RAISE EXCEPTION 'finance_category_source_kind_immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_other_income_category_kind_guard ON finance_categories;
CREATE TRIGGER finance_other_income_category_kind_guard
  BEFORE UPDATE OF kind ON finance_categories FOR EACH ROW EXECUTE FUNCTION guard_finance_other_income_category_kind();
-- Append-only correction events for recognized non-POS income and cash refunds.
CREATE TABLE IF NOT EXISTS finance_other_income_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  document_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  correction_date date NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  document_reference text NOT NULL DEFAULT '' CHECK (length(document_reference) <= 160),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,idempotency_key),
  FOREIGN KEY (venue_id,document_id) REFERENCES finance_other_income_documents(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS finance_other_income_corrections_document_idx
  ON finance_other_income_corrections(venue_id,document_id,correction_date,created_at,id);
CREATE INDEX IF NOT EXISTS finance_other_income_corrections_date_idx
  ON finance_other_income_corrections(venue_id,correction_date,document_id);

CREATE OR REPLACE FUNCTION guard_finance_other_income_correction()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE document finance_other_income_documents%ROWTYPE; corrected numeric(14,2);
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'finance_other_income_corrections_append_only' USING ERRCODE='55000'; END IF;
  SELECT * INTO document FROM finance_other_income_documents WHERE venue_id=NEW.venue_id AND id=NEW.document_id FOR UPDATE;
  IF document.id IS NULL OR document.status<>'posted' THEN
    RAISE EXCEPTION 'finance_other_income_document_not_correctable' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(SUM(amount),0)::numeric(14,2) INTO corrected FROM finance_other_income_corrections
    WHERE venue_id=NEW.venue_id AND document_id=NEW.document_id;
  IF corrected+NEW.amount>document.total_amount THEN
    RAISE EXCEPTION 'finance_other_income_correction_exceeds_recognition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_other_income_correction_guard ON finance_other_income_corrections;
CREATE TRIGGER finance_other_income_correction_guard
  BEFORE INSERT OR UPDATE OR DELETE ON finance_other_income_corrections
  FOR EACH ROW EXECUTE FUNCTION guard_finance_other_income_correction();

CREATE TABLE IF NOT EXISTS finance_other_income_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  document_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  refund_date date NOT NULL,
  payout_method text NOT NULL CHECK (payout_method IN ('cash','card','qr','bank_transfer','other')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,idempotency_key),
  FOREIGN KEY (venue_id,document_id) REFERENCES finance_other_income_documents(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,receipt_id) REFERENCES finance_other_income_receipts(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS finance_other_income_refunds_receipt_idx
  ON finance_other_income_refunds(venue_id,receipt_id,refund_date,created_at,id);
CREATE INDEX IF NOT EXISTS finance_other_income_refunds_date_idx
  ON finance_other_income_refunds(venue_id,refund_date,document_id);

CREATE OR REPLACE FUNCTION guard_finance_other_income_refund()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE document finance_other_income_documents%ROWTYPE; receipt finance_other_income_receipts%ROWTYPE; refunded numeric(14,2);
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'finance_other_income_refunds_append_only' USING ERRCODE='55000'; END IF;
  SELECT * INTO document FROM finance_other_income_documents WHERE venue_id=NEW.venue_id AND id=NEW.document_id FOR UPDATE;
  IF document.id IS NULL OR document.status<>'posted' THEN
    RAISE EXCEPTION 'finance_other_income_document_not_refundable' USING ERRCODE='23514';
  END IF;
  SELECT * INTO receipt FROM finance_other_income_receipts WHERE venue_id=NEW.venue_id AND id=NEW.receipt_id AND document_id=NEW.document_id FOR UPDATE;
  IF receipt.id IS NULL THEN RAISE EXCEPTION 'finance_other_income_receipt_not_found' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(SUM(amount),0)::numeric(14,2) INTO refunded FROM finance_other_income_refunds
    WHERE venue_id=NEW.venue_id AND receipt_id=NEW.receipt_id;
  IF refunded+NEW.amount>receipt.amount THEN
    RAISE EXCEPTION 'finance_other_income_refund_exceeds_receipt' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_other_income_refund_guard ON finance_other_income_refunds;
CREATE TRIGGER finance_other_income_refund_guard
  BEFORE INSERT OR UPDATE OR DELETE ON finance_other_income_refunds
  FOR EACH ROW EXECUTE FUNCTION guard_finance_other_income_refund();
-- Explicit accrual recognition for approved business payables. Cash remains in expenses.
CREATE TABLE IF NOT EXISTS finance_payable_recognitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  payable_id uuid NOT NULL,
  category_id uuid NOT NULL,
  category_name_snapshot text NOT NULL CHECK (length(btrim(category_name_snapshot)) BETWEEN 1 AND 80),
  title_snapshot text NOT NULL CHECK (length(btrim(title_snapshot)) BETWEEN 1 AND 160),
  counterparty_name_snapshot text NOT NULL DEFAULT '' CHECK (length(counterparty_name_snapshot) <= 160),
  basis_snapshot text NOT NULL DEFAULT '' CHECK (length(basis_snapshot) <= 500),
  service_period_from date NOT NULL,
  service_period_to date NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  recognition_date date NOT NULL,
  document_reference text CHECK (document_reference IS NULL OR length(document_reference) <= 200),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,payable_id),
  UNIQUE (venue_id,idempotency_key),
  FOREIGN KEY (venue_id,payable_id) REFERENCES finance_payables(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,category_id) REFERENCES finance_categories(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  CHECK (service_period_to >= service_period_from)
);
CREATE INDEX IF NOT EXISTS finance_payable_recognitions_date_idx
  ON finance_payable_recognitions(venue_id,recognition_date,category_id);
CREATE INDEX IF NOT EXISTS finance_payable_recognitions_period_idx
  ON finance_payable_recognitions(venue_id,service_period_from,service_period_to,payable_id);

CREATE TABLE IF NOT EXISTS finance_payable_recognition_reversals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  recognition_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  reversal_date date NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  document_reference text CHECK (document_reference IS NULL OR length(document_reference) <= 200),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,idempotency_key),
  FOREIGN KEY (venue_id,recognition_id) REFERENCES finance_payable_recognitions(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS finance_payable_recognition_reversals_date_idx
  ON finance_payable_recognition_reversals(venue_id,reversal_date,recognition_id);

CREATE OR REPLACE FUNCTION guard_finance_payable_recognition_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p finance_payables%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'finance_payable_recognitions_append_only' USING ERRCODE='55000'; END IF;
  SELECT * INTO p FROM finance_payables WHERE venue_id=NEW.venue_id AND id=NEW.payable_id FOR UPDATE;
  IF p.id IS NULL OR p.status <> 'approved' OR p.total_amount <> NEW.amount
      OR p.category_id <> NEW.category_id OR p.category_name_snapshot <> NEW.category_name_snapshot
      OR p.title <> NEW.title_snapshot OR p.counterparty_name <> NEW.counterparty_name_snapshot
      OR p.basis <> NEW.basis_snapshot OR p.period_from <> NEW.service_period_from OR p.period_to <> NEW.service_period_to THEN
    RAISE EXCEPTION 'finance_payable_recognition_invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_payable_recognitions_guard ON finance_payable_recognitions;
CREATE TRIGGER finance_payable_recognitions_guard BEFORE INSERT OR UPDATE OR DELETE ON finance_payable_recognitions
  FOR EACH ROW EXECUTE FUNCTION guard_finance_payable_recognition_immutable();

CREATE OR REPLACE FUNCTION guard_finance_payable_recognition_reversal_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payable_row finance_payables%ROWTYPE; r finance_payable_recognitions%ROWTYPE; reversed numeric(14,2);
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'finance_payable_recognition_reversals_append_only' USING ERRCODE='55000'; END IF;
  SELECT fp.* INTO payable_row FROM finance_payables fp JOIN finance_payable_recognitions source
    ON source.venue_id=fp.venue_id AND source.payable_id=fp.id
    WHERE source.venue_id=NEW.venue_id AND source.id=NEW.recognition_id FOR UPDATE OF fp;
  SELECT * INTO r FROM finance_payable_recognitions WHERE venue_id=NEW.venue_id AND id=NEW.recognition_id;
  IF payable_row.id IS NULL OR r.id IS NULL THEN RAISE EXCEPTION 'finance_payable_recognition_not_found' USING ERRCODE='23503'; END IF;
  SELECT COALESCE(SUM(amount),0)::numeric(14,2) INTO reversed
    FROM finance_payable_recognition_reversals WHERE venue_id=NEW.venue_id AND recognition_id=NEW.recognition_id;
  IF reversed + NEW.amount > r.amount THEN RAISE EXCEPTION 'finance_payable_recognition_reversal_exceeds_balance' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_payable_recognition_reversals_guard ON finance_payable_recognition_reversals;
CREATE TRIGGER finance_payable_recognition_reversals_guard BEFORE INSERT OR UPDATE OR DELETE ON finance_payable_recognition_reversals
  FOR EACH ROW EXECUTE FUNCTION guard_finance_payable_recognition_reversal_immutable();

-- A recognized obligation can only be cancelled after full recognition reversal;
-- existing payment links continue to prohibit cancellation of paid obligations.
CREATE OR REPLACE FUNCTION guard_finance_payable_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE recognized numeric(14,2);
BEGIN
  IF OLD.status <> 'draft' AND (
    OLD.venue_id IS DISTINCT FROM NEW.venue_id OR OLD.category_id IS DISTINCT FROM NEW.category_id
    OR OLD.category_name_snapshot IS DISTINCT FROM NEW.category_name_snapshot OR OLD.title IS DISTINCT FROM NEW.title
    OR OLD.counterparty_name IS DISTINCT FROM NEW.counterparty_name OR OLD.basis IS DISTINCT FROM NEW.basis
    OR OLD.period_from IS DISTINCT FROM NEW.period_from OR OLD.period_to IS DISTINCT FROM NEW.period_to
    OR OLD.due_date IS DISTINCT FROM NEW.due_date OR OLD.total_amount IS DISTINCT FROM NEW.total_amount
    OR OLD.recurring_rule_id IS DISTINCT FROM NEW.recurring_rule_id OR OLD.recurring_version_id IS DISTINCT FROM NEW.recurring_version_id
    OR OLD.period_key IS DISTINCT FROM NEW.period_key
  ) THEN RAISE EXCEPTION 'finance_payable_immutable' USING ERRCODE='55000'; END IF;
  IF OLD.status='approved' AND NEW.status='cancelled' THEN
    IF EXISTS (SELECT 1 FROM finance_payable_payment_links WHERE venue_id=OLD.venue_id AND payable_id=OLD.id) THEN
      RAISE EXCEPTION 'finance_payable_has_payments' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(r.amount,0)-COALESCE(SUM(x.amount),0) INTO recognized
      FROM finance_payable_recognitions r LEFT JOIN finance_payable_recognition_reversals x
        ON x.venue_id=r.venue_id AND x.recognition_id=r.id
      WHERE r.venue_id=OLD.venue_id AND r.payable_id=OLD.id GROUP BY r.amount;
    IF COALESCE(recognized,0)>0 THEN RAISE EXCEPTION 'finance_payable_has_recognition' USING ERRCODE='23514'; END IF;
  ELSIF OLD.status <> NEW.status AND NOT (OLD.status='draft' AND NEW.status IN ('approved','cancelled')) THEN
    RAISE EXCEPTION 'finance_payable_transition_invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
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
ALTER TABLE finance_payables
  ADD COLUMN IF NOT EXISTS variable_amount_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS variable_amount_confirmed_by uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='finance_payables_variable_amount_confirmed_by_fk'
      AND conrelid='finance_payables'::regclass
  ) THEN
    ALTER TABLE finance_payables
      ADD CONSTRAINT finance_payables_variable_amount_confirmed_by_fk
      FOREIGN KEY (venue_id,variable_amount_confirmed_by)
      REFERENCES users(venue_id,id) ON DELETE RESTRICT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='finance_payables_variable_amount_confirmation_pair_check'
      AND conrelid='finance_payables'::regclass
  ) THEN
    ALTER TABLE finance_payables
      ADD CONSTRAINT finance_payables_variable_amount_confirmation_pair_check
      CHECK ((variable_amount_confirmed_at IS NULL) = (variable_amount_confirmed_by IS NULL));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION guard_finance_payable_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE recognized numeric(14,2);
BEGIN
  IF OLD.status <> 'draft' AND (
    OLD.venue_id IS DISTINCT FROM NEW.venue_id OR OLD.category_id IS DISTINCT FROM NEW.category_id
    OR OLD.category_name_snapshot IS DISTINCT FROM NEW.category_name_snapshot
    OR OLD.title IS DISTINCT FROM NEW.title OR OLD.counterparty_name IS DISTINCT FROM NEW.counterparty_name
    OR OLD.basis IS DISTINCT FROM NEW.basis OR OLD.period_from IS DISTINCT FROM NEW.period_from
    OR OLD.period_to IS DISTINCT FROM NEW.period_to OR OLD.due_date IS DISTINCT FROM NEW.due_date
    OR OLD.total_amount IS DISTINCT FROM NEW.total_amount OR OLD.recurring_rule_id IS DISTINCT FROM NEW.recurring_rule_id
    OR OLD.recurring_version_id IS DISTINCT FROM NEW.recurring_version_id OR OLD.period_key IS DISTINCT FROM NEW.period_key
    OR OLD.variable_amount_confirmed_at IS DISTINCT FROM NEW.variable_amount_confirmed_at
    OR OLD.variable_amount_confirmed_by IS DISTINCT FROM NEW.variable_amount_confirmed_by
  ) THEN RAISE EXCEPTION 'finance_payable_immutable' USING ERRCODE='55000'; END IF;
  IF OLD.status='approved' AND NEW.status='cancelled' THEN
    IF EXISTS (SELECT 1 FROM finance_payable_payment_links WHERE venue_id=OLD.venue_id AND payable_id=OLD.id) THEN
      RAISE EXCEPTION 'finance_payable_has_payments' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(r.amount,0)-COALESCE(SUM(x.amount),0) INTO recognized
      FROM finance_payable_recognitions r LEFT JOIN finance_payable_recognition_reversals x
        ON x.venue_id=r.venue_id AND x.recognition_id=r.id
      WHERE r.venue_id=OLD.venue_id AND r.payable_id=OLD.id GROUP BY r.amount;
    IF COALESCE(recognized,0)>0 THEN RAISE EXCEPTION 'finance_payable_has_recognition' USING ERRCODE='23514'; END IF;
  ELSIF OLD.status <> NEW.status AND NOT (OLD.status='draft' AND NEW.status IN ('approved','cancelled')) THEN
    RAISE EXCEPTION 'finance_payable_transition_invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION validate_finance_payable_posting()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line_total numeric(14,2); category_kind text; category_active boolean; variable_amount boolean;
BEGIN
  IF OLD.status='draft' AND NEW.status='approved' THEN
    SELECT kind,active INTO category_kind,category_active FROM finance_categories
      WHERE venue_id=NEW.venue_id AND id=NEW.category_id FOR KEY SHARE;
    IF category_kind IS DISTINCT FROM 'expense' OR category_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'finance_payable_category_invalid' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(bool_or(variable_amount),false) INTO variable_amount
      FROM finance_recurring_rule_versions
      WHERE venue_id=NEW.venue_id AND rule_id=NEW.recurring_rule_id AND id=NEW.recurring_version_id;
    IF variable_amount AND (NEW.variable_amount_confirmed_at IS NULL OR NEW.variable_amount_confirmed_by IS NULL) THEN
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
-- A shared venue-scoped account catalog. Existing ledgers remain canonical.
CREATE TABLE IF NOT EXISTS finance_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (length(btrim(code)) BETWEEN 1 AND 64),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  kind text NOT NULL CHECK (kind IN ('pos_cashbox','cash','bank','electronic')),
  allowed_payment_methods text[] NOT NULL DEFAULT ARRAY[]::text[],
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,code),
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  CHECK (cardinality(allowed_payment_methods) > 0),
  CHECK (allowed_payment_methods <@ ARRAY['cash','card','bank_transfer','other']::text[]),
  CHECK ((kind='pos_cashbox' AND allowed_payment_methods <@ ARRAY['cash']::text[])
    OR (kind='cash' AND allowed_payment_methods <@ ARRAY['cash']::text[])
    OR (kind='bank' AND allowed_payment_methods <@ ARRAY['bank_transfer','card','other']::text[])
    OR (kind='electronic' AND allowed_payment_methods <@ ARRAY['card','other']::text[]))
);
CREATE UNIQUE INDEX IF NOT EXISTS finance_accounts_one_active_pos_cashbox_idx
  ON finance_accounts(venue_id) WHERE kind='pos_cashbox' AND active;

CREATE OR REPLACE FUNCTION ensure_finance_account_defaults(target_venue uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO finance_accounts(venue_id,code,name,kind,allowed_payment_methods)
  VALUES(target_venue,'main_cashbox','Основная касса','pos_cashbox',ARRAY['cash']::text[])
  ON CONFLICT (venue_id,code) DO NOTHING;
END; $$;

CREATE OR REPLACE FUNCTION seed_finance_accounts_for_venue() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  PERFORM ensure_finance_account_defaults(NEW.id); RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS venues_seed_finance_accounts ON venues;
CREATE TRIGGER venues_seed_finance_accounts AFTER INSERT ON venues
  FOR EACH ROW EXECUTE FUNCTION seed_finance_accounts_for_venue();
DO $$ DECLARE venue_row record; BEGIN
  FOR venue_row IN SELECT id FROM venues LOOP
    PERFORM ensure_finance_account_defaults(venue_row.id);
  END LOOP;
END $$;

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS finance_account_id uuid;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS finance_account_name_snapshot text;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS shift_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='expenses_venue_finance_account_fk' AND conrelid='expenses'::regclass) THEN
    ALTER TABLE expenses ADD CONSTRAINT expenses_venue_finance_account_fk
      FOREIGN KEY (venue_id,finance_account_id) REFERENCES finance_accounts(venue_id,id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='expenses_venue_shift_fk' AND conrelid='expenses'::regclass) THEN
    ALTER TABLE expenses ADD CONSTRAINT expenses_venue_shift_fk
      FOREIGN KEY (venue_id,shift_id) REFERENCES shifts(venue_id,id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='expenses_finance_account_snapshot_check' AND conrelid='expenses'::regclass) THEN
    ALTER TABLE expenses ADD CONSTRAINT expenses_finance_account_snapshot_check
      CHECK ((finance_account_id IS NULL AND finance_account_name_snapshot IS NULL)
        OR (finance_account_id IS NOT NULL AND length(btrim(finance_account_name_snapshot)) BETWEEN 1 AND 120));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='expenses_shift_requires_finance_account' AND conrelid='expenses'::regclass) THEN
    ALTER TABLE expenses ADD CONSTRAINT expenses_shift_requires_finance_account
      CHECK (shift_id IS NULL OR (finance_account_id IS NOT NULL AND payment_method='cash'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS expenses_venue_finance_account_date_idx
  ON expenses(venue_id,finance_account_id,expense_date) WHERE finance_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS expenses_venue_shift_idx
  ON expenses(venue_id,shift_id) WHERE shift_id IS NOT NULL;

CREATE OR REPLACE FUNCTION guard_finance_account_event_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE account_row finance_accounts%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND (
    OLD.finance_account_id IS DISTINCT FROM NEW.finance_account_id
    OR OLD.finance_account_name_snapshot IS DISTINCT FROM NEW.finance_account_name_snapshot
    OR OLD.shift_id IS DISTINCT FROM NEW.shift_id
  ) THEN
    RAISE EXCEPTION 'finance_account_event_immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.finance_account_id IS NULL THEN
    IF NEW.finance_account_name_snapshot IS NOT NULL OR NEW.shift_id IS NOT NULL THEN
      RAISE EXCEPTION 'finance_account_snapshot_invalid' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO account_row FROM finance_accounts
    WHERE venue_id=NEW.venue_id AND id=NEW.finance_account_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'finance_account_not_found' USING ERRCODE='23503'; END IF;
  IF NEW.payment_method IS NULL OR NOT (NEW.payment_method=ANY(account_row.allowed_payment_methods)) THEN
    RAISE EXCEPTION 'finance_payment_method_account_mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND NOT account_row.active THEN
    RAISE EXCEPTION 'finance_account_inactive' USING ERRCODE='23514';
  END IF;
  IF account_row.kind='pos_cashbox' AND NEW.payment_method='cash' AND NEW.shift_id IS NULL THEN
    RAISE EXCEPTION 'finance_pos_cash_shift_required' USING ERRCODE='23514';
  END IF;
  IF NEW.shift_id IS NOT NULL AND (account_row.kind<>'pos_cashbox' OR NEW.payment_method<>'cash') THEN
    RAISE EXCEPTION 'finance_account_shift_mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND NOT account_row.active
    AND OLD.finance_account_id IS DISTINCT FROM NEW.finance_account_id THEN
    RAISE EXCEPTION 'finance_account_inactive' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS expenses_finance_account_snapshot_guard ON expenses;
CREATE TRIGGER expenses_finance_account_snapshot_guard
  BEFORE INSERT OR UPDATE OF venue_id,finance_account_id,finance_account_name_snapshot,shift_id,payment_method ON expenses
  FOR EACH ROW EXECUTE FUNCTION guard_finance_account_event_snapshot();

CREATE OR REPLACE FUNCTION guard_finance_account_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.venue_id IS DISTINCT FROM NEW.venue_id OR OLD.code IS DISTINCT FROM NEW.code OR OLD.kind IS DISTINCT FROM NEW.kind
    OR OLD.allowed_payment_methods IS DISTINCT FROM NEW.allowed_payment_methods THEN
    RAISE EXCEPTION 'finance_account_identity_immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.active=false AND NEW.active=true AND EXISTS (
    SELECT 1 FROM expenses e WHERE e.venue_id=OLD.venue_id AND e.finance_account_id=OLD.id
  ) THEN
    RAISE EXCEPTION 'finance_account_used_cannot_be_reactivated' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS finance_accounts_identity_guard ON finance_accounts;
CREATE TRIGGER finance_accounts_identity_guard BEFORE UPDATE ON finance_accounts
  FOR EACH ROW EXECUTE FUNCTION guard_finance_account_identity();
-- Connect actual other-income receipts and cash refunds to the shared account registry.
-- Existing events remain unattributed; account and shift are never inferred from payment method.
DO $$ DECLARE constraint_row record; BEGIN
  FOR constraint_row IN
    SELECT conname FROM pg_constraint
    WHERE conrelid='finance_accounts'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%<@%'
  LOOP
    EXECUTE format('ALTER TABLE finance_accounts DROP CONSTRAINT %I',constraint_row.conname);
  END LOOP;
END $$;
ALTER TABLE finance_accounts ADD CONSTRAINT finance_accounts_allowed_methods_v2_check
  CHECK (allowed_payment_methods <@ ARRAY['cash','card','qr','bank_transfer','other']::text[]);
ALTER TABLE finance_accounts ADD CONSTRAINT finance_accounts_method_matrix_v2_check
  CHECK ((kind='pos_cashbox' AND allowed_payment_methods <@ ARRAY['cash']::text[])
    OR (kind='cash' AND allowed_payment_methods <@ ARRAY['cash']::text[])
    OR (kind='bank' AND allowed_payment_methods <@ ARRAY['bank_transfer','card','other']::text[])
    OR (kind='electronic' AND allowed_payment_methods <@ ARRAY['card','qr','other']::text[]));

ALTER TABLE finance_other_income_receipts ADD COLUMN IF NOT EXISTS finance_account_id uuid;
ALTER TABLE finance_other_income_receipts ADD COLUMN IF NOT EXISTS finance_account_name_snapshot text;
ALTER TABLE finance_other_income_receipts ADD COLUMN IF NOT EXISTS shift_id uuid;
ALTER TABLE finance_other_income_refunds ADD COLUMN IF NOT EXISTS finance_account_id uuid;
ALTER TABLE finance_other_income_refunds ADD COLUMN IF NOT EXISTS finance_account_name_snapshot text;
ALTER TABLE finance_other_income_refunds ADD COLUMN IF NOT EXISTS shift_id uuid;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='other_income_receipts_venue_account_fk' AND conrelid='finance_other_income_receipts'::regclass) THEN
    ALTER TABLE finance_other_income_receipts ADD CONSTRAINT other_income_receipts_venue_account_fk
      FOREIGN KEY (venue_id,finance_account_id) REFERENCES finance_accounts(venue_id,id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='other_income_receipts_venue_shift_fk' AND conrelid='finance_other_income_receipts'::regclass) THEN
    ALTER TABLE finance_other_income_receipts ADD CONSTRAINT other_income_receipts_venue_shift_fk
      FOREIGN KEY (venue_id,shift_id) REFERENCES shifts(venue_id,id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='other_income_receipts_account_snapshot_check' AND conrelid='finance_other_income_receipts'::regclass) THEN
    ALTER TABLE finance_other_income_receipts ADD CONSTRAINT other_income_receipts_account_snapshot_check
      CHECK ((finance_account_id IS NULL AND finance_account_name_snapshot IS NULL) OR (finance_account_id IS NOT NULL AND length(btrim(finance_account_name_snapshot)) BETWEEN 1 AND 120));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='other_income_receipts_shift_account_check' AND conrelid='finance_other_income_receipts'::regclass) THEN
    ALTER TABLE finance_other_income_receipts ADD CONSTRAINT other_income_receipts_shift_account_check CHECK (shift_id IS NULL OR (finance_account_id IS NOT NULL AND payment_method='cash'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='other_income_refunds_venue_account_fk' AND conrelid='finance_other_income_refunds'::regclass) THEN
    ALTER TABLE finance_other_income_refunds ADD CONSTRAINT other_income_refunds_venue_account_fk
      FOREIGN KEY (venue_id,finance_account_id) REFERENCES finance_accounts(venue_id,id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='other_income_refunds_venue_shift_fk' AND conrelid='finance_other_income_refunds'::regclass) THEN
    ALTER TABLE finance_other_income_refunds ADD CONSTRAINT other_income_refunds_venue_shift_fk
      FOREIGN KEY (venue_id,shift_id) REFERENCES shifts(venue_id,id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='other_income_refunds_account_snapshot_check' AND conrelid='finance_other_income_refunds'::regclass) THEN
    ALTER TABLE finance_other_income_refunds ADD CONSTRAINT other_income_refunds_account_snapshot_check
      CHECK ((finance_account_id IS NULL AND finance_account_name_snapshot IS NULL) OR (finance_account_id IS NOT NULL AND length(btrim(finance_account_name_snapshot)) BETWEEN 1 AND 120));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='other_income_refunds_shift_account_check' AND conrelid='finance_other_income_refunds'::regclass) THEN
    ALTER TABLE finance_other_income_refunds ADD CONSTRAINT other_income_refunds_shift_account_check CHECK (shift_id IS NULL OR (finance_account_id IS NOT NULL AND payout_method='cash'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS finance_other_income_receipts_account_date_idx ON finance_other_income_receipts(venue_id,finance_account_id,receipt_date) WHERE finance_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS finance_other_income_receipts_shift_idx ON finance_other_income_receipts(venue_id,shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS finance_other_income_refunds_account_date_idx ON finance_other_income_refunds(venue_id,finance_account_id,refund_date) WHERE finance_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS finance_other_income_refunds_shift_idx ON finance_other_income_refunds(venue_id,shift_id) WHERE shift_id IS NOT NULL;

CREATE OR REPLACE FUNCTION guard_finance_other_income_account_event() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE account_row finance_accounts%ROWTYPE; event_method text;
BEGIN
  event_method:=COALESCE(to_jsonb(NEW)->>'payment_method',to_jsonb(NEW)->>'payout_method');
  IF TG_OP='UPDATE' AND (OLD.finance_account_id IS DISTINCT FROM NEW.finance_account_id
    OR OLD.finance_account_name_snapshot IS DISTINCT FROM NEW.finance_account_name_snapshot
    OR OLD.shift_id IS DISTINCT FROM NEW.shift_id) THEN
    RAISE EXCEPTION 'finance_account_event_immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.finance_account_id IS NULL THEN
    IF NEW.finance_account_name_snapshot IS NOT NULL OR NEW.shift_id IS NOT NULL THEN
      RAISE EXCEPTION 'finance_account_snapshot_invalid' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO account_row FROM finance_accounts WHERE venue_id=NEW.venue_id AND id=NEW.finance_account_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'finance_account_not_found' USING ERRCODE='23503'; END IF;
  IF event_method IS NULL OR NOT (event_method=ANY(account_row.allowed_payment_methods)) THEN
    RAISE EXCEPTION 'finance_payment_method_account_mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND NOT account_row.active THEN RAISE EXCEPTION 'finance_account_inactive' USING ERRCODE='23514'; END IF;
  IF account_row.kind='pos_cashbox' AND event_method='cash' AND NEW.shift_id IS NULL THEN
    RAISE EXCEPTION 'finance_pos_cash_shift_required' USING ERRCODE='23514';
  END IF;
  IF NEW.shift_id IS NOT NULL AND (account_row.kind<>'pos_cashbox' OR event_method<>'cash') THEN
    RAISE EXCEPTION 'finance_account_shift_mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND NOT account_row.active AND OLD.finance_account_id IS DISTINCT FROM NEW.finance_account_id THEN
    RAISE EXCEPTION 'finance_account_inactive' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_other_income_receipt_account_guard ON finance_other_income_receipts;
CREATE TRIGGER finance_other_income_receipt_account_guard BEFORE INSERT OR UPDATE OF venue_id,finance_account_id,finance_account_name_snapshot,shift_id,payment_method ON finance_other_income_receipts FOR EACH ROW EXECUTE FUNCTION guard_finance_other_income_account_event();
DROP TRIGGER IF EXISTS finance_other_income_refund_account_guard ON finance_other_income_refunds;
CREATE TRIGGER finance_other_income_refund_account_guard BEFORE INSERT OR UPDATE OF venue_id,finance_account_id,finance_account_name_snapshot,shift_id,payout_method ON finance_other_income_refunds FOR EACH ROW EXECUTE FUNCTION guard_finance_other_income_account_event();

CREATE OR REPLACE FUNCTION guard_finance_account_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.venue_id IS DISTINCT FROM NEW.venue_id OR OLD.code IS DISTINCT FROM NEW.code OR OLD.kind IS DISTINCT FROM NEW.kind
    OR OLD.allowed_payment_methods IS DISTINCT FROM NEW.allowed_payment_methods THEN
    RAISE EXCEPTION 'finance_account_identity_immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.active=false AND NEW.active=true AND (
    EXISTS (SELECT 1 FROM expenses e WHERE e.venue_id=OLD.venue_id AND e.finance_account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM finance_other_income_receipts r WHERE r.venue_id=OLD.venue_id AND r.finance_account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM finance_other_income_refunds r WHERE r.venue_id=OLD.venue_id AND r.finance_account_id=OLD.id)
  ) THEN RAISE EXCEPTION 'finance_account_used_cannot_be_reactivated' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
-- Attribute new external POS tender events to an explicit finance account.
-- Existing rows remain NULL and are reported as unknown_legacy.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS finance_account_id uuid;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS finance_account_name_snapshot text;
ALTER TABLE order_refund_tenders ADD COLUMN IF NOT EXISTS finance_account_id uuid;
ALTER TABLE order_refund_tenders ADD COLUMN IF NOT EXISTS finance_account_name_snapshot text;
ALTER TABLE order_refund_tenders ADD COLUMN IF NOT EXISTS shift_id uuid;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='payments_finance_account_fk' AND conrelid='payments'::regclass) THEN
    ALTER TABLE payments ADD CONSTRAINT payments_finance_account_fk FOREIGN KEY (finance_account_id) REFERENCES finance_accounts(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='payments_finance_account_snapshot_check' AND conrelid='payments'::regclass) THEN
    ALTER TABLE payments ADD CONSTRAINT payments_finance_account_snapshot_check CHECK ((finance_account_id IS NULL AND finance_account_name_snapshot IS NULL) OR (finance_account_id IS NOT NULL AND length(btrim(finance_account_name_snapshot)) BETWEEN 1 AND 120));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='order_refund_tenders_finance_account_fk' AND conrelid='order_refund_tenders'::regclass) THEN
    ALTER TABLE order_refund_tenders ADD CONSTRAINT order_refund_tenders_finance_account_fk FOREIGN KEY (finance_account_id) REFERENCES finance_accounts(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='order_refund_tenders_shift_fk' AND conrelid='order_refund_tenders'::regclass) THEN
    ALTER TABLE order_refund_tenders ADD CONSTRAINT order_refund_tenders_shift_fk FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='order_refund_tenders_account_snapshot_check' AND conrelid='order_refund_tenders'::regclass) THEN
    ALTER TABLE order_refund_tenders ADD CONSTRAINT order_refund_tenders_account_snapshot_check CHECK ((finance_account_id IS NULL AND finance_account_name_snapshot IS NULL AND shift_id IS NULL) OR (finance_account_id IS NOT NULL AND length(btrim(finance_account_name_snapshot)) BETWEEN 1 AND 120));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS payments_finance_account_idx ON payments(finance_account_id,created_at) WHERE finance_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS order_refund_tenders_finance_account_idx ON order_refund_tenders(finance_account_id,created_at) WHERE finance_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS order_refund_tenders_shift_idx ON order_refund_tenders(shift_id,created_at) WHERE shift_id IS NOT NULL;

CREATE OR REPLACE FUNCTION guard_pos_payment_finance_account() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_venue uuid; account_row finance_accounts%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND OLD.method IS DISTINCT FROM NEW.method THEN RAISE EXCEPTION 'payment_method_immutable' USING ERRCODE='55000'; END IF;
  IF TG_OP='UPDATE' AND (OLD.finance_account_id IS DISTINCT FROM NEW.finance_account_id OR OLD.finance_account_name_snapshot IS DISTINCT FROM NEW.finance_account_name_snapshot OR OLD.shift_id IS DISTINCT FROM NEW.shift_id) THEN
    RAISE EXCEPTION 'finance_account_event_immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.method IN ('bonus','deposit','reservation') THEN
    IF NEW.finance_account_id IS NOT NULL OR NEW.finance_account_name_snapshot IS NOT NULL THEN RAISE EXCEPTION 'finance_account_not_applicable' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.method NOT IN ('cash','card','qr') THEN RETURN NEW; END IF;
  IF NEW.finance_account_id IS NULL THEN
    IF TG_OP='INSERT' THEN RAISE EXCEPTION 'finance_account_required' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  SELECT venue_id INTO order_venue FROM orders WHERE id=NEW.order_id;
  SELECT * INTO account_row FROM finance_accounts WHERE id=NEW.finance_account_id AND venue_id=order_venue FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'finance_account_not_found' USING ERRCODE='23503'; END IF;
  IF NEW.finance_account_name_snapshot IS DISTINCT FROM account_row.name THEN RAISE EXCEPTION 'finance_account_snapshot_mismatch' USING ERRCODE='23514'; END IF;
  IF NEW.method<>ALL(account_row.allowed_payment_methods) THEN RAISE EXCEPTION 'finance_payment_method_account_mismatch' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' AND NOT account_row.active THEN RAISE EXCEPTION 'finance_account_inactive' USING ERRCODE='23514'; END IF;
  IF (NEW.method='cash' AND account_row.kind<>'pos_cashbox') OR (NEW.method='card' AND account_row.kind NOT IN ('bank','electronic')) OR (NEW.method='qr' AND account_row.kind<>'electronic') THEN
    RAISE EXCEPTION 'finance_payment_method_account_mismatch' USING ERRCODE='23514';
  END IF;
  IF account_row.kind='pos_cashbox' THEN
    IF NEW.method<>'cash' OR NEW.shift_id IS NULL OR NOT EXISTS(SELECT 1 FROM shifts s WHERE s.venue_id=order_venue AND s.id=NEW.shift_id AND s.closed_at IS NULL) THEN RAISE EXCEPTION 'finance_account_shift_mismatch' USING ERRCODE='23514'; END IF;
  ELSIF NEW.shift_id IS NOT NULL THEN RAISE EXCEPTION 'finance_account_shift_mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS payments_finance_account_guard ON payments;
CREATE TRIGGER payments_finance_account_guard BEFORE INSERT OR UPDATE OF order_id,method,finance_account_id,finance_account_name_snapshot,shift_id ON payments FOR EACH ROW EXECUTE FUNCTION guard_pos_payment_finance_account();

CREATE OR REPLACE FUNCTION guard_pos_refund_tender_finance_account() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account_row finance_accounts%ROWTYPE; refund_shift uuid; refund_venue uuid;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'order refunds are append-only' USING ERRCODE='55000'; END IF;
  IF NEW.finance_account_id IS NULL OR NEW.finance_account_name_snapshot IS NULL THEN RAISE EXCEPTION 'finance_account_required' USING ERRCODE='23514'; END IF;
  SELECT venue_id,shift_id INTO refund_venue,refund_shift FROM order_refunds WHERE venue_id=NEW.venue_id AND id=NEW.refund_id;
  SELECT * INTO account_row FROM finance_accounts WHERE venue_id=NEW.venue_id AND id=NEW.finance_account_id FOR SHARE;
  IF NOT FOUND OR refund_venue IS NULL THEN RAISE EXCEPTION 'finance_account_not_found' USING ERRCODE='23503'; END IF;
  IF NEW.finance_account_name_snapshot IS DISTINCT FROM account_row.name THEN RAISE EXCEPTION 'finance_account_snapshot_mismatch' USING ERRCODE='23514'; END IF;
  IF NEW.payout_method<>ALL(account_row.allowed_payment_methods) THEN RAISE EXCEPTION 'finance_payment_method_account_mismatch' USING ERRCODE='23514'; END IF;
  IF NOT account_row.active THEN RAISE EXCEPTION 'finance_account_inactive' USING ERRCODE='23514'; END IF;
  IF (NEW.payout_method='cash' AND account_row.kind<>'pos_cashbox') OR (NEW.payout_method='card' AND account_row.kind NOT IN ('bank','electronic')) OR (NEW.payout_method='qr' AND account_row.kind<>'electronic') THEN RAISE EXCEPTION 'finance_payment_method_account_mismatch' USING ERRCODE='23514'; END IF;
  IF account_row.kind='pos_cashbox' THEN
    IF NEW.payout_method<>'cash' OR NEW.shift_id IS NULL OR NEW.shift_id<>refund_shift OR NOT EXISTS(SELECT 1 FROM shifts s WHERE s.venue_id=NEW.venue_id AND s.id=NEW.shift_id AND s.closed_at IS NULL) THEN RAISE EXCEPTION 'finance_account_shift_mismatch' USING ERRCODE='23514'; END IF;
  ELSIF NEW.shift_id IS NOT NULL THEN RAISE EXCEPTION 'finance_account_shift_mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS order_refund_tenders_finance_account_guard ON order_refund_tenders;
CREATE TRIGGER order_refund_tenders_finance_account_guard BEFORE INSERT OR UPDATE OR DELETE ON order_refund_tenders FOR EACH ROW EXECUTE FUNCTION guard_pos_refund_tender_finance_account();

CREATE OR REPLACE FUNCTION guard_finance_account_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.venue_id IS DISTINCT FROM NEW.venue_id OR OLD.code IS DISTINCT FROM NEW.code OR OLD.kind IS DISTINCT FROM NEW.kind OR OLD.allowed_payment_methods IS DISTINCT FROM NEW.allowed_payment_methods THEN RAISE EXCEPTION 'finance_account_identity_immutable' USING ERRCODE='55000'; END IF;
  IF OLD.active=false AND NEW.active=true AND (
    EXISTS (SELECT 1 FROM expenses e WHERE e.venue_id=OLD.venue_id AND e.finance_account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM finance_other_income_receipts r WHERE r.venue_id=OLD.venue_id AND r.finance_account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM finance_other_income_refunds r WHERE r.venue_id=OLD.venue_id AND r.finance_account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.venue_id=OLD.venue_id AND p.finance_account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM order_refund_tenders t WHERE t.venue_id=OLD.venue_id AND t.finance_account_id=OLD.id)
  ) THEN RAISE EXCEPTION 'finance_account_used_cannot_be_reactivated' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
-- Close the database-boundary gaps left by the original POS income snapshot
-- migration. Sealed rows must reconcile one-to-one with immutable pricing.

-- The previous lifecycle allowed interrupted building rows to commit. Do not
-- install the stricter contract until those legacy rows are reconciled.
-- Hold the table lock across the check and trigger installation so old writers
-- cannot commit a new building row between the preflight and the new guards.
LOCK TABLE pos_order_income_category_snapshots IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pos_order_income_category_snapshots WHERE status='building') THEN
    RAISE EXCEPTION 'finance_pos_income_snapshot_legacy_building_rows_require_repair';
  END IF;
END $$;

ALTER TABLE pos_order_income_category_snapshots
  ADD COLUMN IF NOT EXISTS venue_timezone_snapshot text;

-- POS source mappings only target income articles. Lock the category row so
-- this check serializes with concurrent direction changes.
CREATE OR REPLACE FUNCTION validate_finance_income_category_mapping_category()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE category_name text; category_kind text; category_active boolean;
BEGIN
  SELECT name,kind,active INTO category_name,category_kind,category_active
    FROM finance_categories WHERE venue_id=NEW.venue_id AND id=NEW.category_id FOR SHARE;
  IF NOT FOUND OR category_kind<>'income' OR NOT category_active THEN
    RAISE EXCEPTION 'finance_income_mapping_requires_active_income_category' USING ERRCODE='23514';
  END IF;
  IF NEW.category_name_snapshot IS DISTINCT FROM category_name THEN
    RAISE EXCEPTION 'finance_income_mapping_category_name_mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_income_mapping_category_guard ON finance_income_category_mappings;
CREATE TRIGGER finance_income_mapping_category_guard
  BEFORE INSERT ON finance_income_category_mappings
  FOR EACH ROW EXECUTE FUNCTION validate_finance_income_category_mapping_category();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM finance_income_category_mappings m
    JOIN finance_categories c ON c.venue_id=m.venue_id AND c.id=m.category_id
    WHERE c.kind<>'income'
  ) THEN
    RAISE EXCEPTION 'finance_income_mapping_existing_category_kind_invalid';
  END IF;
END $$;

-- Direction stays immutable for every persisted source reference, including
-- the mapping row used to classify a sealed POS income snapshot.
CREATE OR REPLACE FUNCTION guard_finance_category_source_kind()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind AND (
       EXISTS (SELECT 1 FROM payroll_entries pe WHERE pe.venue_id=OLD.venue_id AND pe.finance_category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM inventory_purchase_documents d WHERE d.venue_id=OLD.venue_id AND d.finance_category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM finance_other_income_documents d WHERE d.venue_id=OLD.venue_id AND d.category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM finance_income_category_mappings m WHERE m.venue_id=OLD.venue_id AND m.category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM pos_order_income_category_allocations a WHERE a.venue_id=OLD.venue_id AND a.category_id=OLD.id)
     ) THEN
    RAISE EXCEPTION 'finance_category_source_kind_immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_category_source_kind_guard ON finance_categories;
CREATE TRIGGER finance_category_source_kind_guard
  BEFORE UPDATE OF kind ON finance_categories
  FOR EACH ROW EXECUTE FUNCTION guard_finance_category_source_kind();

CREATE OR REPLACE FUNCTION assert_pos_order_income_category_snapshot(
  p_snapshot pos_order_income_category_snapshots
)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  allocation_total numeric;
  unmapped_total numeric;
  allocation_count bigint;
  source_total bigint;
  minimum_source bigint;
  item_count bigint;
  adjustment_count bigint;
  source_closed_at timestamptz;
  source_timezone text;
BEGIN
  IF p_snapshot.status NOT IN ('complete','unmapped') THEN
    RAISE EXCEPTION 'pos_order_income_category_snapshot_not_terminal' USING ERRCODE='23514';
  END IF;

  SELECT COALESCE(SUM(a.amount_minor),0),
         COALESCE(SUM(a.amount_minor) FILTER (WHERE a.category_id IS NULL),0),
         COUNT(*),
         COUNT(*) FILTER (WHERE a.allocation_kind='minimum_adjustment')
    INTO allocation_total,unmapped_total,allocation_count,adjustment_count
    FROM pos_order_income_category_allocations a
    WHERE a.venue_id=p_snapshot.venue_id AND a.income_snapshot_id=p_snapshot.id;

  SELECT s.final_total_minor,s.minimum_adjustment_minor,o.closed_at,
         COALESCE(NULLIF(v.timezone,''),NULLIF(org.timezone,''),'Asia/Yekaterinburg')
    INTO source_total,minimum_source,source_closed_at,source_timezone
    FROM pos_order_pricing_snapshots s
    JOIN orders o ON o.venue_id=s.venue_id AND o.id=s.order_id
    JOIN venues v ON v.id=o.venue_id
    LEFT JOIN organizations org ON org.id=v.organization_id
    WHERE s.venue_id=p_snapshot.venue_id AND s.id=p_snapshot.pricing_snapshot_id AND s.order_id=p_snapshot.order_id
    FOR SHARE OF v;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pos_order_income_category_pricing_source_missing' USING ERRCODE='23514';
  END IF;
  IF p_snapshot.closed_at IS DISTINCT FROM source_closed_at
      OR p_snapshot.venue_timezone_snapshot IS DISTINCT FROM source_timezone
      OR p_snapshot.venue_date IS DISTINCT FROM (source_closed_at AT TIME ZONE source_timezone)::date THEN
    RAISE EXCEPTION 'pos_order_income_category_snapshot_date_mismatch' USING ERRCODE='23514';
  END IF;

  -- Lock every mapped category before checking activity. Archiving then either
  -- precedes this check (and blocks a new snapshot) or waits until this close
  -- transaction seals its historical category facts.
  PERFORM c.id
    FROM finance_categories c
    WHERE EXISTS (
      SELECT 1 FROM pos_order_income_category_allocations a
      WHERE a.venue_id=p_snapshot.venue_id AND a.income_snapshot_id=p_snapshot.id
        AND a.mapping_id IS NOT NULL AND a.category_id=c.id AND c.venue_id=a.venue_id
    )
    ORDER BY c.id
    FOR SHARE OF c;
  IF EXISTS (
    SELECT 1
    FROM pos_order_income_category_allocations a
    JOIN finance_categories c ON c.venue_id=a.venue_id AND c.id=a.category_id
    WHERE a.venue_id=p_snapshot.venue_id AND a.income_snapshot_id=p_snapshot.id
      AND a.mapping_id IS NOT NULL AND (c.kind<>'income' OR NOT c.active)
  ) THEN
    RAISE EXCEPTION 'pos_order_income_category_snapshot_requires_active_income_category' USING ERRCODE='23514';
  END IF;

  SELECT COUNT(*) INTO item_count
    FROM pos_order_pricing_snapshot_lines l
    WHERE l.venue_id=p_snapshot.venue_id AND l.snapshot_id=p_snapshot.pricing_snapshot_id AND l.order_id=p_snapshot.order_id;

  IF allocation_total<>p_snapshot.recognized_total_minor
      OR source_total<>p_snapshot.recognized_total_minor
      OR unmapped_total<>p_snapshot.unmapped_minor
      OR allocation_count<>item_count + (CASE WHEN minimum_source>0 THEN 1 ELSE 0 END)
      OR adjustment_count<>(CASE WHEN minimum_source>0 THEN 1 ELSE 0 END)
      OR p_snapshot.status IS DISTINCT FROM (CASE WHEN unmapped_total>0 THEN 'unmapped' ELSE 'complete' END) THEN
    RAISE EXCEPTION 'pos_order_income_category_snapshot_reconciliation_failed' USING ERRCODE='23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pos_order_income_category_allocations a
    LEFT JOIN pos_order_pricing_snapshot_lines l
      ON l.venue_id=a.venue_id AND l.snapshot_id=p_snapshot.pricing_snapshot_id
      AND l.order_id=a.order_id AND l.order_item_id=a.order_item_id
    WHERE a.venue_id=p_snapshot.venue_id AND a.income_snapshot_id=p_snapshot.id
      AND a.allocation_kind='item'
      AND (
        l.order_item_id IS NULL
        OR a.amount_minor IS DISTINCT FROM l.net_minor
        OR a.source_menu_category IS DISTINCT FROM COALESCE(l.product_facts->>'category','')
        OR a.source_station_snapshot IS DISTINCT FROM LEFT(COALESCE(l.product_facts->>'station',''),80)
        OR a.source_product_name IS DISTINCT FROM LEFT(COALESCE(NULLIF(l.product_facts->>'productName',''),'Позиция'),200)
        OR a.source_key IS DISTINCT FROM CASE
          WHEN COALESCE(l.product_facts->>'category','')='' OR LENGTH(COALESCE(l.product_facts->>'category',''))>500 THEN '@unclassified'
          WHEN l.product_facts->>'category'='@minimum-adjustment' THEN '@menu:@minimum-adjustment'
          WHEN l.product_facts->>'category'='@unclassified' THEN '@menu:@unclassified'
          ELSE l.product_facts->>'category'
        END
        OR (a.mapping_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM finance_income_category_mappings m
          JOIN finance_categories c ON c.venue_id=m.venue_id AND c.id=m.category_id AND c.kind='income' AND c.active=true
          WHERE m.venue_id=a.venue_id AND m.id=a.mapping_id AND m.source_key=a.source_key
            AND m.category_id=a.category_id AND m.category_name_snapshot=a.category_name_snapshot
            AND m.effective_from<=p_snapshot.venue_date
        ))
      )
  ) OR EXISTS (
    SELECT 1
    FROM pos_order_pricing_snapshot_lines l
    WHERE l.venue_id=p_snapshot.venue_id AND l.snapshot_id=p_snapshot.pricing_snapshot_id AND l.order_id=p_snapshot.order_id
      AND NOT EXISTS (
        SELECT 1 FROM pos_order_income_category_allocations a
        WHERE a.venue_id=p_snapshot.venue_id AND a.income_snapshot_id=p_snapshot.id
          AND a.order_id=p_snapshot.order_id AND a.allocation_kind='item' AND a.order_item_id=l.order_item_id
      )
  ) THEN
    RAISE EXCEPTION 'pos_order_income_category_item_allocation_mismatch' USING ERRCODE='23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pos_order_income_category_allocations a
    WHERE a.venue_id=p_snapshot.venue_id AND a.income_snapshot_id=p_snapshot.id
      AND a.allocation_kind='minimum_adjustment'
      AND (
        a.order_id IS DISTINCT FROM p_snapshot.order_id
        OR a.order_item_id IS NOT NULL
        OR a.source_key IS DISTINCT FROM '@minimum-adjustment'
        OR a.source_station_snapshot IS DISTINCT FROM ''
        OR a.source_menu_category IS DISTINCT FROM ''
        OR a.source_product_name IS DISTINCT FROM ''
        OR a.amount_minor IS DISTINCT FROM minimum_source
        OR (a.mapping_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM finance_income_category_mappings m
          JOIN finance_categories c ON c.venue_id=m.venue_id AND c.id=m.category_id AND c.kind='income' AND c.active=true
          WHERE m.venue_id=a.venue_id AND m.id=a.mapping_id AND m.source_key=a.source_key
            AND m.category_id=a.category_id AND m.category_name_snapshot=a.category_name_snapshot
            AND m.effective_from<=p_snapshot.venue_date
        ))
      )
  ) THEN
    RAISE EXCEPTION 'pos_order_income_category_adjustment_mismatch' USING ERRCODE='23514';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION validate_pos_order_income_category_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allocation_total numeric; unmapped_total numeric; source_total bigint; item_count bigint; allocation_count bigint; minimum_source bigint;
BEGIN
  IF TG_OP<>'UPDATE' OR OLD.status<>'building' OR NEW.status NOT IN ('complete','unmapped')
      OR NEW.venue_id IS DISTINCT FROM OLD.venue_id OR NEW.order_id IS DISTINCT FROM OLD.order_id
      OR NEW.pricing_snapshot_id IS DISTINCT FROM OLD.pricing_snapshot_id OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
      OR NEW.venue_date IS DISTINCT FROM OLD.venue_date OR NEW.venue_timezone_snapshot IS DISTINCT FROM OLD.venue_timezone_snapshot
      OR NEW.recognized_total_minor IS DISTINCT FROM OLD.recognized_total_minor
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'pos_order_income_snapshot_transition_invalid' USING ERRCODE='55000';
  END IF;
  SELECT COALESCE(SUM(a.amount_minor),0),
         COALESCE(SUM(a.amount_minor) FILTER (WHERE a.category_id IS NULL),0),
         COUNT(*)
    INTO allocation_total,unmapped_total,allocation_count
    FROM pos_order_income_category_allocations a
    WHERE a.venue_id=NEW.venue_id AND a.income_snapshot_id=NEW.id;
  SELECT s.final_total_minor,s.minimum_adjustment_minor
    INTO source_total,minimum_source
    FROM pos_order_pricing_snapshots s
    WHERE s.venue_id=NEW.venue_id AND s.id=NEW.pricing_snapshot_id AND s.order_id=NEW.order_id;
  SELECT COUNT(*) INTO item_count
    FROM pos_order_pricing_snapshot_lines l
    WHERE l.venue_id=NEW.venue_id AND l.snapshot_id=NEW.pricing_snapshot_id AND l.order_id=NEW.order_id;
  IF allocation_total<>NEW.recognized_total_minor
      OR source_total IS DISTINCT FROM NEW.recognized_total_minor
      OR unmapped_total<>NEW.unmapped_minor
      OR allocation_count<>item_count + (CASE WHEN COALESCE(minimum_source,0)>0 THEN 1 ELSE 0 END)
      OR NEW.status IS DISTINCT FROM (CASE WHEN unmapped_total>0 THEN 'unmapped' ELSE 'complete' END) THEN
    RAISE EXCEPTION 'pos_order_income_category_snapshot_reconciliation_failed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_pos_order_income_snapshot_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'building' THEN
      RAISE EXCEPTION 'pos_order_income_snapshot_must_start_building' USING ERRCODE='55000';
    END IF;
    IF NEW.venue_timezone_snapshot IS NULL OR btrim(NEW.venue_timezone_snapshot)='' THEN
      RAISE EXCEPTION 'pos_order_income_snapshot_timezone_required' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='building' AND NEW.status IN ('complete','unmapped') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'pos_order_income_category_snapshots_immutable' USING ERRCODE='55000';
END $$;
DROP TRIGGER IF EXISTS pos_order_income_snapshot_no_mutation ON pos_order_income_category_snapshots;
CREATE TRIGGER pos_order_income_snapshot_no_mutation BEFORE INSERT OR UPDATE OR DELETE ON pos_order_income_category_snapshots
  FOR EACH ROW EXECUTE FUNCTION guard_pos_order_income_snapshot_immutable();

CREATE OR REPLACE FUNCTION validate_pos_order_income_category_snapshot_at_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE final_snapshot pos_order_income_category_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO final_snapshot FROM pos_order_income_category_snapshots
    WHERE venue_id=NEW.venue_id AND id=NEW.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pos_order_income_category_snapshot_missing_at_commit' USING ERRCODE='23514';
  END IF;
  PERFORM assert_pos_order_income_category_snapshot(final_snapshot);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS pos_order_income_snapshot_commit_validate ON pos_order_income_category_snapshots;
CREATE CONSTRAINT TRIGGER pos_order_income_snapshot_commit_validate
  AFTER INSERT OR UPDATE ON pos_order_income_category_snapshots
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION validate_pos_order_income_category_snapshot_at_commit();


-- Persist manual expense drafts separately from the immutable cash-out journal.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS counterparty_name text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='expenses_counterparty_name_check' AND conrelid='expenses'::regclass) THEN
    ALTER TABLE expenses ADD CONSTRAINT expenses_counterparty_name_check
      CHECK (counterparty_name IS NULL OR length(btrim(counterparty_name)) BETWEEN 1 AND 160);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS finance_expense_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  category_id uuid NOT NULL,
  category_name_snapshot text NOT NULL CHECK (length(btrim(category_name_snapshot)) BETWEEN 1 AND 80),
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  expense_date date NOT NULL,
  counterparty_name text CHECK (counterparty_name IS NULL OR length(btrim(counterparty_name)) BETWEEN 1 AND 160),
  description text CHECK (description IS NULL OR length(description) <= 1000),
  document_url text CHECK (document_url IS NULL OR length(document_url) <= 2000000),
  source text NOT NULL CHECK (source IN ('manual','other')),
  finance_account_id uuid NOT NULL,
  finance_account_name_snapshot text NOT NULL CHECK (length(btrim(finance_account_name_snapshot)) BETWEEN 1 AND 120),
  payment_method text NOT NULL CHECK (payment_method IN ('cash','card','bank_transfer','other')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','cancelled')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  create_payload jsonb NOT NULL CHECK (jsonb_typeof(create_payload)='object'),
  create_idempotency_key text NOT NULL CHECK (length(create_idempotency_key) BETWEEN 8 AND 128),
  expense_id uuid,
  posted_at timestamptz,
  posted_by uuid,
  post_idempotency_key text,
  posted_version integer,
  cancelled_at timestamptz,
  cancelled_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,created_by,create_idempotency_key),
  UNIQUE (venue_id,expense_id),
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,updated_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,posted_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,cancelled_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,category_id) REFERENCES finance_categories(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,finance_account_id) REFERENCES finance_accounts(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,expense_id) REFERENCES expenses(venue_id,id) ON DELETE RESTRICT,
  CHECK ((status='draft' AND expense_id IS NULL AND posted_at IS NULL AND posted_by IS NULL AND post_idempotency_key IS NULL AND posted_version IS NULL AND cancelled_at IS NULL AND cancelled_by IS NULL)
    OR (status='posted' AND expense_id IS NOT NULL AND posted_at IS NOT NULL AND posted_by IS NOT NULL AND post_idempotency_key IS NOT NULL AND length(post_idempotency_key) BETWEEN 8 AND 128 AND posted_version IS NOT NULL AND posted_version > 0 AND cancelled_at IS NULL AND cancelled_by IS NULL)
    OR (status='cancelled' AND expense_id IS NULL AND posted_at IS NULL AND posted_by IS NULL AND post_idempotency_key IS NULL AND posted_version IS NULL AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS finance_expense_drafts_venue_status_updated_idx
  ON finance_expense_drafts(venue_id,status,updated_at DESC,id);

CREATE OR REPLACE FUNCTION guard_finance_expense_draft_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'finance_expense_draft_immutable_delete' USING ERRCODE='55000';
  END IF;
  IF OLD.venue_id IS DISTINCT FROM NEW.venue_id OR OLD.created_by IS DISTINCT FROM NEW.created_by
    OR OLD.create_idempotency_key IS DISTINCT FROM NEW.create_idempotency_key
    OR OLD.create_payload IS DISTINCT FROM NEW.create_payload
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'finance_expense_draft_identity_immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'finance_expense_draft_immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.version <> OLD.version + 1 AND NEW.status='draft' THEN
    RAISE EXCEPTION 'finance_expense_draft_version_invalid' USING ERRCODE='23514';
  END IF;
  IF NEW.status='posted' AND (NEW.category_id IS DISTINCT FROM OLD.category_id
    OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.expense_date IS DISTINCT FROM OLD.expense_date
    OR NEW.counterparty_name IS DISTINCT FROM OLD.counterparty_name OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.document_url IS DISTINCT FROM OLD.document_url OR NEW.source IS DISTINCT FROM OLD.source
    OR NEW.finance_account_id IS DISTINCT FROM OLD.finance_account_id OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
    OR NEW.version IS DISTINCT FROM OLD.version) THEN
    RAISE EXCEPTION 'finance_expense_draft_post_payload_changed' USING ERRCODE='55000';
  END IF;
  IF NEW.status='posted' AND NOT EXISTS (
    SELECT 1 FROM expenses e
    WHERE e.venue_id=NEW.venue_id AND e.id=NEW.expense_id
      AND e.category_id=NEW.category_id AND e.category=NEW.category_name_snapshot
      AND e.amount=NEW.amount AND e.expense_date=NEW.expense_date
      AND e.counterparty_name IS NOT DISTINCT FROM NEW.counterparty_name
      AND e.description IS NOT DISTINCT FROM NEW.description
      AND e.source=NEW.source AND e.document_url IS NOT DISTINCT FROM NEW.document_url
      AND e.finance_account_id=NEW.finance_account_id
      AND e.finance_account_name_snapshot=NEW.finance_account_name_snapshot
      AND e.payment_method=NEW.payment_method
      AND e.idempotency_key=NEW.post_idempotency_key
      AND e.created_by=NEW.posted_by
      AND NEW.posted_version=NEW.version
  ) THEN
    RAISE EXCEPTION 'finance_expense_draft_post_expense_mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.status='cancelled' AND (NEW.category_id IS DISTINCT FROM OLD.category_id
    OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.expense_date IS DISTINCT FROM OLD.expense_date
    OR NEW.counterparty_name IS DISTINCT FROM OLD.counterparty_name OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.document_url IS DISTINCT FROM OLD.document_url OR NEW.source IS DISTINCT FROM OLD.source
    OR NEW.finance_account_id IS DISTINCT FROM OLD.finance_account_id OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
    OR NEW.version IS DISTINCT FROM OLD.version) THEN
    RAISE EXCEPTION 'finance_expense_draft_cancel_payload_changed' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_expense_draft_lifecycle_guard ON finance_expense_drafts;
CREATE TRIGGER finance_expense_draft_lifecycle_guard
  BEFORE UPDATE OR DELETE ON finance_expense_drafts
  FOR EACH ROW EXECUTE FUNCTION guard_finance_expense_draft_lifecycle();

CREATE OR REPLACE FUNCTION guard_posted_expense_draft_source() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM finance_expense_drafts d WHERE d.venue_id=OLD.venue_id AND d.expense_id=OLD.id AND d.status='posted') THEN
    RAISE EXCEPTION 'posted_finance_expense_immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.source IN ('manual','other') AND TG_OP='DELETE' THEN
    RAISE EXCEPTION 'posted_finance_expense_immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='UPDATE' AND OLD.source IN ('manual','other') THEN
    -- Payroll may adopt an existing expense only through its linked payroll entry.
    IF OLD.source='manual' AND NEW.source='payroll'
      AND OLD.venue_id IS NOT DISTINCT FROM NEW.venue_id
      AND OLD.counterparty_name IS NOT DISTINCT FROM NEW.counterparty_name
      AND OLD.document_url IS NOT DISTINCT FROM NEW.document_url
      AND OLD.payment_method IS NOT DISTINCT FROM NEW.payment_method
      AND OLD.finance_account_id IS NOT DISTINCT FROM NEW.finance_account_id
      AND OLD.finance_account_name_snapshot IS NOT DISTINCT FROM NEW.finance_account_name_snapshot
      AND OLD.shift_id IS NOT DISTINCT FROM NEW.shift_id
      AND OLD.idempotency_key IS NOT DISTINCT FROM NEW.idempotency_key
      AND OLD.created_at IS NOT DISTINCT FROM NEW.created_at
      AND EXISTS (SELECT 1 FROM payroll_entries pe WHERE pe.venue_id=OLD.venue_id AND pe.expense_id=OLD.id
        AND pe.status='approved' AND pe.amount=NEW.amount
        AND pe.finance_category_id IS NOT DISTINCT FROM NEW.category_id
        AND COALESCE(pe.finance_category_name_snapshot,'Зарплата')=NEW.category
        AND NEW.description='Выплата зарплаты за ' || to_char(pe.period_from,'DD.MM.YYYY') || ' — ' || to_char(pe.period_to,'DD.MM.YYYY')) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'posted_finance_expense_immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS posted_expense_draft_source_guard ON expenses;
CREATE TRIGGER posted_expense_draft_source_guard
  BEFORE UPDATE OR DELETE ON expenses
  FOR EACH ROW EXECUTE FUNCTION guard_posted_expense_draft_source();

-- Preserve a category's direction after it is used by any finance source.
CREATE OR REPLACE FUNCTION guard_finance_category_source_kind()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind AND (
       EXISTS (SELECT 1 FROM expenses e WHERE e.venue_id=OLD.venue_id AND e.category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM finance_payables p WHERE p.venue_id=OLD.venue_id AND p.category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM finance_recurring_rules r WHERE r.venue_id=OLD.venue_id AND r.category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM finance_expense_drafts d WHERE d.venue_id=OLD.venue_id AND d.category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM payroll_entries pe WHERE pe.venue_id=OLD.venue_id AND pe.finance_category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM inventory_purchase_documents d WHERE d.venue_id=OLD.venue_id AND d.finance_category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM finance_other_income_documents d WHERE d.venue_id=OLD.venue_id AND d.category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM finance_income_category_mappings m WHERE m.venue_id=OLD.venue_id AND m.category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM pos_order_income_category_allocations a WHERE a.venue_id=OLD.venue_id AND a.category_id=OLD.id)
     ) THEN
    RAISE EXCEPTION 'finance_category_source_kind_immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_category_source_kind_guard ON finance_categories;
CREATE TRIGGER finance_category_source_kind_guard
  BEFORE UPDATE OF kind ON finance_categories
  FOR EACH ROW EXECUTE FUNCTION guard_finance_category_source_kind();
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
-- Append-only accounting corrections for posted manual/other expenses.
-- Corrections change accounting metadata through signed deltas; they never
-- rewrite the original expense cash-out event.
CREATE TABLE IF NOT EXISTS finance_expense_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  expense_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  expected_version integer NOT NULL CHECK (expected_version >= 0),
  before_snapshot jsonb NOT NULL CHECK (jsonb_typeof(before_snapshot)='object'),
  after_snapshot jsonb NOT NULL CHECK (jsonb_typeof(after_snapshot)='object'),
  amount_delta numeric(14,2) NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  response_json jsonb NOT NULL CHECK (jsonb_typeof(response_json)='object'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,expense_id,sequence),
  UNIQUE (venue_id,idempotency_key),
  FOREIGN KEY (venue_id,expense_id) REFERENCES expenses(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  CHECK (sequence=expected_version+1)
);
CREATE INDEX IF NOT EXISTS finance_expense_corrections_expense_idx
  ON finance_expense_corrections(venue_id,expense_id,sequence);
CREATE INDEX IF NOT EXISTS finance_expense_corrections_created_idx
  ON finance_expense_corrections(venue_id,created_at DESC,id);
COMMENT ON COLUMN finance_expense_corrections.before_snapshot IS
  'JSON object contract: amount (decimal string), categoryId (UUID or null), categoryName, counterpartyName, description, documentUrl.';
COMMENT ON COLUMN finance_expense_corrections.after_snapshot IS
  'JSON object contract: amount (decimal string), categoryId (UUID or null), categoryName, counterpartyName, description, documentUrl.';
COMMENT ON COLUMN finance_expense_corrections.response_json IS
  'Immutable success response captured at creation for exact idempotent replay.';

CREATE OR REPLACE FUNCTION guard_finance_expense_correction()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_expense expenses%ROWTYPE;
  current_version integer;
  before_amount numeric;
  after_amount numeric;
  snapshot jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'finance_expense_corrections_append_only' USING ERRCODE='55000';
  END IF;

  FOREACH snapshot IN ARRAY ARRAY[NEW.before_snapshot,NEW.after_snapshot] LOOP
    IF (SELECT count(*) FROM jsonb_object_keys(snapshot))<>6
      OR NOT (snapshot ?& ARRAY['amount','categoryId','categoryName','counterpartyName','description','documentUrl']) THEN
      RAISE EXCEPTION 'finance_expense_correction_snapshot_shape_invalid' USING ERRCODE='23514';
    END IF;
    IF jsonb_typeof(snapshot->'amount')<>'string'
      OR snapshot->>'amount' !~ '^(0|[1-9][0-9]{0,11})([.][0-9]{1,2})?$' THEN
      RAISE EXCEPTION 'finance_expense_correction_snapshot_amount_invalid' USING ERRCODE='23514';
    END IF;
    IF (snapshot->>'amount')::numeric<=0 THEN
      RAISE EXCEPTION 'finance_expense_correction_snapshot_amount_invalid' USING ERRCODE='23514';
    END IF;
    IF jsonb_typeof(snapshot->'categoryId') NOT IN ('null','string')
      OR jsonb_typeof(snapshot->'categoryName') NOT IN ('null','string')
      OR jsonb_typeof(snapshot->'counterpartyName') NOT IN ('null','string')
      OR jsonb_typeof(snapshot->'description') NOT IN ('null','string')
      OR jsonb_typeof(snapshot->'documentUrl') NOT IN ('null','string')
      OR ((snapshot->'categoryId'='null'::jsonb) IS DISTINCT FROM (snapshot->'categoryName'='null'::jsonb)) THEN
      RAISE EXCEPTION 'finance_expense_correction_snapshot_field_invalid' USING ERRCODE='23514';
    END IF;
    IF jsonb_typeof(snapshot->'categoryId')='string'
      AND snapshot->>'categoryId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'finance_expense_correction_snapshot_category_invalid' USING ERRCODE='23514';
    END IF;
  END LOOP;

  before_amount := (NEW.before_snapshot->>'amount')::numeric;
  after_amount := (NEW.after_snapshot->>'amount')::numeric;
  IF NEW.amount_delta<>after_amount-before_amount THEN
    RAISE EXCEPTION 'finance_expense_correction_amount_delta_mismatch' USING ERRCODE='23514';
  END IF;

  -- The source-row lock is the serialization point. The handler should take
  -- this lock before reading expected_version and hold it through insertion.
  SELECT * INTO source_expense
  FROM expenses
  WHERE venue_id=NEW.venue_id AND id=NEW.expense_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finance_expense_correction_source_not_found' USING ERRCODE='23503';
  END IF;
  IF source_expense.source NOT IN ('manual','other') THEN
    RAISE EXCEPTION 'finance_expense_correction_source_ineligible' USING ERRCODE='23514';
  END IF;
  IF source_expense.purchase_document_id IS NOT NULL
    OR EXISTS (SELECT 1 FROM finance_payable_payment_links p
      WHERE p.venue_id=NEW.venue_id AND p.expense_id=NEW.expense_id)
    OR EXISTS (SELECT 1 FROM payroll_entries pe
      WHERE pe.venue_id=NEW.venue_id AND pe.expense_id=NEW.expense_id) THEN
    RAISE EXCEPTION 'finance_expense_correction_source_linked' USING ERRCODE='23514';
  END IF;

  SELECT COALESCE(MAX(sequence),0) INTO current_version
  FROM finance_expense_corrections
  WHERE venue_id=NEW.venue_id AND expense_id=NEW.expense_id;
  IF NEW.expected_version<>current_version OR NEW.sequence<>current_version+1 THEN
    RAISE EXCEPTION 'finance_expense_correction_version_conflict' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_expense_correction_guard ON finance_expense_corrections;
CREATE TRIGGER finance_expense_correction_guard
  BEFORE INSERT OR UPDATE OR DELETE ON finance_expense_corrections
  FOR EACH ROW EXECUTE FUNCTION guard_finance_expense_correction();

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

-- Preserve tenant-scoped category identity in append-only expense correction history.
-- Existing snapshots are validated before constraints are installed; no history is rewritten.
LOCK TABLE finance_expense_corrections IN ACCESS EXCLUSIVE MODE;
LOCK TABLE finance_categories IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM finance_expense_corrections c
    CROSS JOIN LATERAL (VALUES (c.before_snapshot->>'categoryId'),(c.after_snapshot->>'categoryId')) refs(category_id)
    LEFT JOIN finance_categories fc ON fc.venue_id=c.venue_id AND fc.id=(CASE
      WHEN refs.category_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN refs.category_id::uuid ELSE NULL END)
    WHERE refs.category_id IS NOT NULL
      AND (refs.category_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR fc.id IS NULL OR fc.kind IS DISTINCT FROM 'expense'))
  THEN
    RAISE EXCEPTION 'finance_expense_correction_category_legacy_invalid' USING ERRCODE='23514';
  END IF;
END $$;

ALTER TABLE finance_expense_corrections
  ADD COLUMN IF NOT EXISTS before_category_id uuid GENERATED ALWAYS AS (NULLIF(before_snapshot->>'categoryId','')::uuid) STORED,
  ADD COLUMN IF NOT EXISTS after_category_id uuid GENERATED ALWAYS AS (NULLIF(after_snapshot->>'categoryId','')::uuid) STORED;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='finance_expense_corrections'::regclass AND conname='finance_expense_correction_before_category_fk') THEN
    ALTER TABLE finance_expense_corrections ADD CONSTRAINT finance_expense_correction_before_category_fk
      FOREIGN KEY (venue_id,before_category_id) REFERENCES finance_categories(venue_id,id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='finance_expense_corrections'::regclass AND conname='finance_expense_correction_after_category_fk') THEN
    ALTER TABLE finance_expense_corrections ADD CONSTRAINT finance_expense_correction_after_category_fk
      FOREIGN KEY (venue_id,after_category_id) REFERENCES finance_categories(venue_id,id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION validate_finance_expense_correction_categories()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  category_id uuid;
  category_kind text;
  category_text text;
BEGIN
  FOREACH category_text IN ARRAY ARRAY[NEW.before_snapshot->>'categoryId',NEW.after_snapshot->>'categoryId'] LOOP
    IF category_text IS NULL OR category_text='' THEN CONTINUE; END IF;
    category_id := category_text::uuid;
    SELECT kind INTO category_kind FROM finance_categories
      WHERE venue_id=NEW.venue_id AND id=category_id FOR SHARE;
    IF NOT FOUND OR category_kind IS DISTINCT FROM 'expense' THEN
      RAISE EXCEPTION 'finance_expense_correction_category_invalid' USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_expense_correction_category_guard ON finance_expense_corrections;
CREATE TRIGGER finance_expense_correction_category_guard
  BEFORE INSERT ON finance_expense_corrections
  FOR EACH ROW EXECUTE FUNCTION validate_finance_expense_correction_categories();

CREATE OR REPLACE FUNCTION guard_finance_category_source_kind()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind AND (
       EXISTS (SELECT 1 FROM expenses e WHERE e.venue_id=OLD.venue_id AND e.category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM finance_payables p WHERE p.venue_id=OLD.venue_id AND p.category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM finance_recurring_rules r WHERE r.venue_id=OLD.venue_id AND r.category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM finance_expense_drafts d WHERE d.venue_id=OLD.venue_id AND d.category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM payroll_entries pe WHERE pe.venue_id=OLD.venue_id AND pe.finance_category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM inventory_purchase_documents d WHERE d.venue_id=OLD.venue_id AND d.finance_category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM finance_other_income_documents d WHERE d.venue_id=OLD.venue_id AND d.category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM finance_income_category_mappings m WHERE m.venue_id=OLD.venue_id AND m.category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM pos_order_income_category_allocations a WHERE a.venue_id=OLD.venue_id AND a.category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM finance_expense_corrections c WHERE c.venue_id=OLD.venue_id AND (c.before_category_id=OLD.id OR c.after_category_id=OLD.id))
     ) THEN
    RAISE EXCEPTION 'finance_category_source_kind_immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_category_source_kind_guard ON finance_categories;
CREATE TRIGGER finance_category_source_kind_guard
  BEFORE UPDATE OF kind ON finance_categories
  FOR EACH ROW EXECUTE FUNCTION guard_finance_category_source_kind();


-- Bind rate changes to the exact preview and preserve retryability after a lost acknowledgement.
ALTER TABLE finance_create_idempotency
  DROP CONSTRAINT IF EXISTS finance_create_idempotency_operation_check;
ALTER TABLE finance_create_idempotency
  ADD CONSTRAINT finance_create_idempotency_operation_check
  CHECK (operation IN ('payable_create','recurring_rule_create','recurring_rule_version_create'));

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
  ) THEN RAISE EXCEPTION 'finance_create_idempotency_entity_invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

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

-- Migration 125: manual expense cash refunds
-- Actual cash returned to a venue for an exact, unlinked manual expense.
-- This is a cash receipt only; it does not mutate expenses or P&L recognition.
CREATE TABLE IF NOT EXISTS finance_expense_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  expense_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  refund_date date NOT NULL,
  payment_method text NOT NULL CHECK (payment_method IN ('cash','card','qr','bank_transfer','other')),
  finance_account_id uuid NOT NULL,
  finance_account_name_snapshot text NOT NULL CHECK (length(btrim(finance_account_name_snapshot)) BETWEEN 1 AND 160),
  shift_id uuid,
  document_reference text CHECK (document_reference IS NULL OR length(document_reference) <= 160),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  idempotency_key uuid NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  pnl_effect text NOT NULL DEFAULT 'not_calculated' CHECK (pnl_effect='not_calculated'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,idempotency_key),
  FOREIGN KEY (venue_id,expense_id) REFERENCES expenses(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,finance_account_id) REFERENCES finance_accounts(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,shift_id) REFERENCES shifts(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS finance_expense_refunds_expense_idx
  ON finance_expense_refunds(venue_id,expense_id,refund_date,created_at,id);
CREATE INDEX IF NOT EXISTS finance_expense_refunds_date_idx
  ON finance_expense_refunds(venue_id,refund_date,created_at,id);

COMMENT ON TABLE finance_expense_refunds IS
  'Append-only positive cash receipts tied to exact manual/other expenses. No P&L, supplier, payable, payroll or inventory effect is calculated.';
COMMENT ON COLUMN finance_expense_refunds.pnl_effect IS
  'Explicitly uncalculated. The receipt is excluded from expense/P&L recognition and business-income totals.';

CREATE OR REPLACE FUNCTION guard_finance_expense_refund()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_expense expenses%ROWTYPE;
  destination_account finance_accounts%ROWTYPE;
  open_shift_id uuid;
  open_shift_count integer;
  already_returned numeric(14,2);
  venue_timezone text;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'finance_expense_refunds_append_only' USING ERRCODE='55000';
  END IF;

  SELECT * INTO source_expense FROM expenses
    WHERE venue_id=NEW.venue_id AND id=NEW.expense_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'finance_expense_refund_source_not_found' USING ERRCODE='23503'; END IF;
  IF source_expense.source NOT IN ('manual','other') OR source_expense.purchase_document_id IS NOT NULL
    OR EXISTS(SELECT 1 FROM finance_payable_payment_links WHERE venue_id=NEW.venue_id AND expense_id=NEW.expense_id)
    OR EXISTS(SELECT 1 FROM payroll_entries WHERE venue_id=NEW.venue_id AND expense_id=NEW.expense_id) THEN
    RAISE EXCEPTION 'finance_expense_refund_not_supported' USING ERRCODE='23514';
  END IF;
  IF NEW.refund_date<source_expense.expense_date THEN
    RAISE EXCEPTION 'finance_expense_refund_date_before_expense' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(NULLIF(timezone,''),'Europe/Moscow') INTO venue_timezone FROM venues WHERE id=NEW.venue_id;
  IF NEW.refund_date>(now() AT TIME ZONE COALESCE(venue_timezone,'Europe/Moscow'))::date THEN
    RAISE EXCEPTION 'finance_expense_refund_date_in_future' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(SUM(amount),0) INTO already_returned FROM finance_expense_refunds
    WHERE venue_id=NEW.venue_id AND expense_id=NEW.expense_id;
  IF already_returned+NEW.amount>source_expense.amount THEN
    RAISE EXCEPTION 'finance_expense_refund_exceeds_balance' USING ERRCODE='23514';
  END IF;

  SELECT * INTO destination_account FROM finance_accounts
    WHERE venue_id=NEW.venue_id AND id=NEW.finance_account_id FOR UPDATE;
  IF NOT FOUND OR NOT destination_account.active THEN
    RAISE EXCEPTION 'finance_account_inactive' USING ERRCODE='23514';
  END IF;
  IF NEW.finance_account_name_snapshot IS DISTINCT FROM destination_account.name THEN
    RAISE EXCEPTION 'finance_account_snapshot_mismatch' USING ERRCODE='23514';
  END IF;
  IF NOT (NEW.payment_method=ANY(destination_account.allowed_payment_methods)) THEN
    RAISE EXCEPTION 'finance_payment_method_account_mismatch' USING ERRCODE='23514';
  END IF;
  IF destination_account.kind='pos_cashbox' THEN
    IF NEW.payment_method<>'cash' THEN RAISE EXCEPTION 'finance_payment_method_account_mismatch' USING ERRCODE='23514'; END IF;
    IF NEW.refund_date<>(now() AT TIME ZONE COALESCE(venue_timezone,'Europe/Moscow'))::date THEN
      RAISE EXCEPTION 'finance_pos_cash_payment_date_must_be_today' USING ERRCODE='23514';
    END IF;
    SELECT id INTO open_shift_id FROM shifts WHERE venue_id=NEW.venue_id AND closed_at IS NULL FOR UPDATE;
    SELECT count(*)::int INTO open_shift_count FROM shifts WHERE venue_id=NEW.venue_id AND closed_at IS NULL;
    IF open_shift_count<>1 OR NEW.shift_id IS DISTINCT FROM open_shift_id THEN
      RAISE EXCEPTION 'finance_payment_open_shift_required' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.shift_id IS NOT NULL THEN
    RAISE EXCEPTION 'finance_expense_refund_non_pos_shift_invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS finance_expense_refunds_guard ON finance_expense_refunds;
CREATE TRIGGER finance_expense_refunds_guard
  BEFORE INSERT OR UPDATE OR DELETE ON finance_expense_refunds
  FOR EACH ROW EXECUTE FUNCTION guard_finance_expense_refund();

-- Temporary immutable projections for paged unified finance reports.
CREATE TABLE IF NOT EXISTS finance_unified_report_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  created_by uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  filters jsonb NOT NULL CHECK (jsonb_typeof(filters)='object'),
  report jsonb NOT NULL CHECK (jsonb_typeof(report)='object'),
  cursor_secret text NOT NULL CHECK (cursor_secret ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,created_by,idempotency_key),
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  CHECK (expires_at=created_at+interval '15 minutes')
);
CREATE INDEX IF NOT EXISTS finance_unified_report_snapshots_expiry_idx
  ON finance_unified_report_snapshots(expires_at);
CREATE INDEX IF NOT EXISTS finance_unified_report_snapshots_venue_expiry_idx
  ON finance_unified_report_snapshots(venue_id,expires_at);

CREATE OR REPLACE FUNCTION guard_finance_unified_report_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.created_at:=clock_timestamp();
    NEW.expires_at:=NEW.created_at+interval '15 minutes';
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'finance_unified_report_snapshot_immutable' USING ERRCODE='55000'; END IF;
  IF TG_OP='DELETE' AND OLD.expires_at>clock_timestamp() THEN
    RAISE EXCEPTION 'finance_unified_report_snapshot_not_expired' USING ERRCODE='55000';
  END IF;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS finance_unified_report_snapshot_immutable ON finance_unified_report_snapshots;
CREATE TRIGGER finance_unified_report_snapshot_immutable
BEFORE INSERT OR UPDATE OR DELETE ON finance_unified_report_snapshots
FOR EACH ROW EXECUTE FUNCTION guard_finance_unified_report_snapshot();

COMMENT ON TABLE finance_unified_report_snapshots IS
  'Immutable venue-scoped unified finance report projection. Data expires exactly 15 minutes after creation; reads must still recheck current permissions.';

-- Append-only balance events for owner contributions and loan principal.
-- These are cash/balance facts only; they are not expenses or other income.
CREATE TABLE IF NOT EXISTS finance_funding_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  document_type text NOT NULL CHECK (document_type IN ('owner_contribution','loan')),
  counterparty_name text NOT NULL CHECK (length(btrim(counterparty_name)) BETWEEN 1 AND 160),
  basis text NOT NULL CHECK (length(btrim(basis)) BETWEEN 1 AND 500),
  document_reference text NOT NULL DEFAULT '' CHECK (length(document_reference) <= 160),
  principal_limit numeric(14,2),
  currency text NOT NULL DEFAULT 'RUB' CHECK (currency='RUB'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','cancelled')),
  idempotency_key uuid NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_funding_documents_type_limit_check CHECK (
    (document_type='loan' AND principal_limit IS NOT NULL AND principal_limit>0)
    OR (document_type='owner_contribution' AND principal_limit IS NULL)
  ),
  CONSTRAINT finance_funding_documents_venue_id_unique UNIQUE (venue_id,id),
  CONSTRAINT finance_funding_documents_idempotency_unique UNIQUE (venue_id,idempotency_key),
  CONSTRAINT finance_funding_documents_creator_fk FOREIGN KEY (venue_id,created_by)
    REFERENCES users(venue_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS finance_funding_documents_venue_created_idx
  ON finance_funding_documents(venue_id,created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS finance_funding_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  document_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('owner_contribution_received','loan_principal_received','loan_principal_repaid')),
  amount numeric(14,2) NOT NULL CHECK (amount>0),
  event_date date NOT NULL,
  finance_account_id uuid NOT NULL,
  finance_account_name_snapshot text NOT NULL CHECK (length(btrim(finance_account_name_snapshot)) BETWEEN 1 AND 160),
  payment_method text NOT NULL CHECK (payment_method IN ('cash','card','qr','bank_transfer','other')),
  shift_id uuid,
  note text NOT NULL DEFAULT '' CHECK (length(note)<=500),
  idempotency_key uuid NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_funding_events_venue_id_unique UNIQUE (venue_id,id),
  CONSTRAINT finance_funding_events_idempotency_unique UNIQUE (venue_id,idempotency_key),
  CONSTRAINT finance_funding_events_document_fk FOREIGN KEY (venue_id,document_id)
    REFERENCES finance_funding_documents(venue_id,id) ON DELETE RESTRICT,
  CONSTRAINT finance_funding_events_account_fk FOREIGN KEY (venue_id,finance_account_id)
    REFERENCES finance_accounts(venue_id,id) ON DELETE RESTRICT,
  CONSTRAINT finance_funding_events_shift_fk FOREIGN KEY (venue_id,shift_id)
    REFERENCES shifts(venue_id,id) ON DELETE RESTRICT,
  CONSTRAINT finance_funding_events_actor_fk FOREIGN KEY (venue_id,created_by)
    REFERENCES users(venue_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS finance_funding_events_venue_date_idx
  ON finance_funding_events(venue_id,event_date,created_at,id);
CREATE INDEX IF NOT EXISTS finance_funding_events_document_idx
  ON finance_funding_events(venue_id,document_id,event_date,created_at,id);
CREATE INDEX IF NOT EXISTS finance_funding_events_account_date_idx
  ON finance_funding_events(venue_id,finance_account_id,event_date);
CREATE INDEX IF NOT EXISTS finance_funding_events_shift_idx
  ON finance_funding_events(venue_id,shift_id) WHERE shift_id IS NOT NULL;

CREATE OR REPLACE FUNCTION guard_finance_funding_document() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'finance_funding_document_delete_forbidden' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'draft' THEN RAISE EXCEPTION 'finance_funding_document_state_invalid' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM finance_funding_events WHERE venue_id=OLD.venue_id AND document_id=OLD.id) THEN
    IF OLD.venue_id IS DISTINCT FROM NEW.venue_id OR OLD.document_type IS DISTINCT FROM NEW.document_type
      OR OLD.id IS DISTINCT FROM NEW.id OR OLD.updated_at IS DISTINCT FROM NEW.updated_at
      OR OLD.counterparty_name IS DISTINCT FROM NEW.counterparty_name OR OLD.basis IS DISTINCT FROM NEW.basis
      OR OLD.document_reference IS DISTINCT FROM NEW.document_reference OR OLD.principal_limit IS DISTINCT FROM NEW.principal_limit
      OR OLD.currency IS DISTINCT FROM NEW.currency OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
      OR OLD.request_sha256 IS DISTINCT FROM NEW.request_sha256 OR OLD.created_by IS DISTINCT FROM NEW.created_by
      OR OLD.created_at IS DISTINCT FROM NEW.created_at OR NEW.status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'finance_funding_document_immutable_after_event' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status<>'draft' OR NEW.status NOT IN ('draft','active','cancelled')
    OR NEW.venue_id IS DISTINCT FROM OLD.venue_id OR NEW.document_type IS DISTINCT FROM OLD.document_type
    OR NEW.id IS DISTINCT FROM OLD.id OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256
    OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'finance_funding_document_state_invalid' USING ERRCODE='55000';
  END IF;
  IF NEW.status='active' THEN
    RAISE EXCEPTION 'finance_funding_document_event_required' USING ERRCODE='23514';
  END IF;
  IF NEW.status='cancelled' AND (NEW.counterparty_name IS DISTINCT FROM OLD.counterparty_name
    OR NEW.basis IS DISTINCT FROM OLD.basis OR NEW.document_reference IS DISTINCT FROM OLD.document_reference
    OR NEW.principal_limit IS DISTINCT FROM OLD.principal_limit) THEN
    RAISE EXCEPTION 'finance_funding_document_state_invalid' USING ERRCODE='55000';
  END IF;
  NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS finance_funding_documents_guard ON finance_funding_documents;
CREATE TRIGGER finance_funding_documents_guard BEFORE INSERT OR UPDATE OR DELETE ON finance_funding_documents
  FOR EACH ROW EXECUTE FUNCTION guard_finance_funding_document();

CREATE OR REPLACE FUNCTION guard_finance_funding_event() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE document_row finance_funding_documents%ROWTYPE; account_row finance_accounts%ROWTYPE;
  venue_timezone text; open_shift_id uuid; open_shift_count integer; received_amount numeric(14,2); repaid_amount numeric(14,2);
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'finance_funding_events_append_only' USING ERRCODE='55000';
  END IF;
  SELECT * INTO document_row FROM finance_funding_documents
    WHERE venue_id=NEW.venue_id AND id=NEW.document_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'finance_funding_document_not_found' USING ERRCODE='23503'; END IF;
  IF document_row.status IN ('cancelled') THEN RAISE EXCEPTION 'finance_funding_document_not_open' USING ERRCODE='23514'; END IF;
  IF (document_row.document_type='owner_contribution' AND NEW.event_type<>'owner_contribution_received')
    OR (document_row.document_type='loan' AND NEW.event_type NOT IN ('loan_principal_received','loan_principal_repaid')) THEN
    RAISE EXCEPTION 'finance_funding_event_document_type_mismatch' USING ERRCODE='23514';
  END IF;
  IF document_row.document_type='loan' AND NEW.event_type='loan_principal_received' THEN
    SELECT COALESCE(SUM(amount),0) INTO received_amount FROM finance_funding_events
      WHERE venue_id=NEW.venue_id AND document_id=NEW.document_id AND event_type='loan_principal_received';
    IF received_amount+NEW.amount>document_row.principal_limit THEN
      RAISE EXCEPTION 'finance_loan_principal_limit_exceeded' USING ERRCODE='23514';
    END IF;
  ELSIF document_row.document_type='loan' AND NEW.event_type='loan_principal_repaid' THEN
    SELECT COALESCE(SUM(amount) FILTER (WHERE event_type='loan_principal_received'),0),
      COALESCE(SUM(amount) FILTER (WHERE event_type='loan_principal_repaid'),0)
      INTO received_amount,repaid_amount FROM finance_funding_events
      WHERE venue_id=NEW.venue_id AND document_id=NEW.document_id;
    IF repaid_amount+NEW.amount>received_amount THEN
      RAISE EXCEPTION 'finance_loan_repayment_exceeds_principal' USING ERRCODE='23514';
    END IF;
  END IF;
  SELECT * INTO account_row FROM finance_accounts
    WHERE venue_id=NEW.venue_id AND id=NEW.finance_account_id FOR UPDATE;
  IF NOT FOUND OR NOT account_row.active THEN RAISE EXCEPTION 'finance_account_inactive' USING ERRCODE='23514'; END IF;
  IF NEW.finance_account_name_snapshot IS DISTINCT FROM account_row.name THEN
    RAISE EXCEPTION 'finance_account_snapshot_mismatch' USING ERRCODE='23514';
  END IF;
  IF NOT (NEW.payment_method=ANY(account_row.allowed_payment_methods)) THEN
    RAISE EXCEPTION 'finance_payment_method_account_mismatch' USING ERRCODE='23514';
  END IF;
  IF account_row.kind='pos_cashbox' THEN
    IF NEW.payment_method<>'cash' THEN RAISE EXCEPTION 'finance_payment_method_account_mismatch' USING ERRCODE='23514'; END IF;
    SELECT timezone INTO venue_timezone FROM venues WHERE id=NEW.venue_id;
    IF NEW.event_date<>(now() AT TIME ZONE COALESCE(NULLIF(venue_timezone,''),'Europe/Moscow'))::date THEN
      RAISE EXCEPTION 'finance_pos_cash_payment_date_must_be_today' USING ERRCODE='23514';
    END IF;
    SELECT id INTO open_shift_id FROM shifts WHERE venue_id=NEW.venue_id AND closed_at IS NULL FOR UPDATE;
    SELECT COUNT(*)::int INTO open_shift_count FROM shifts WHERE venue_id=NEW.venue_id AND closed_at IS NULL;
    IF open_shift_count<>1 OR NEW.shift_id IS DISTINCT FROM open_shift_id THEN
      RAISE EXCEPTION 'finance_payment_open_shift_required' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.shift_id IS NOT NULL THEN
    RAISE EXCEPTION 'finance_funding_non_pos_shift_invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS finance_funding_events_guard ON finance_funding_events;
CREATE TRIGGER finance_funding_events_guard BEFORE INSERT OR UPDATE OR DELETE ON finance_funding_events
  FOR EACH ROW EXECUTE FUNCTION guard_finance_funding_event();

CREATE OR REPLACE FUNCTION activate_finance_funding_document() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE finance_funding_documents SET status='active'
    WHERE venue_id=NEW.venue_id AND id=NEW.document_id AND status='draft';
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_funding_event_activates_document ON finance_funding_events;
CREATE TRIGGER finance_funding_event_activates_document AFTER INSERT ON finance_funding_events
  FOR EACH ROW EXECUTE FUNCTION activate_finance_funding_document();

CREATE OR REPLACE FUNCTION guard_finance_funding_events_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'finance_funding_events_append_only' USING ERRCODE='55000';
END $$;
DROP TRIGGER IF EXISTS finance_funding_events_no_truncate ON finance_funding_events;
CREATE TRIGGER finance_funding_events_no_truncate BEFORE TRUNCATE ON finance_funding_events
  FOR EACH STATEMENT EXECUTE FUNCTION guard_finance_funding_events_truncate();

DROP TRIGGER IF EXISTS finance_funding_documents_no_truncate ON finance_funding_documents;
CREATE TRIGGER finance_funding_documents_no_truncate BEFORE TRUNCATE ON finance_funding_documents
  FOR EACH STATEMENT EXECUTE FUNCTION guard_finance_funding_events_truncate();

COMMENT ON TABLE finance_funding_documents IS
  'Venue-scoped owner contribution and loan principal documents. No expense, revenue or current-account-balance semantics.';
COMMENT ON TABLE finance_funding_events IS
  'Append-only owner contribution receipts and loan principal receipts/repayments; P&L effect is always none.';

-- Internal transfers are a single source fact with two immutable account legs.
-- Opening balances are signed, confirmed starting positions, not cash receipts.

CREATE TABLE IF NOT EXISTS finance_account_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  transfer_date date NOT NULL,
  from_account_id uuid NOT NULL,
  from_account_name_snapshot text NOT NULL CHECK (length(btrim(from_account_name_snapshot)) BETWEEN 1 AND 120),
  to_account_id uuid NOT NULL,
  to_account_name_snapshot text NOT NULL CHECK (length(btrim(to_account_name_snapshot)) BETWEEN 1 AND 120),
  shift_id uuid,
  note text NOT NULL CHECK (length(btrim(note)) BETWEEN 1 AND 500),
  reversal_of_transfer_id uuid,
  currency text NOT NULL DEFAULT 'RUB' CHECK (currency='RUB'),
  idempotency_key uuid NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,idempotency_key),
  FOREIGN KEY (venue_id,from_account_id) REFERENCES finance_accounts(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,to_account_id) REFERENCES finance_accounts(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,shift_id) REFERENCES shifts(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,reversal_of_transfer_id) REFERENCES finance_account_transfers(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  CHECK (from_account_id<>to_account_id)
);
CREATE INDEX IF NOT EXISTS finance_account_transfers_venue_date_idx
  ON finance_account_transfers(venue_id,transfer_date DESC,id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS finance_account_transfers_one_reversal_per_key_idx
  ON finance_account_transfers(venue_id,reversal_of_transfer_id,idempotency_key)
  WHERE reversal_of_transfer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS finance_account_transfer_legs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  transfer_id uuid NOT NULL,
  leg_type text NOT NULL CHECK (leg_type IN ('debit','credit')),
  finance_account_id uuid NOT NULL,
  finance_account_name_snapshot text NOT NULL CHECK (length(btrim(finance_account_name_snapshot)) BETWEEN 1 AND 120),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  shift_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,transfer_id,leg_type),
  FOREIGN KEY (venue_id,transfer_id) REFERENCES finance_account_transfers(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,finance_account_id) REFERENCES finance_accounts(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,shift_id) REFERENCES shifts(venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS finance_account_transfer_legs_venue_account_idx
  ON finance_account_transfer_legs(venue_id,finance_account_id,transfer_id);

CREATE TABLE IF NOT EXISTS finance_account_opening_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  finance_account_id uuid NOT NULL,
  finance_account_name_snapshot text NOT NULL CHECK (length(btrim(finance_account_name_snapshot)) BETWEEN 1 AND 120),
  amount numeric(14,2) NOT NULL,
  effective_date date NOT NULL,
  evidence_reference text NOT NULL CHECK (length(btrim(evidence_reference)) BETWEEN 1 AND 240),
  basis text NOT NULL CHECK (length(btrim(basis)) BETWEEN 1 AND 500),
  currency text NOT NULL DEFAULT 'RUB' CHECK (currency='RUB'),
  idempotency_key uuid NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  confirmed_by uuid NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,finance_account_id),
  UNIQUE (venue_id,idempotency_key),
  FOREIGN KEY (venue_id,finance_account_id) REFERENCES finance_accounts(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,confirmed_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS finance_account_opening_balances_venue_date_idx
  ON finance_account_opening_balances(venue_id,effective_date,id);

CREATE TABLE IF NOT EXISTS finance_account_opening_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  opening_balance_id uuid NOT NULL,
  finance_account_id uuid NOT NULL,
  amount_delta numeric(14,2) NOT NULL CHECK (amount_delta<>0),
  adjustment_date date NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  evidence_reference text NOT NULL CHECK (length(btrim(evidence_reference)) BETWEEN 1 AND 240),
  idempotency_key uuid NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,idempotency_key),
  FOREIGN KEY (venue_id,opening_balance_id) REFERENCES finance_account_opening_balances(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,finance_account_id) REFERENCES finance_accounts(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS finance_account_opening_adjustments_venue_opening_idx
  ON finance_account_opening_adjustments(venue_id,opening_balance_id,adjustment_date,id);

CREATE OR REPLACE FUNCTION guard_finance_account_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_account finance_accounts%ROWTYPE; destination_account finance_accounts%ROWTYPE;
  venue_timezone text; current_shift uuid; open_shift_count integer; original finance_account_transfers%ROWTYPE;
  reversed_amount numeric(14,2);
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'finance_account_transfers_append_only' USING ERRCODE='55000'; END IF;
  PERFORM 1 FROM finance_accounts WHERE venue_id=NEW.venue_id
    AND id IN (NEW.from_account_id,NEW.to_account_id) ORDER BY id FOR UPDATE;
  SELECT * INTO source_account FROM finance_accounts WHERE venue_id=NEW.venue_id AND id=NEW.from_account_id;
  SELECT * INTO destination_account FROM finance_accounts WHERE venue_id=NEW.venue_id AND id=NEW.to_account_id;
  IF source_account.id IS NULL OR destination_account.id IS NULL THEN RAISE EXCEPTION 'finance_transfer_account_not_found' USING ERRCODE='23503'; END IF;
  IF NEW.reversal_of_transfer_id IS NULL AND (NOT source_account.active OR NOT destination_account.active) THEN RAISE EXCEPTION 'finance_transfer_account_inactive' USING ERRCODE='23514'; END IF;
  IF source_account.name IS DISTINCT FROM NEW.from_account_name_snapshot OR destination_account.name IS DISTINCT FROM NEW.to_account_name_snapshot THEN
    RAISE EXCEPTION 'finance_transfer_account_snapshot_mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.reversal_of_transfer_id IS NOT NULL THEN
    SELECT * INTO original FROM finance_account_transfers WHERE venue_id=NEW.venue_id AND id=NEW.reversal_of_transfer_id FOR UPDATE;
    IF original.id IS NULL OR original.reversal_of_transfer_id IS NOT NULL
      OR NEW.from_account_id IS DISTINCT FROM original.to_account_id
      OR NEW.to_account_id IS DISTINCT FROM original.from_account_id THEN
      RAISE EXCEPTION 'finance_transfer_reversal_invalid' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(SUM(amount),0) INTO reversed_amount FROM finance_account_transfers
      WHERE venue_id=NEW.venue_id AND reversal_of_transfer_id=original.id;
    IF reversed_amount+NEW.amount>original.amount THEN RAISE EXCEPTION 'finance_transfer_reversal_exceeds_original' USING ERRCODE='23514'; END IF;
  END IF;
  IF source_account.kind='pos_cashbox' OR destination_account.kind='pos_cashbox' THEN
    SELECT timezone INTO venue_timezone FROM venues WHERE id=NEW.venue_id;
    IF NEW.transfer_date<>(now() AT TIME ZONE COALESCE(NULLIF(venue_timezone,''),'Europe/Moscow'))::date THEN
      RAISE EXCEPTION 'finance_transfer_pos_cash_date_must_be_today' USING ERRCODE='23514';
    END IF;
    SELECT id INTO current_shift FROM shifts WHERE venue_id=NEW.venue_id AND closed_at IS NULL FOR UPDATE;
    SELECT COUNT(*)::int INTO open_shift_count FROM shifts WHERE venue_id=NEW.venue_id AND closed_at IS NULL;
    IF open_shift_count<>1 OR NEW.shift_id IS DISTINCT FROM current_shift THEN
      RAISE EXCEPTION 'finance_transfer_open_shift_required' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.shift_id IS NOT NULL THEN
    RAISE EXCEPTION 'finance_transfer_shift_invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_account_transfers_guard ON finance_account_transfers;
CREATE TRIGGER finance_account_transfers_guard BEFORE INSERT OR UPDATE OR DELETE ON finance_account_transfers
  FOR EACH ROW EXECUTE FUNCTION guard_finance_account_transfer();

CREATE OR REPLACE FUNCTION create_finance_account_transfer_legs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO finance_account_transfer_legs(venue_id,transfer_id,leg_type,finance_account_id,finance_account_name_snapshot,amount,shift_id)
  VALUES(NEW.venue_id,NEW.id,'debit',NEW.from_account_id,NEW.from_account_name_snapshot,NEW.amount,
    CASE WHEN EXISTS(SELECT 1 FROM finance_accounts WHERE venue_id=NEW.venue_id AND id=NEW.from_account_id AND kind='pos_cashbox') THEN NEW.shift_id ELSE NULL END),
    (NEW.venue_id,NEW.id,'credit',NEW.to_account_id,NEW.to_account_name_snapshot,NEW.amount,
    CASE WHEN EXISTS(SELECT 1 FROM finance_accounts WHERE venue_id=NEW.venue_id AND id=NEW.to_account_id AND kind='pos_cashbox') THEN NEW.shift_id ELSE NULL END);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_account_transfers_create_legs ON finance_account_transfers;
CREATE TRIGGER finance_account_transfers_create_legs AFTER INSERT ON finance_account_transfers
  FOR EACH ROW EXECUTE FUNCTION create_finance_account_transfer_legs();

CREATE OR REPLACE FUNCTION guard_finance_account_transfer_leg() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'finance_account_transfer_legs_append_only' USING ERRCODE='55000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM finance_account_transfers t WHERE t.venue_id=NEW.venue_id AND t.id=NEW.transfer_id
    AND ((NEW.leg_type='debit' AND NEW.finance_account_id=t.from_account_id AND NEW.finance_account_name_snapshot=t.from_account_name_snapshot AND NEW.amount=t.amount)
      OR (NEW.leg_type='credit' AND NEW.finance_account_id=t.to_account_id AND NEW.finance_account_name_snapshot=t.to_account_name_snapshot AND NEW.amount=t.amount)))
  THEN RAISE EXCEPTION 'finance_account_transfer_leg_source_invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_account_transfer_legs_guard ON finance_account_transfer_legs;
CREATE TRIGGER finance_account_transfer_legs_guard BEFORE INSERT OR UPDATE OR DELETE ON finance_account_transfer_legs
  FOR EACH ROW EXECUTE FUNCTION guard_finance_account_transfer_leg();

CREATE OR REPLACE FUNCTION guard_finance_account_opening_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account_row finance_accounts%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'finance_account_opening_balances_append_only' USING ERRCODE='55000'; END IF;
  SELECT * INTO account_row FROM finance_accounts WHERE venue_id=NEW.venue_id AND id=NEW.finance_account_id FOR UPDATE;
  IF account_row.id IS NULL OR NOT account_row.active THEN RAISE EXCEPTION 'finance_opening_account_inactive' USING ERRCODE='23514'; END IF;
  IF account_row.kind='pos_cashbox' THEN RAISE EXCEPTION 'finance_opening_pos_cashbox_forbidden' USING ERRCODE='23514'; END IF;
  IF account_row.name IS DISTINCT FROM NEW.finance_account_name_snapshot THEN RAISE EXCEPTION 'finance_opening_account_snapshot_mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_account_opening_balances_guard ON finance_account_opening_balances;
CREATE TRIGGER finance_account_opening_balances_guard BEFORE INSERT OR UPDATE OR DELETE ON finance_account_opening_balances
  FOR EACH ROW EXECUTE FUNCTION guard_finance_account_opening_balance();

CREATE OR REPLACE FUNCTION guard_finance_account_opening_adjustment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE opening finance_account_opening_balances%ROWTYPE; account_row finance_accounts%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'finance_account_opening_adjustments_append_only' USING ERRCODE='55000'; END IF;
  SELECT * INTO opening FROM finance_account_opening_balances
    WHERE venue_id=NEW.venue_id AND id=NEW.opening_balance_id FOR UPDATE;
  IF opening.id IS NULL OR opening.finance_account_id IS DISTINCT FROM NEW.finance_account_id THEN
    RAISE EXCEPTION 'finance_opening_adjustment_source_invalid' USING ERRCODE='23514';
  END IF;
  SELECT * INTO account_row FROM finance_accounts WHERE venue_id=NEW.venue_id AND id=NEW.finance_account_id FOR UPDATE;
  IF account_row.id IS NULL OR NOT account_row.active THEN RAISE EXCEPTION 'finance_opening_account_inactive' USING ERRCODE='23514'; END IF;
  IF NEW.adjustment_date<opening.effective_date THEN RAISE EXCEPTION 'finance_opening_adjustment_before_cutoff' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_account_opening_adjustments_guard ON finance_account_opening_adjustments;
CREATE TRIGGER finance_account_opening_adjustments_guard BEFORE INSERT OR UPDATE OR DELETE ON finance_account_opening_adjustments
  FOR EACH ROW EXECUTE FUNCTION guard_finance_account_opening_adjustment();

CREATE OR REPLACE FUNCTION guard_finance_balance_events_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'finance_balance_events_append_only' USING ERRCODE='55000'; END $$;
DROP TRIGGER IF EXISTS finance_account_transfers_no_truncate ON finance_account_transfers;
CREATE TRIGGER finance_account_transfers_no_truncate BEFORE TRUNCATE ON finance_account_transfers
  FOR EACH STATEMENT EXECUTE FUNCTION guard_finance_balance_events_truncate();
DROP TRIGGER IF EXISTS finance_account_transfer_legs_no_truncate ON finance_account_transfer_legs;
CREATE TRIGGER finance_account_transfer_legs_no_truncate BEFORE TRUNCATE ON finance_account_transfer_legs
  FOR EACH STATEMENT EXECUTE FUNCTION guard_finance_balance_events_truncate();
DROP TRIGGER IF EXISTS finance_account_opening_balances_no_truncate ON finance_account_opening_balances;
CREATE TRIGGER finance_account_opening_balances_no_truncate BEFORE TRUNCATE ON finance_account_opening_balances
  FOR EACH STATEMENT EXECUTE FUNCTION guard_finance_balance_events_truncate();
DROP TRIGGER IF EXISTS finance_account_opening_adjustments_no_truncate ON finance_account_opening_adjustments;
CREATE TRIGGER finance_account_opening_adjustments_no_truncate BEFORE TRUNCATE ON finance_account_opening_adjustments
  FOR EACH STATEMENT EXECUTE FUNCTION guard_finance_balance_events_truncate();

CREATE OR REPLACE FUNCTION guard_finance_account_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.venue_id IS DISTINCT FROM NEW.venue_id OR OLD.code IS DISTINCT FROM NEW.code OR OLD.kind IS DISTINCT FROM NEW.kind OR OLD.allowed_payment_methods IS DISTINCT FROM NEW.allowed_payment_methods THEN RAISE EXCEPTION 'finance_account_identity_immutable' USING ERRCODE='55000'; END IF;
  IF OLD.active=false AND NEW.active=true AND (
    EXISTS (SELECT 1 FROM expenses e WHERE e.venue_id=OLD.venue_id AND e.finance_account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM finance_other_income_receipts r WHERE r.venue_id=OLD.venue_id AND r.finance_account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM finance_other_income_refunds r WHERE r.venue_id=OLD.venue_id AND r.finance_account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.venue_id=OLD.venue_id AND p.finance_account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM order_refund_tenders t WHERE t.venue_id=OLD.venue_id AND t.finance_account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM finance_funding_events e WHERE e.venue_id=OLD.venue_id AND e.finance_account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM finance_account_transfer_legs l WHERE l.venue_id=OLD.venue_id AND l.finance_account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM finance_account_opening_balances o WHERE o.venue_id=OLD.venue_id AND o.finance_account_id=OLD.id)
  ) THEN RAISE EXCEPTION 'finance_account_used_cannot_be_reactivated' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

COMMENT ON TABLE finance_account_transfers IS 'Atomic internal account movement. Two immutable legs are generated from one committed transfer; no P&L effect.';
COMMENT ON TABLE finance_account_opening_balances IS 'Confirmed opening position as of the start of a venue-local date; not a cash receipt or a complete current account balance.';
COMMENT ON TABLE finance_account_opening_adjustments IS 'Append-only corrections to a confirmed opening position with explicit evidence and reason.';


-- Migration 129: recurring partial month
-- Explicit calendar-day proration. Existing rules retain full-month-only behavior.
ALTER TABLE finance_recurring_rules ADD COLUMN IF NOT EXISTS partial_month_policy text NOT NULL DEFAULT 'full_months_only';
ALTER TABLE finance_recurring_rules DROP CONSTRAINT IF EXISTS finance_recurring_partial_month_policy_check;
ALTER TABLE finance_recurring_rules ADD CONSTRAINT finance_recurring_partial_month_policy_check
  CHECK (partial_month_policy IN ('full_months_only','calendar_days'));
ALTER TABLE finance_payables ADD COLUMN IF NOT EXISTS proration_snapshot jsonb;
ALTER TABLE finance_payables DROP CONSTRAINT IF EXISTS finance_payables_proration_snapshot_check;
ALTER TABLE finance_payables ADD CONSTRAINT finance_payables_proration_snapshot_check CHECK (
  proration_snapshot IS NULL OR COALESCE((recurring_rule_id IS NOT NULL AND recurring_version_id IS NOT NULL
    AND jsonb_typeof(proration_snapshot)='object'
    AND proration_snapshot->>'policy'='calendar_days'
    AND proration_snapshot->>'calculationVersion'='1'
    AND jsonb_typeof(proration_snapshot->'monthlyLines')='array'
    AND jsonb_typeof(proration_snapshot->'calculatedLines')='array'
    AND (proration_snapshot->>'monthlyAmount')::numeric>=0
    AND (proration_snapshot->>'calculatedAmount')::numeric>=0
    AND (proration_snapshot->>'coveredTo')::date-(proration_snapshot->>'coveredFrom')::date+1=(proration_snapshot->>'coveredDays')::integer
    AND (proration_snapshot->>'coveredDays')::integer BETWEEN 1 AND 30
    AND (proration_snapshot->>'monthDays')::integer BETWEEN 28 AND 31
    AND (proration_snapshot->>'coveredDays')::integer < (proration_snapshot->>'monthDays')::integer
    AND proration_snapshot ?& ARRAY['calculationVersion','policy','coveredFrom','coveredTo','coveredDays','monthDays','monthlyAmount','monthlyLines','calculatedAmount','calculatedLines']),false));

CREATE OR REPLACE FUNCTION guard_finance_recurring_partial_policy()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.partial_month_policy IS DISTINCT FROM NEW.partial_month_policy THEN
    RAISE EXCEPTION 'finance_recurring_partial_policy_immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_recurring_partial_policy_guard ON finance_recurring_rules;
CREATE TRIGGER finance_recurring_partial_policy_guard BEFORE UPDATE ON finance_recurring_rules
  FOR EACH ROW EXECUTE FUNCTION guard_finance_recurring_partial_policy();

CREATE OR REPLACE FUNCTION guard_finance_payable_proration_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.proration_snapshot IS DISTINCT FROM NEW.proration_snapshot THEN
    RAISE EXCEPTION 'finance_payable_proration_snapshot_immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_payable_proration_snapshot_guard ON finance_payables;
CREATE TRIGGER finance_payable_proration_snapshot_guard BEFORE UPDATE ON finance_payables
  FOR EACH ROW EXECUTE FUNCTION guard_finance_payable_proration_snapshot();


-- Migration 130: contractual payment refunds
-- Extend the existing cash-refund ledger to exact payments of contractual obligations.
ALTER TABLE finance_expense_refunds ADD COLUMN IF NOT EXISTS payable_id uuid;
ALTER TABLE finance_expense_refunds DROP CONSTRAINT IF EXISTS finance_expense_refunds_payable_fk;
ALTER TABLE finance_expense_refunds ADD CONSTRAINT finance_expense_refunds_payable_fk
  FOREIGN KEY (venue_id,payable_id) REFERENCES finance_payables(venue_id,id) ON DELETE RESTRICT;
ALTER TABLE finance_expense_refunds DROP CONSTRAINT IF EXISTS finance_expense_refunds_pnl_effect_check;
ALTER TABLE finance_expense_refunds ADD CONSTRAINT finance_expense_refunds_pnl_effect_check
  CHECK ((payable_id IS NULL AND pnl_effect='not_calculated') OR (payable_id IS NOT NULL AND pnl_effect='separate_payable_recognition'));
CREATE INDEX IF NOT EXISTS finance_expense_refunds_payable_idx ON finance_expense_refunds(venue_id,payable_id,refund_date,id);
COMMENT ON TABLE finance_expense_refunds IS 'Append-only cash receipts against exact manual/other expenses or contractual payable payments. Payable recognition and reversals remain separate events.';
COMMENT ON COLUMN finance_expense_refunds.payable_id IS 'Derived under the payable row lock from the immutable expense payment link; never inferred from labels.';

CREATE OR REPLACE FUNCTION guard_finance_expense_refund()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_expense expenses%ROWTYPE;
  linked_payable uuid;
  destination_account finance_accounts%ROWTYPE;
  open_shift_id uuid;
  open_shift_count integer;
  already_returned numeric(14,2);
  venue_timezone text;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'finance_expense_refunds_append_only' USING ERRCODE='55000';
  END IF;

  SELECT payable_id INTO linked_payable FROM finance_payable_payment_links WHERE venue_id=NEW.venue_id AND expense_id=NEW.expense_id;
  IF linked_payable IS NOT NULL THEN
    PERFORM 1 FROM finance_payables WHERE venue_id=NEW.venue_id AND id=linked_payable AND status='approved' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'finance_payable_not_approved' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.payable_id IS NOT NULL AND NEW.payable_id IS DISTINCT FROM linked_payable THEN
    RAISE EXCEPTION 'finance_expense_refund_payable_mismatch' USING ERRCODE='23514';
  END IF;
  NEW.payable_id:=linked_payable;
  NEW.pnl_effect:=CASE WHEN linked_payable IS NULL THEN 'not_calculated' ELSE 'separate_payable_recognition' END;
  SELECT * INTO source_expense FROM expenses
    WHERE venue_id=NEW.venue_id AND id=NEW.expense_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'finance_expense_refund_source_not_found' USING ERRCODE='23503'; END IF;
  IF source_expense.source NOT IN ('manual','other') OR source_expense.purchase_document_id IS NOT NULL
    OR EXISTS(SELECT 1 FROM payroll_entries WHERE venue_id=NEW.venue_id AND expense_id=NEW.expense_id) THEN
    RAISE EXCEPTION 'finance_expense_refund_not_supported' USING ERRCODE='23514';
  END IF;
  IF NEW.refund_date<source_expense.expense_date THEN
    RAISE EXCEPTION 'finance_expense_refund_date_before_expense' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(NULLIF(timezone,''),'Europe/Moscow') INTO venue_timezone FROM venues WHERE id=NEW.venue_id;
  IF NEW.refund_date>(now() AT TIME ZONE COALESCE(venue_timezone,'Europe/Moscow'))::date THEN
    RAISE EXCEPTION 'finance_expense_refund_date_in_future' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(SUM(amount),0) INTO already_returned FROM finance_expense_refunds
    WHERE venue_id=NEW.venue_id AND expense_id=NEW.expense_id;
  IF already_returned+NEW.amount>source_expense.amount THEN
    RAISE EXCEPTION 'finance_expense_refund_exceeds_balance' USING ERRCODE='23514';
  END IF;

  SELECT * INTO destination_account FROM finance_accounts
    WHERE venue_id=NEW.venue_id AND id=NEW.finance_account_id FOR UPDATE;
  IF NOT FOUND OR NOT destination_account.active THEN
    RAISE EXCEPTION 'finance_account_inactive' USING ERRCODE='23514';
  END IF;
  IF NEW.finance_account_name_snapshot IS DISTINCT FROM destination_account.name THEN
    RAISE EXCEPTION 'finance_account_snapshot_mismatch' USING ERRCODE='23514';
  END IF;
  IF NOT (NEW.payment_method=ANY(destination_account.allowed_payment_methods)) THEN
    RAISE EXCEPTION 'finance_payment_method_account_mismatch' USING ERRCODE='23514';
  END IF;
  IF destination_account.kind='pos_cashbox' THEN
    IF NEW.payment_method<>'cash' THEN RAISE EXCEPTION 'finance_payment_method_account_mismatch' USING ERRCODE='23514'; END IF;
    IF NEW.refund_date<>(now() AT TIME ZONE COALESCE(venue_timezone,'Europe/Moscow'))::date THEN
      RAISE EXCEPTION 'finance_pos_cash_payment_date_must_be_today' USING ERRCODE='23514';
    END IF;
    SELECT id INTO open_shift_id FROM shifts WHERE venue_id=NEW.venue_id AND closed_at IS NULL FOR UPDATE;
    SELECT count(*)::int INTO open_shift_count FROM shifts WHERE venue_id=NEW.venue_id AND closed_at IS NULL;
    IF open_shift_count<>1 OR NEW.shift_id IS DISTINCT FROM open_shift_id THEN
      RAISE EXCEPTION 'finance_payment_open_shift_required' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.shift_id IS NOT NULL THEN
    RAISE EXCEPTION 'finance_expense_refund_non_pos_shift_invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


CREATE OR REPLACE FUNCTION guard_finance_payable_payment_link()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p finance_payables%ROWTYPE; e expenses%ROWTYPE; paid numeric(14,2);
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'finance_payable_payment_links_append_only' USING ERRCODE='55000'; END IF;
  SELECT * INTO p FROM finance_payables WHERE venue_id=NEW.venue_id AND id=NEW.payable_id FOR UPDATE;
  SELECT * INTO e FROM expenses WHERE venue_id=NEW.venue_id AND id=NEW.expense_id FOR KEY SHARE;
  IF p.id IS NULL OR p.status <> 'approved' OR e.id IS NULL OR e.source <> 'manual'
      OR e.amount <> NEW.applied_amount OR e.category_id <> p.category_id
      OR EXISTS(SELECT 1 FROM finance_expense_refunds WHERE venue_id=NEW.venue_id AND expense_id=NEW.expense_id) THEN
    RAISE EXCEPTION 'finance_payable_payment_link_invalid' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(SUM(applied_amount),0)::numeric(14,2) INTO paid FROM finance_payable_payment_links
    WHERE venue_id=NEW.venue_id AND payable_id=NEW.payable_id;
  paid:=paid-(SELECT COALESCE(SUM(amount),0) FROM finance_expense_refunds WHERE venue_id=NEW.venue_id AND payable_id=NEW.payable_id);
  IF paid + NEW.applied_amount > p.total_amount THEN
    RAISE EXCEPTION 'finance_payable_payment_exceeds_balance' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


CREATE OR REPLACE FUNCTION guard_finance_payable_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE recognized numeric(14,2);
BEGIN
  IF OLD.status <> 'draft' AND (
    OLD.venue_id IS DISTINCT FROM NEW.venue_id OR OLD.category_id IS DISTINCT FROM NEW.category_id
    OR OLD.category_name_snapshot IS DISTINCT FROM NEW.category_name_snapshot
    OR OLD.title IS DISTINCT FROM NEW.title OR OLD.counterparty_name IS DISTINCT FROM NEW.counterparty_name
    OR OLD.basis IS DISTINCT FROM NEW.basis OR OLD.period_from IS DISTINCT FROM NEW.period_from
    OR OLD.period_to IS DISTINCT FROM NEW.period_to OR OLD.due_date IS DISTINCT FROM NEW.due_date
    OR OLD.total_amount IS DISTINCT FROM NEW.total_amount OR OLD.recurring_rule_id IS DISTINCT FROM NEW.recurring_rule_id
    OR OLD.recurring_version_id IS DISTINCT FROM NEW.recurring_version_id OR OLD.period_key IS DISTINCT FROM NEW.period_key
    OR OLD.variable_amount_confirmed_at IS DISTINCT FROM NEW.variable_amount_confirmed_at
    OR OLD.variable_amount_confirmed_by IS DISTINCT FROM NEW.variable_amount_confirmed_by
  ) THEN RAISE EXCEPTION 'finance_payable_immutable' USING ERRCODE='55000'; END IF;
  IF OLD.status='approved' AND NEW.status='cancelled' THEN
    IF (SELECT COALESCE(SUM(applied_amount),0) FROM finance_payable_payment_links WHERE venue_id=OLD.venue_id AND payable_id=OLD.id)
       > (SELECT COALESCE(SUM(amount),0) FROM finance_expense_refunds WHERE venue_id=OLD.venue_id AND payable_id=OLD.id) THEN
      RAISE EXCEPTION 'finance_payable_has_payments' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(r.amount,0)-COALESCE(SUM(x.amount),0) INTO recognized
      FROM finance_payable_recognitions r LEFT JOIN finance_payable_recognition_reversals x
        ON x.venue_id=r.venue_id AND x.recognition_id=r.id
      WHERE r.venue_id=OLD.venue_id AND r.payable_id=OLD.id GROUP BY r.amount;
    IF COALESCE(recognized,0)>0 THEN RAISE EXCEPTION 'finance_payable_has_recognition' USING ERRCODE='23514'; END IF;
  ELSIF OLD.status <> NEW.status AND NOT (OLD.status='draft' AND NEW.status IN ('approved','cancelled')) THEN
    RAISE EXCEPTION 'finance_payable_transition_invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


-- Migration 131: non-cash payable allocations
-- Non-cash redistribution of an existing contractual payment.
CREATE TABLE IF NOT EXISTS finance_payable_offsets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
 expense_id uuid NOT NULL,
 source_payable_id uuid NOT NULL,
 destination_payable_id uuid NOT NULL,
 amount numeric(14,2) NOT NULL CHECK(amount>0),
 offset_date date NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 500),
 document_reference text CHECK(length(document_reference)<=200),
 reversal_of_id uuid,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 120),
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(venue_id,id), UNIQUE(venue_id,idempotency_key),
 CHECK(source_payable_id<>destination_payable_id),
 FOREIGN KEY(venue_id,expense_id) REFERENCES expenses(venue_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(venue_id,source_payable_id) REFERENCES finance_payables(venue_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(venue_id,destination_payable_id) REFERENCES finance_payables(venue_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(venue_id,reversal_of_id) REFERENCES finance_payable_offsets(venue_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS finance_payable_offsets_expense_idx ON finance_payable_offsets(venue_id,expense_id);
CREATE INDEX IF NOT EXISTS finance_payable_offsets_source_idx ON finance_payable_offsets(venue_id,source_payable_id);
CREATE INDEX IF NOT EXISTS finance_payable_offsets_destination_idx ON finance_payable_offsets(venue_id,destination_payable_id);
CREATE INDEX IF NOT EXISTS finance_payable_offsets_reversal_idx ON finance_payable_offsets(venue_id,reversal_of_id);

CREATE OR REPLACE FUNCTION finance_payable_expense_allocation(v uuid,e uuid,p uuid)
RETURNS numeric LANGUAGE sql STABLE AS $$
 SELECT (COALESCE((SELECT SUM(applied_amount) FROM finance_payable_payment_links WHERE venue_id=v AND expense_id=e AND payable_id=p),0)
 -COALESCE((SELECT SUM(amount) FROM finance_expense_refunds WHERE venue_id=v AND expense_id=e AND payable_id=p),0)
 +COALESCE((SELECT SUM(amount) FROM finance_payable_offsets WHERE venue_id=v AND expense_id=e AND destination_payable_id=p),0)
 -COALESCE((SELECT SUM(amount) FROM finance_payable_offsets WHERE venue_id=v AND expense_id=e AND source_payable_id=p),0))::numeric(14,2)
$$;
CREATE OR REPLACE FUNCTION finance_payable_settled_amount(v uuid,p uuid)
RETURNS numeric LANGUAGE sql STABLE AS $$
 SELECT (COALESCE((SELECT SUM(applied_amount) FROM finance_payable_payment_links WHERE venue_id=v AND payable_id=p),0)
 -COALESCE((SELECT SUM(amount) FROM finance_expense_refunds WHERE venue_id=v AND payable_id=p),0)
 +COALESCE((SELECT SUM(amount) FROM finance_payable_offsets WHERE venue_id=v AND destination_payable_id=p),0)
 -COALESCE((SELECT SUM(amount) FROM finance_payable_offsets WHERE venue_id=v AND source_payable_id=p),0))::numeric(14,2)
$$;

CREATE OR REPLACE FUNCTION guard_finance_payable_offset()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE origin_id uuid; source_doc finance_payables%ROWTYPE; destination_doc finance_payables%ROWTYPE;
 source_expense expenses%ROWTYPE; original finance_payable_offsets%ROWTYPE; reversed numeric; tz text;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'finance_payable_offsets_append_only' USING ERRCODE='55000'; END IF;
 SELECT payable_id INTO origin_id FROM finance_payable_payment_links WHERE venue_id=NEW.venue_id AND expense_id=NEW.expense_id;
 IF origin_id IS NULL THEN RAISE EXCEPTION 'finance_payable_offset_payment_not_found' USING ERRCODE='23514'; END IF;
 -- All writers lock payable rows before expenses; include the original even for chained allocations.
 PERFORM id FROM finance_payables WHERE venue_id=NEW.venue_id AND id IN(origin_id,NEW.source_payable_id,NEW.destination_payable_id) ORDER BY id FOR UPDATE;
 SELECT * INTO source_doc FROM finance_payables WHERE venue_id=NEW.venue_id AND id=NEW.source_payable_id;
 SELECT * INTO destination_doc FROM finance_payables WHERE venue_id=NEW.venue_id AND id=NEW.destination_payable_id;
 IF source_doc.id IS NULL OR destination_doc.id IS NULL OR source_doc.status<>'approved' OR destination_doc.status<>'approved' THEN
  RAISE EXCEPTION 'finance_payable_offset_document_not_approved' USING ERRCODE='23514'; END IF;
 SELECT * INTO source_expense FROM expenses WHERE venue_id=NEW.venue_id AND id=NEW.expense_id FOR UPDATE;
 SELECT COALESCE(NULLIF(timezone,''),'Europe/Moscow') INTO tz FROM venues WHERE id=NEW.venue_id;
 IF NEW.offset_date<source_expense.expense_date OR NEW.offset_date>(now() AT TIME ZONE tz)::date THEN
  RAISE EXCEPTION 'finance_payable_offset_date_invalid' USING ERRCODE='23514'; END IF;
 IF NEW.reversal_of_id IS NOT NULL THEN
  SELECT * INTO original FROM finance_payable_offsets WHERE venue_id=NEW.venue_id AND id=NEW.reversal_of_id;
  IF original.id IS NULL OR original.reversal_of_id IS NOT NULL OR original.expense_id<>NEW.expense_id
   OR original.source_payable_id<>NEW.destination_payable_id OR original.destination_payable_id<>NEW.source_payable_id
   OR NEW.offset_date<original.offset_date THEN
   RAISE EXCEPTION 'finance_payable_offset_reversal_invalid' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(SUM(amount),0) INTO reversed FROM finance_payable_offsets WHERE venue_id=NEW.venue_id AND reversal_of_id=original.id;
  IF reversed+NEW.amount>original.amount THEN RAISE EXCEPTION 'finance_payable_offset_reversal_exceeds_balance' USING ERRCODE='23514'; END IF;
 END IF;
 IF finance_payable_expense_allocation(NEW.venue_id,NEW.expense_id,NEW.source_payable_id)<NEW.amount THEN
  RAISE EXCEPTION 'finance_payable_offset_exceeds_allocation' USING ERRCODE='23514'; END IF;
 IF finance_payable_settled_amount(NEW.venue_id,NEW.destination_payable_id)+NEW.amount>destination_doc.total_amount THEN
  RAISE EXCEPTION 'finance_payable_offset_exceeds_debt' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_payable_offsets_guard ON finance_payable_offsets;
CREATE TRIGGER finance_payable_offsets_guard BEFORE INSERT OR UPDATE OR DELETE ON finance_payable_offsets FOR EACH ROW EXECUTE FUNCTION guard_finance_payable_offset();
COMMENT ON TABLE finance_payable_offsets IS 'Append-only non-cash allocation of an existing expense payment. Never a new payment, cash receipt, or recognition event.';

CREATE OR REPLACE FUNCTION guard_finance_expense_refund()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_expense expenses%ROWTYPE;
  linked_payable uuid;
  destination_account finance_accounts%ROWTYPE;
  open_shift_id uuid;
  open_shift_count integer;
  already_returned numeric(14,2);
  venue_timezone text;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'finance_expense_refunds_append_only' USING ERRCODE='55000';
  END IF;

  SELECT payable_id INTO linked_payable FROM finance_payable_payment_links WHERE venue_id=NEW.venue_id AND expense_id=NEW.expense_id;
  IF linked_payable IS NOT NULL THEN
    PERFORM 1 FROM finance_payables WHERE venue_id=NEW.venue_id AND id=linked_payable AND status='approved' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'finance_payable_not_approved' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.payable_id IS NOT NULL AND NEW.payable_id IS DISTINCT FROM linked_payable THEN
    RAISE EXCEPTION 'finance_expense_refund_payable_mismatch' USING ERRCODE='23514';
  END IF;
  NEW.payable_id:=linked_payable;
  NEW.pnl_effect:=CASE WHEN linked_payable IS NULL THEN 'not_calculated' ELSE 'separate_payable_recognition' END;
  SELECT * INTO source_expense FROM expenses
    WHERE venue_id=NEW.venue_id AND id=NEW.expense_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'finance_expense_refund_source_not_found' USING ERRCODE='23503'; END IF;
  -- A link created while waiting for the expense lock requires a fresh transaction.
  IF linked_payable IS DISTINCT FROM (SELECT payable_id FROM finance_payable_payment_links WHERE venue_id=NEW.venue_id AND expense_id=NEW.expense_id) THEN
    RAISE EXCEPTION 'finance_expense_refund_source_changed' USING ERRCODE='40001'; END IF;
  IF linked_payable IS NOT NULL AND finance_payable_expense_allocation(NEW.venue_id,NEW.expense_id,linked_payable)<NEW.amount THEN
    RAISE EXCEPTION 'finance_expense_refund_exceeds_allocation' USING ERRCODE='23514'; END IF;
  IF source_expense.source NOT IN ('manual','other') OR source_expense.purchase_document_id IS NOT NULL
    OR EXISTS(SELECT 1 FROM payroll_entries WHERE venue_id=NEW.venue_id AND expense_id=NEW.expense_id) THEN
    RAISE EXCEPTION 'finance_expense_refund_not_supported' USING ERRCODE='23514';
  END IF;
  IF NEW.refund_date<source_expense.expense_date THEN
    RAISE EXCEPTION 'finance_expense_refund_date_before_expense' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(NULLIF(timezone,''),'Europe/Moscow') INTO venue_timezone FROM venues WHERE id=NEW.venue_id;
  IF NEW.refund_date>(now() AT TIME ZONE COALESCE(venue_timezone,'Europe/Moscow'))::date THEN
    RAISE EXCEPTION 'finance_expense_refund_date_in_future' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(SUM(amount),0) INTO already_returned FROM finance_expense_refunds
    WHERE venue_id=NEW.venue_id AND expense_id=NEW.expense_id;
  IF already_returned+NEW.amount>source_expense.amount THEN
    RAISE EXCEPTION 'finance_expense_refund_exceeds_balance' USING ERRCODE='23514';
  END IF;

  SELECT * INTO destination_account FROM finance_accounts
    WHERE venue_id=NEW.venue_id AND id=NEW.finance_account_id FOR UPDATE;
  IF NOT FOUND OR NOT destination_account.active THEN
    RAISE EXCEPTION 'finance_account_inactive' USING ERRCODE='23514';
  END IF;
  IF NEW.finance_account_name_snapshot IS DISTINCT FROM destination_account.name THEN
    RAISE EXCEPTION 'finance_account_snapshot_mismatch' USING ERRCODE='23514';
  END IF;
  IF NOT (NEW.payment_method=ANY(destination_account.allowed_payment_methods)) THEN
    RAISE EXCEPTION 'finance_payment_method_account_mismatch' USING ERRCODE='23514';
  END IF;
  IF destination_account.kind='pos_cashbox' THEN
    IF NEW.payment_method<>'cash' THEN RAISE EXCEPTION 'finance_payment_method_account_mismatch' USING ERRCODE='23514'; END IF;
    IF NEW.refund_date<>(now() AT TIME ZONE COALESCE(venue_timezone,'Europe/Moscow'))::date THEN
      RAISE EXCEPTION 'finance_pos_cash_payment_date_must_be_today' USING ERRCODE='23514';
    END IF;
    SELECT id INTO open_shift_id FROM shifts WHERE venue_id=NEW.venue_id AND closed_at IS NULL FOR UPDATE;
    SELECT count(*)::int INTO open_shift_count FROM shifts WHERE venue_id=NEW.venue_id AND closed_at IS NULL;
    IF open_shift_count<>1 OR NEW.shift_id IS DISTINCT FROM open_shift_id THEN
      RAISE EXCEPTION 'finance_payment_open_shift_required' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.shift_id IS NOT NULL THEN
    RAISE EXCEPTION 'finance_expense_refund_non_pos_shift_invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


CREATE OR REPLACE FUNCTION guard_finance_payable_payment_link()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p finance_payables%ROWTYPE; e expenses%ROWTYPE; paid numeric(14,2);
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'finance_payable_payment_links_append_only' USING ERRCODE='55000'; END IF;
  SELECT * INTO p FROM finance_payables WHERE venue_id=NEW.venue_id AND id=NEW.payable_id FOR UPDATE;
  SELECT * INTO e FROM expenses WHERE venue_id=NEW.venue_id AND id=NEW.expense_id FOR KEY SHARE;
  IF p.id IS NULL OR p.status <> 'approved' OR e.id IS NULL OR e.source <> 'manual'
      OR e.amount <> NEW.applied_amount OR e.category_id <> p.category_id
      OR EXISTS(SELECT 1 FROM finance_expense_refunds WHERE venue_id=NEW.venue_id AND expense_id=NEW.expense_id) THEN
    RAISE EXCEPTION 'finance_payable_payment_link_invalid' USING ERRCODE='23514';
  END IF;
  paid:=finance_payable_settled_amount(NEW.venue_id,NEW.payable_id);
  IF paid + NEW.applied_amount > p.total_amount THEN
    RAISE EXCEPTION 'finance_payable_payment_exceeds_balance' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


CREATE OR REPLACE FUNCTION guard_finance_payable_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE recognized numeric(14,2);
BEGIN
  IF OLD.status <> 'draft' AND (
    OLD.venue_id IS DISTINCT FROM NEW.venue_id OR OLD.category_id IS DISTINCT FROM NEW.category_id
    OR OLD.category_name_snapshot IS DISTINCT FROM NEW.category_name_snapshot
    OR OLD.title IS DISTINCT FROM NEW.title OR OLD.counterparty_name IS DISTINCT FROM NEW.counterparty_name
    OR OLD.basis IS DISTINCT FROM NEW.basis OR OLD.period_from IS DISTINCT FROM NEW.period_from
    OR OLD.period_to IS DISTINCT FROM NEW.period_to OR OLD.due_date IS DISTINCT FROM NEW.due_date
    OR OLD.total_amount IS DISTINCT FROM NEW.total_amount OR OLD.recurring_rule_id IS DISTINCT FROM NEW.recurring_rule_id
    OR OLD.recurring_version_id IS DISTINCT FROM NEW.recurring_version_id OR OLD.period_key IS DISTINCT FROM NEW.period_key
    OR OLD.variable_amount_confirmed_at IS DISTINCT FROM NEW.variable_amount_confirmed_at
    OR OLD.variable_amount_confirmed_by IS DISTINCT FROM NEW.variable_amount_confirmed_by
  ) THEN RAISE EXCEPTION 'finance_payable_immutable' USING ERRCODE='55000'; END IF;
  IF OLD.status='approved' AND NEW.status='cancelled' THEN
    IF finance_payable_settled_amount(OLD.venue_id,OLD.id)>0 THEN
      RAISE EXCEPTION 'finance_payable_has_payments' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(r.amount,0)-COALESCE(SUM(x.amount),0) INTO recognized
      FROM finance_payable_recognitions r LEFT JOIN finance_payable_recognition_reversals x
        ON x.venue_id=r.venue_id AND x.recognition_id=r.id
      WHERE r.venue_id=OLD.venue_id AND r.payable_id=OLD.id GROUP BY r.amount;
    IF COALESCE(recognized,0)>0 THEN RAISE EXCEPTION 'finance_payable_has_recognition' USING ERRCODE='23514'; END IF;
  ELSIF OLD.status <> NEW.status AND NOT (OLD.status='draft' AND NEW.status IN ('approved','cancelled')) THEN
    RAISE EXCEPTION 'finance_payable_transition_invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
