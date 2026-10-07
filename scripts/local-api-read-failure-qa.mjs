import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const slices = [
  // These legacy endpoints were removed from the POS API. Keep the contract
  // on the current product read route, where a configured DB must fail closed.
  ['/api/products', "  if (pathname === '/api/products' && req.method === 'GET')", "  if (pathname === '/api/recipes'", 'products_unavailable']
];
let checks = 0;
const previousUrl = process.env.DATABASE_URL;
const previousAuthRequired = process.env.AUTH_REQUIRED;
try {
  process.env.DATABASE_URL = 'postgresql://localhost/local_qa';
  process.env.AUTH_REQUIRED = 'true';
  for (const [route, begin, end, error] of slices) {
    const start = source.indexOf(begin), finish = source.indexOf(end, start + begin.length);
    assert.ok(start >= 0 && finish > start);
    const implementation = source.slice(start, finish);
    const call = async (repositories, denied = false) => {
      let response;
      const deny = () => { if (denied) response = { status: 403, data: { error: 'forbidden' } }; return denied; };
      await new Function('pathname','req','res','repositories','venueDbId','denyUnless','denyUnlessAny','hasPermission','json','products','staff','clients','process', `return (async()=>{${implementation}})();`)(
        route, { method: 'GET' }, {}, repositories, 'synthetic-local-venue', deny, deny,
        () => !denied,
        (_res, status, data) => { response = { status, data }; }, [{ id: 'must-not-leak-demo-product' }], [{ id: 'must-not-leak-demo-staff' }], [{ id: 'must-not-leak-demo-guest' }], process
      );
      return response;
    };
    const throws = { pool: { query: async () => { throw new Error('synthetic PostgreSQL outage'); } }, products: { list: async () => { throw new Error('synthetic PostgreSQL outage'); } } };
    for (const repositories of [throws, null]) {
      const response = await call(repositories);
      assert.deepEqual(response, { status: 503, data: { error } }, `${route}: configured database failure must not return global demo data`); checks++;
    }
    assert.equal((await call(throws, true)).status, 403, `${route}: denied permission stays denied during an outage`); checks++;
  }
  console.log(`LOCAL API READ FAILURE QA: PASS (${checks} actual route checks; denied403; unavailable503; demo data never leaks)`);
} finally {
  if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
  if (previousAuthRequired === undefined) delete process.env.AUTH_REQUIRED; else process.env.AUTH_REQUIRED = previousAuthRequired;
}
