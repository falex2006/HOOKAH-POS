'use strict';

const assert = require('node:assert/strict');
const { consumeAlphaSatAdapterLimit, getAlphaSatAdapterSourceAddress, MAX_BUCKETS, WINDOW_MS } = require('./alphasat-adapter-rate-limit.cjs');

assert.equal(getAlphaSatAdapterSourceAddress({ 'x-real-ip': '198.51.100.8' }, '172.19.0.3', true), '198.51.100.8', 'trusted Nginx source identity uses the validated client IP');
assert.equal(getAlphaSatAdapterSourceAddress({ 'x-real-ip': '198.51.100.8' }, '172.19.0.3', false), '172.19.0.3', 'untrusted deployments ignore forwarded headers');
assert.equal(getAlphaSatAdapterSourceAddress({ 'x-real-ip': '198.51.100.8, 203.0.113.4' }, '172.19.0.3', true), '172.19.0.3', 'chained or malformed proxy headers are rejected');
assert.equal(getAlphaSatAdapterSourceAddress({ 'x-real-ip': 'not-an-ip' }, '172.19.0.3', true), '172.19.0.3', 'invalid proxy values fall back to the socket peer');

const buckets = new Map();
assert.equal(consumeAlphaSatAdapterLimit(buckets, 'peer-a', 2, 1_000), false);
assert.equal(consumeAlphaSatAdapterLimit(buckets, 'peer-a', 2, 1_001), false);
assert.equal(consumeAlphaSatAdapterLimit(buckets, 'peer-a', 2, 1_002), true);
assert.equal(consumeAlphaSatAdapterLimit(buckets, 'peer-a', 2, 1_000 + WINDOW_MS), false, 'expired windows reset');

const credentialBuckets = new Map();
assert.equal(consumeAlphaSatAdapterLimit(credentialBuckets, 'validated-credential', 1, 2_000), false);
assert.equal(consumeAlphaSatAdapterLimit(credentialBuckets, 'validated-credential', 1, 2_001), true);

const bounded = new Map();
for (let index = 0; index < MAX_BUCKETS + 1_000; index += 1) {
  consumeAlphaSatAdapterLimit(bounded, `peer-${index}`, 10, 3_000);
}
assert.equal(bounded.size, MAX_BUCKETS, 'high-cardinality source addresses cannot grow the map without bound');

process.stdout.write('AlphaSat adapter rate-limit QA passed.\n');
