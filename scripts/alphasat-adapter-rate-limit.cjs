'use strict';

const net = require('node:net');
const WINDOW_MS = 60_000;
const MAX_BUCKETS = 5_000;

function getAlphaSatAdapterSourceAddress(headers, socketAddress, trustProxy = false) {
  const peer = typeof socketAddress === 'string' && socketAddress ? socketAddress : 'unknown';
  if (!trustProxy) return peer;
  const forwarded = headers && typeof headers['x-real-ip'] === 'string'
    ? headers['x-real-ip'].trim()
    : '';
  return forwarded && net.isIP(forwarded) ? forwarded : peer;
}

function consumeAlphaSatAdapterLimit(buckets, key, limit, now = Date.now()) {
  const previous = buckets.get(key);
  const bucket = previous && now - previous.startedAt < WINDOW_MS
    ? { startedAt: previous.startedAt, count: previous.count + 1 }
    : { startedAt: now, count: 1 };
  buckets.delete(key);
  buckets.set(key, bucket);

  if (buckets.size > MAX_BUCKETS) {
    for (const [candidate, value] of buckets) {
      if (now - value.startedAt >= WINDOW_MS) buckets.delete(candidate);
    }
  }
  while (buckets.size > MAX_BUCKETS) buckets.delete(buckets.keys().next().value);
  return bucket.count > limit;
}

module.exports = { consumeAlphaSatAdapterLimit, getAlphaSatAdapterSourceAddress, MAX_BUCKETS, WINDOW_MS };
