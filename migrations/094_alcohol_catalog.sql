-- Tenant-scoped descriptive alcohol catalog. Inventory remains owned by ingredients.
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
UPDATE ingredients i SET organization_id=v.organization_id
  FROM venues v WHERE v.id=i.venue_id AND i.organization_id IS DISTINCT FROM v.organization_id;
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
