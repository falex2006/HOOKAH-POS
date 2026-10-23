'use strict';

// Collect provenance alongside the existing depletion algorithm. Collection
// does not change its quantities, valuation, locks or stock movement writes.
const createInventoryOrderCostCapture = cards => {
  const reasons = new Set(), components = [], movements = [];
  const lines = cards.map(card => ({ orderItemId: card.orderItemId, productId: card.productId,
    quantity: String(card.orderQuantity), inventoryMode: card.inventoryMode,
    recipe: card.recipeId ? { id: card.recipeId, portionCount: String(card.portionCount),
      directlyBound: card.directlyBound === true, ingredients: structuredClone(card.ingredients) } : null }));
  const recordRequirement = (requirement, stock, quantity) => {
    if (!requirement.orderItemId) {
      reasons.add('legacy_recipe_line_allocation_unproven');
      if (lines.some(line => line.productId === requirement.productId && line.inventoryMode === 'non_stock')) {
        reasons.add('non_stock_legacy_consumption_ambiguous');
      }
      return;
    }
    components.push({ orderItemId: requirement.orderItemId, ingredientId: stock.id,
      quantity: Number.isFinite(quantity) ? quantity.toFixed(6) : String(quantity),
      unitCost: String(stock.cost), stockUnit: String(stock.unit),
      sourceQuantity: String(requirement.quantityText), sourceUnit: String(requirement.sourceUnit) });
  };
  const recordMovement = (ingredientId, movement) => {
    movements.push({ ingredientId, movementId: movement.id, quantity: String(movement.quantity) });
  };
  const snapshot = () => {
    const movementByIngredient = new Map();
    for (const movement of movements) {
      if (movementByIngredient.has(movement.ingredientId)) reasons.add('depletion_movement_allocation_ambiguous');
      movementByIngredient.set(movement.ingredientId, movement);
    }
    const grouped = new Map();
    for (const component of components) {
      const movement = movementByIngredient.get(component.ingredientId);
      if (!movement) { reasons.add('depletion_movement_missing'); continue; }
      if (!/^\d+\.\d{6}$/.test(component.quantity)) { reasons.add('depletion_quantity_unrepresentable'); continue; }
      const key = `${component.orderItemId}/${component.ingredientId}`;
      if (!grouped.has(key)) grouped.set(key, { ...component, movementId: movement.movementId, micro: 0n, sourceRequirements: [] });
      const row = grouped.get(key);
      if (row.unitCost !== component.unitCost || row.stockUnit !== component.stockUnit) reasons.add('depletion_valuation_ambiguous');
      row.micro += BigInt(component.quantity.replace('.', ''));
      row.sourceRequirements.push({ quantity: component.sourceQuantity, unit: component.sourceUnit });
    }
    for (const line of lines) {
      if (line.inventoryMode === 'tracked' && !components.some(component => component.orderItemId === line.orderItemId)) {
        reasons.add('tracked_line_cost_unproven');
      }
      if (line.inventoryMode === 'non_stock' && components.some(component => component.orderItemId === line.orderItemId)) {
        reasons.add('non_stock_consumption_ambiguous');
      }
    }
    const outputComponents = [...grouped.values()].map(({ micro, sourceQuantity, sourceUnit, ...row }) => {
      const text = micro.toString().padStart(7, '0');
      return { ...row, quantity: `${text.slice(0, -6)}.${text.slice(-6)}` };
    });
    return structuredClone({ captureVersion: 1, status: reasons.size ? 'incomplete' : 'captured',
      reasons: [...reasons].sort(), lines, components: outputComponents, movements });
  };
  return { recordRequirement, recordMovement, snapshot };
};

const unavailableInventoryOrderCostCapture = () => ({ captureVersion: 1, status: 'unavailable',
  reasons: ['historical_depletion_evidence_unavailable'], lines: [], components: [], movements: [] });

module.exports = { createInventoryOrderCostCapture, unavailableInventoryOrderCostCapture };
