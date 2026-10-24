import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { InventoryRepository, PurchaseDocumentRepository } = require('../db.js');

class FakePool {
  constructor() { this.balance = 5; this.cost = 2; this.queries = []; }
  async connect() {
    return {
      query: async (sql, params = []) => {
        this.queries.push(sql.trim());
        if (sql.includes('SELECT id,name,unit FROM ingredients')) return { rows: [{ id: 'ingredient-1', name: 'QA лимон', unit: 'кг' }] };
        if (sql.includes('SELECT id,name,unit,cost FROM ingredients')) return { rows: [{ id: 'ingredient-1', name: 'QA лимон', unit: 'кг', cost: this.cost }] };
        if (sql.includes('SELECT COALESCE(SUM(CASE WHEN direction')) return { rows: [{ value: this.balance }] };
        if (sql.includes('INSERT INTO stock_movements')) {
          const direction = sql.includes("VALUES ($1,$2,'in'") ? 'in' : params[2];
          const quantity = sql.includes("VALUES ($1,$2,'in'") ? Number(params[2]) : Number(params[3]);
          this.balance += ['out','waste'].includes(direction) ? -quantity : quantity;
          return { rows: [{ id: `movement-${this.queries.length}`, itemId: 'ingredient-1', quantity, direction, reason: 'qa' }] };
        }
        if (sql.startsWith('UPDATE ingredients SET cost=')) { this.cost = Number(params[0]); return { rows: [] }; }
        return { rows: [] };
      },
      release: () => { this.queries.push('RELEASE'); }
    };
  }
}

const pool = new FakePool();
const inventory = new InventoryRepository(pool);
const venueId = '00000000-0000-0000-0000-000000000001';
await assert.rejects(() => inventory.move({ venueId, ingredientId: 'ingredient-1', unit: 'кг', direction: 'out', quantity: 6 }),
  (error) => error.code === 'insufficient_stock' && error.onHand === 5);
assert.equal(pool.balance, 5, 'rejected movement cannot alter the ledger');
const movement = await inventory.move({ venueId, ingredientId: 'ingredient-1', unit: 'кг', direction: 'out', quantity: 2 });
assert.equal(movement.onHandBefore, 5);
assert.equal(movement.onHandAfter, 3);
assert.equal(pool.balance, 3);
const receipt = await inventory.receive({ venueId, ingredientId: 'ingredient-1', stockUnit: 'кг', quantity: 4, conversionFactor: 1, unitCost: 6 });
assert.equal(receipt.onHandBefore, 3);
assert.equal(receipt.onHandAfter, 7);
assert.equal(receipt.weightedCost, 4.2857, 'preserve four-decimal weighted unit cost: (3 kg × 2 + 4 kg × 6) / 7 kg');
assert.equal(pool.balance, 7);
assert.equal(pool.queries.filter((query) => query === 'COMMIT').length, 2);
assert.ok(pool.queries.every((query) => query === 'RELEASE' || ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(query) || query.includes('pg_advisory_xact_lock_shared') || query.includes('FOR UPDATE') || query.includes('SELECT COALESCE') || query.includes('INSERT INTO stock_movements') || query.startsWith('UPDATE ingredients SET cost=')),
  'balance, stock ledger, and receipt cost must only use the transaction connection');

const converted = PurchaseDocumentRepository.lineForItem({ ingredientId: 'ingredient-1', quantity: 2, unit: 'л', unitCost: 120 }, { id: 'ingredient-1', name: 'QA сироп', unit: 'мл' });
assert.equal(converted.stockQuantity, 2000);
assert.equal(converted.receiptUnitCost, 0.12);
assert.equal(converted.lineTotal, 240);
const packaged = PurchaseDocumentRepository.lineForItem({ ingredientId: 'ingredient-1', quantity: 2, unit: 'бутылка', unitCost: 120 }, { id: 'ingredient-1', name: 'QA сироп', unit: 'мл', purchaseUnit: 'бутылка', packMultiplier: 1000 });
assert.equal(packaged.stockQuantity, 2000, 'two 1-liter bottles should add 2,000 ml to stock');
assert.equal(packaged.receiptUnitCost, 0.12, 'purchase price per bottle must normalize to cost per milliliter');
assert.equal(packaged.lineTotal, 240, 'purchase total must remain quantity times purchase-unit price');
assert.throws(() => PurchaseDocumentRepository.lineForItem({ ingredientId: 'ingredient-1', quantity: 1, unit: 'шт', unitCost: 2 }, { id: 'ingredient-1', name: 'QA сироп', unit: 'мл' }), /invalid_purchase_unit/);

console.log('INVENTORY MOVEMENT TRANSACTION QA: passed (stock lock, negative-balance guard, weighted receipt cost, unit conversion)');
