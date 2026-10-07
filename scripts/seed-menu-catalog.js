'use strict';

const { Pool } = require('pg');
const catalog = require('../catalog-seed');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const venueId = process.env.VENUE_ID || '00000000-0000-0000-0000-000000000001';
const pool = new Pool({ connectionString: databaseUrl });

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const categories = [...new Set((catalog.products || []).map((item) => String(item.category || '').trim()).filter(Boolean))];
    for (const name of categories) {
      await client.query('SAVEPOINT seed_menu_category');
      try {
        await client.query(
          `INSERT INTO product_categories (venue_id, name)
           SELECT $1, $2
           WHERE NOT EXISTS (
             SELECT 1 FROM product_categories
             WHERE venue_id=$1 AND lower(name)=lower($2) AND is_active=true
           )
           ON CONFLICT (venue_id, name) DO UPDATE SET is_active=true`,
          [venueId, name]
        );
        await client.query('RELEASE SAVEPOINT seed_menu_category');
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT seed_menu_category');
        await client.query('RELEASE SAVEPOINT seed_menu_category');
        if (error.code !== '23505' || error.constraint !== 'idx_product_categories_active_name') throw error;
        const activeCategory = await client.query(
          `SELECT 1 FROM product_categories
           WHERE venue_id=$1 AND lower(name)=lower($2) AND is_active=true
           LIMIT 1`,
          [venueId, name]
        );
        if (!activeCategory.rowCount) throw error;
      }
    }
    for (const item of catalog.products || []) {
      await client.query(
        `INSERT INTO products (venue_id, name, category, sale_price, search_aliases, image_url)
         SELECT $1, $2, $3, $4, $5, $6
         WHERE NOT EXISTS (SELECT 1 FROM products WHERE venue_id=$1 AND name=$2)`,
        [venueId, item.name, item.category || item.station || 'Бар', Number(item.price || 0), item.aliases || [], item.imageUrl || null]
      );
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({ venueId, categories: categories.length, products: (catalog.products || []).length }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
