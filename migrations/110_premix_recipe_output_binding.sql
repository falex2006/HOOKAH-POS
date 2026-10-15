-- Keep each premix formula attached to the stock ingredient that receives its batches.
ALTER TABLE inventory_recipe_cards
  ADD COLUMN IF NOT EXISTS output_ingredient_id uuid;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ingredients_venue_id_id_uq' AND conrelid='ingredients'::regclass) THEN
    ALTER TABLE ingredients ADD CONSTRAINT ingredients_venue_id_id_uq UNIQUE (venue_id,id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_recipe_cards_venue_id_id_uq' AND conrelid='inventory_recipe_cards'::regclass) THEN
    ALTER TABLE inventory_recipe_cards ADD CONSTRAINT inventory_recipe_cards_venue_id_id_uq UNIQUE (venue_id,id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_recipe_cards_premix_output_fk' AND conrelid='inventory_recipe_cards'::regclass) THEN
    ALTER TABLE inventory_recipe_cards ADD CONSTRAINT inventory_recipe_cards_premix_output_fk
      FOREIGN KEY (venue_id,output_ingredient_id) REFERENCES ingredients(venue_id,id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_premix_batches_recipe_venue_fk' AND conrelid='inventory_premix_batches'::regclass) THEN
    ALTER TABLE inventory_premix_batches ADD CONSTRAINT inventory_premix_batches_recipe_venue_fk
      FOREIGN KEY (venue_id,recipe_id) REFERENCES inventory_recipe_cards(venue_id,id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_premix_batches_output_venue_fk' AND conrelid='inventory_premix_batches'::regclass) THEN
    ALTER TABLE inventory_premix_batches ADD CONSTRAINT inventory_premix_batches_output_venue_fk
      FOREIGN KEY (venue_id,output_ingredient_id) REFERENCES ingredients(venue_id,id) ON DELETE RESTRICT;
  END IF;
END $$;

-- Recover an existing binding only when every known batch for a premix points
-- to the same stock ingredient and no other premix formula shares that output.
WITH recipe_outputs AS (
  SELECT recipe_id, (array_agg(DISTINCT output_ingredient_id))[1] AS ingredient_id
  FROM inventory_premix_batches
  GROUP BY recipe_id
  HAVING count(DISTINCT output_ingredient_id) = 1
), unshared_outputs AS (
  SELECT ingredient_id
  FROM recipe_outputs
  GROUP BY ingredient_id
  HAVING count(*) = 1
)
UPDATE inventory_recipe_cards recipe
SET output_ingredient_id = recipe_outputs.ingredient_id
FROM recipe_outputs
JOIN unshared_outputs USING (ingredient_id)
WHERE recipe.id = recipe_outputs.recipe_id
  AND recipe.recipe_type = 'premix'
  AND recipe.output_ingredient_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS inventory_recipe_cards_premix_output_unique_idx
  ON inventory_recipe_cards(venue_id, output_ingredient_id)
  WHERE recipe_type = 'premix' AND output_ingredient_id IS NOT NULL;

CREATE OR REPLACE FUNCTION inventory_recipe_premix_output_scope_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE output_venue uuid;
BEGIN
  IF NEW.recipe_type='premix' AND NEW.output_ingredient_id IS NULL
     AND (TG_OP='INSERT' OR OLD.recipe_type IS DISTINCT FROM 'premix') THEN
    RAISE EXCEPTION 'premix_output_binding_required' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE'
     AND EXISTS (SELECT 1 FROM inventory_premix_batches batch WHERE batch.recipe_id=NEW.id)
     AND (NEW.recipe_type <> 'premix' OR (OLD.output_ingredient_id IS NOT NULL AND NEW.output_ingredient_id IS DISTINCT FROM OLD.output_ingredient_id)) THEN
    RAISE EXCEPTION 'premix_recipe_has_incompatible_batches' USING ERRCODE='23514';
  END IF;
  IF NEW.recipe_type <> 'premix' OR NEW.output_ingredient_id IS NULL THEN RETURN NEW; END IF;
  SELECT venue_id INTO output_venue FROM ingredients
   WHERE id=NEW.output_ingredient_id AND is_marked=true;
  IF output_venue IS NULL OR output_venue IS DISTINCT FROM NEW.venue_id THEN
    RAISE EXCEPTION 'premix_recipe_output_scope_mismatch' USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM inventory_recipe_cards other
    WHERE other.venue_id=NEW.venue_id
      AND other.recipe_type='premix'
      AND other.output_ingredient_id=NEW.output_ingredient_id
      AND other.id<>NEW.id
  ) THEN
    RAISE EXCEPTION 'premix_output_already_bound' USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS inventory_recipe_premix_output_scope_guard ON inventory_recipe_cards;
CREATE TRIGGER inventory_recipe_premix_output_scope_guard
BEFORE INSERT OR UPDATE OF venue_id,recipe_type,output_ingredient_id ON inventory_recipe_cards
FOR EACH ROW EXECUTE FUNCTION inventory_recipe_premix_output_scope_guard();

CREATE OR REPLACE FUNCTION inventory_premix_batch_recipe_binding_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE recipe_venue uuid; recipe_type text; bound_ingredient uuid;
BEGIN
  SELECT venue_id,recipe_type,output_ingredient_id
    INTO recipe_venue,recipe_type,bound_ingredient
    FROM inventory_recipe_cards WHERE id=NEW.recipe_id;
  IF recipe_venue IS NULL OR recipe_venue IS DISTINCT FROM NEW.venue_id
     OR recipe_type IS DISTINCT FROM 'premix'
     OR bound_ingredient IS NULL OR bound_ingredient IS DISTINCT FROM NEW.output_ingredient_id THEN
    RAISE EXCEPTION 'premix_batch_recipe_binding_mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS inventory_premix_batch_recipe_binding_guard ON inventory_premix_batches;
CREATE TRIGGER inventory_premix_batch_recipe_binding_guard
BEFORE INSERT OR UPDATE OF venue_id,recipe_id,output_ingredient_id ON inventory_premix_batches
FOR EACH ROW EXECUTE FUNCTION inventory_premix_batch_recipe_binding_guard();
