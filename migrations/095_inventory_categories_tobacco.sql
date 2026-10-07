-- Stable venue category links and incremental editable inventory defaults.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='product_categories_venue_id_id_uq' AND conrelid='product_categories'::regclass) THEN
    ALTER TABLE product_categories ADD CONSTRAINT product_categories_venue_id_id_uq UNIQUE (venue_id,id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS inventory_category_seed_state (
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  seed_key text NOT NULL,
  category_id uuid,
  installed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venue_id,seed_key),
  FOREIGN KEY (venue_id,category_id) REFERENCES product_categories(venue_id,id) ON DELETE SET NULL (category_id)
);

ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS category_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ingredients_venue_category_fk' AND conrelid='ingredients'::regclass) THEN
    ALTER TABLE ingredients ADD CONSTRAINT ingredients_venue_category_fk
      FOREIGN KEY (venue_id,category_id) REFERENCES product_categories(venue_id,id) ON DELETE SET NULL (category_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS ingredients_venue_category_idx ON ingredients(venue_id,category_id) WHERE category_id IS NOT NULL;

ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS tobacco_catalog_item_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tobacco_catalog_items_org_id_uq' AND conrelid='tobacco_catalog_items'::regclass) THEN
    ALTER TABLE tobacco_catalog_items ADD CONSTRAINT tobacco_catalog_items_org_id_uq UNIQUE (organization_id,id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ingredients_tobacco_org_fk' AND conrelid='ingredients'::regclass) THEN
    ALTER TABLE ingredients ADD CONSTRAINT ingredients_tobacco_org_fk
      FOREIGN KEY (organization_id,tobacco_catalog_item_id) REFERENCES tobacco_catalog_items(organization_id,id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS ingredients_tobacco_catalog_idx ON ingredients(organization_id,tobacco_catalog_item_id) WHERE tobacco_catalog_item_id IS NOT NULL;

-- Backfill only a unique category within this venue and department. Legacy text
-- remains the compatibility value when no unique match exists.
WITH matches AS (
  SELECT i.id, min(c.id::text)::uuid AS category_id, count(c.id) AS match_count
  FROM ingredients i
  LEFT JOIN product_categories c ON c.venue_id=i.venue_id
    AND c.department=i.department AND lower(btrim(c.name))=lower(btrim(i.category))
  GROUP BY i.id
)
UPDATE ingredients i SET category_id=m.category_id
FROM matches m WHERE m.id=i.id AND m.match_count=1;

CREATE OR REPLACE FUNCTION guard_ingredient_tobacco_link() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE item_scope text; item_venue uuid; item_active boolean;
BEGIN
  IF NEW.tobacco_catalog_item_id IS NULL THEN RETURN NEW; END IF;
  SELECT scope,venue_id,is_active INTO item_scope,item_venue,item_active
    FROM tobacco_catalog_items
    WHERE organization_id=NEW.organization_id AND id=NEW.tobacco_catalog_item_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tobacco catalog item does not exist' USING ERRCODE='23503'; END IF;
  IF item_scope='venue' AND item_venue IS DISTINCT FROM NEW.venue_id THEN
    RAISE EXCEPTION 'tobacco catalog item belongs to another venue' USING ERRCODE='23514';
  END IF;
  IF NOT item_active AND (TG_OP='INSERT' OR OLD.tobacco_catalog_item_id IS DISTINCT FROM NEW.tobacco_catalog_item_id) THEN
    RAISE EXCEPTION 'inactive tobacco catalog items cannot be newly linked' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS ingredients_tobacco_link_guard ON ingredients;
CREATE TRIGGER ingredients_tobacco_link_guard
  BEFORE INSERT OR UPDATE OF venue_id,organization_id,tobacco_catalog_item_id ON ingredients
  FOR EACH ROW EXECUTE FUNCTION guard_ingredient_tobacco_link();

CREATE OR REPLACE FUNCTION ensure_inventory_category_defaults(target_venue uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE entry record; matched_id uuid; new_id uuid;
BEGIN
  INSERT INTO inventory_departments(venue_id,code,name,description,color,sort_order) VALUES
    (target_venue,'bar','Бар','Напитки, сиропы и чай','amber',20),
    (target_venue,'hookah','Кальяны','Табак, уголь и расходники','violet',30)
  ON CONFLICT DO NOTHING;
  FOR entry IN SELECT * FROM (VALUES
    ('bar.water','bar','Вода'),('bar.soft-drinks','bar','Безалкогольные напитки'),
    ('bar.tea-coffee','bar','Чай и кофе'),('bar.ingredients','bar','Барные ингредиенты'),
    ('bar.spirits','bar','Крепкий алкоголь'),
    ('hookah.tobacco','hookah','Табак и смеси'),('hookah.coal','hookah','Уголь'),
    ('hookah.bowls','hookah','Чаши'),('hookah.hookahs','hookah','Кальяны'),
    ('hookah.flasks','hookah','Колбы'),('hookah.consumables','hookah','Расходники')
  ) AS defaults(seed_key,department,name)
  LOOP
    INSERT INTO inventory_category_seed_state(venue_id,seed_key)
      VALUES(target_venue,entry.seed_key) ON CONFLICT DO NOTHING;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF NOT EXISTS (SELECT 1 FROM inventory_departments d WHERE d.venue_id=target_venue AND d.code=entry.department AND d.is_active) THEN
      DELETE FROM inventory_category_seed_state WHERE venue_id=target_venue AND seed_key=entry.seed_key;
      CONTINUE;
    END IF;
    SELECT id INTO matched_id FROM product_categories
      WHERE venue_id=target_venue AND department=entry.department AND lower(btrim(name))=lower(entry.name)
      ORDER BY is_active DESC,created_at,id LIMIT 1;
    IF matched_id IS NULL THEN
      INSERT INTO product_categories(venue_id,name,department) VALUES(target_venue,entry.name,entry.department) RETURNING id INTO new_id;
      matched_id:=new_id;
    END IF;
    UPDATE inventory_category_seed_state SET category_id=matched_id WHERE venue_id=target_venue AND seed_key=entry.seed_key;
  END LOOP;
END; $$;

CREATE OR REPLACE FUNCTION seed_inventory_category_defaults_for_venue() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  PERFORM ensure_inventory_category_defaults(NEW.id); RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS venues_seed_inventory_category_defaults ON venues;
CREATE TRIGGER venues_seed_inventory_category_defaults AFTER INSERT ON venues
  FOR EACH ROW EXECUTE FUNCTION seed_inventory_category_defaults_for_venue();

DO $$ DECLARE venue_row record; BEGIN
  FOR venue_row IN SELECT id FROM venues LOOP PERFORM ensure_inventory_category_defaults(venue_row.id); END LOOP;
END $$;
