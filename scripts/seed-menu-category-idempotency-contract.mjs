import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./seed-menu-catalog.js', import.meta.url), 'utf8');
assert.match(source, /SAVEPOINT seed_menu_category/);
assert.match(source, /WHERE NOT EXISTS \([\s\S]*?venue_id=\$1 AND lower\(name\)=lower\(\$2\) AND is_active=true[\s\S]*?\)\s+ON CONFLICT \(venue_id, name\) DO UPDATE SET is_active=true/);
assert.match(source, /ROLLBACK TO SAVEPOINT seed_menu_category[\s\S]*?RELEASE SAVEPOINT seed_menu_category/);
assert.match(source, /error\.code !== '23505' \|\| error\.constraint !== 'idx_product_categories_active_name'/);
assert.match(source, /SELECT 1 FROM product_categories\s+WHERE venue_id=\$1 AND lower\(name\)=lower\(\$2\) AND is_active=true/);
assert.match(source, /if \(!activeCategory\.rowCount\) throw error/);
console.log('SEED MENU CATEGORY IDEMPOTENCY CONTRACT: PASS');
