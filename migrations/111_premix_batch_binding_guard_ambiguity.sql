CREATE OR REPLACE FUNCTION inventory_premix_batch_recipe_binding_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  recipe_venue uuid;
  v_recipe_type text;
  bound_ingredient uuid;
BEGIN
  SELECT card.venue_id, card.recipe_type, card.output_ingredient_id
    INTO recipe_venue, v_recipe_type, bound_ingredient
    FROM inventory_recipe_cards AS card
    WHERE card.id = NEW.recipe_id;

  IF recipe_venue IS NULL OR recipe_venue IS DISTINCT FROM NEW.venue_id
     OR v_recipe_type IS DISTINCT FROM 'premix'
     OR bound_ingredient IS NULL OR bound_ingredient IS DISTINCT FROM NEW.output_ingredient_id THEN
    RAISE EXCEPTION 'premix_batch_recipe_binding_mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
