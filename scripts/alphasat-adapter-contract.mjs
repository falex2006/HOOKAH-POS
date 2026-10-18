import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'migrations', '098_alphasat_readonly_adapter.sql'), 'utf8');
const credentialScript = fs.readFileSync(path.join(root, 'scripts', 'alphasat-adapter-credential.cjs'), 'utf8');
const acceptance = fs.readFileSync(path.join(root, 'scripts', 'alphasat-adapter-acceptance.mjs'), 'utf8');
const limiter = fs.readFileSync(path.join(root, 'scripts', 'alphasat-adapter-rate-limit.cjs'), 'utf8');
const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
const nginx = fs.readFileSync(path.join(root, 'nginx', 'default.conf'), 'utf8');
const routeStart = source.indexOf("if (pathname.startsWith('/api/alphasat/v1/'))");
const sessionGate = source.indexOf('const hasRequestCredential = Boolean');
const setupRoute = source.indexOf("if (pathname === '/api/setup/status'");

assert.ok(routeStart >= 0 && routeStart < sessionGate, 'Machine endpoints must be handled before cookie/session authentication');
assert.ok(setupRoute > routeStart && setupRoute < sessionGate, 'The adapter must be an early, isolated route block');
const adapter = source.slice(routeStart, setupRoute);
const preflightStart = source.indexOf("if (pathname.startsWith('/api/alphasat/v1/') && req.method === 'OPTIONS')");
const preflightEnd = source.indexOf("if (req.method === 'OPTIONS')", preflightStart);
const preflight = source.slice(preflightStart, preflightEnd);
assert.match(adapter, /req\.method !== 'GET'/, 'Machine adapter must reject write methods');
assert.match(adapter, /req\.headers\.authorization/, 'Adapter must use Authorization header');
assert.doesNotMatch(adapter, /requestCookies|sessionFromRequest/, 'Machine auth must not fall back to browser cookies');
assert.match(adapter, /timingSafeEqual/, 'Credential verification must use constant-time hash comparison');
assert.match(adapter, /consumeAlphaSatAdapterLimit\(alphasatAdapterSourceBuckets, sourceAddress, API_RATE_LIMIT\)/,
  'Unauthenticated lookups must be rate-limited by a validated source address before database access');
assert.match(adapter, /getAlphaSatAdapterSourceAddress\([\s\S]*ALPHASAT_TRUST_PROXY === 'true'/,
  'Forwarded client IP is used only when the deployment explicitly trusts its reverse proxy');
assert.match(adapter, /consumeAlphaSatAdapterLimit\(alphasatAdapterCredentialBuckets, credential\.id, API_RATE_LIMIT\)/,
  'A credential bucket may be keyed only after its secret hash is verified');
assert.ok(adapter.indexOf('timingSafeEqual') < adapter.indexOf('alphasatAdapterCredentialBuckets'),
  'Credential-specific rate limiting must happen after authentication');
assert.match(limiter, /MAX_BUCKETS = 5_000/, 'Adapter rate-limit memory is hard-bounded');
assert.doesNotMatch(adapter, /credential:\$\{tokenMatch\[2\]\}/,
  'Untrusted token IDs must never allocate per-credential buckets');
assert.match(adapter, /WHERE id=\$1 AND revoked_at IS NULL AND \(expires_at IS NULL OR expires_at>now\(\)\)/,
  'Revoked and expired credentials must be rejected');
assert.match(adapter, /WHERE id=\$1/, 'Organization list must be restricted to the credential-bound organization');
assert.match(adapter, /contract_version: '1\.0'[\s\S]*product_code: 'hookah-pos'[\s\S]*organizations\.list[\s\S]*organizations\.read/,
  'Status must advertise only the actual read-only contract');
assert.match(adapter, /items: \[\{ id: organization\.id, name: organization\.name, state:/,
  'List response must be allowlisted to organization ID, name and state');
assert.match(adapter, /Cache-Control', 'no-store'/, 'Machine responses must not be cached');
assert.match(compose, /ALPHASAT_TRUST_PROXY: "true"/, 'Compose explicitly enables trusted reverse-proxy identity for the CRM service');
assert.match(nginx, /proxy_set_header X-Real-IP \$remote_addr;/, 'Nginx overwrites the client IP header at the public ingress');
assert.doesNotMatch(preflight, /Access-Control-Allow-Origin/, 'Machine preflight does not inherit broad browser CORS configuration');

assert.match(migration, /installation_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid\(\)/,
  'The product installation identity must be stable and stored');
assert.match(migration, /token_hash char\(64\)/, 'Only a token hash may be stored');
assert.match(migration, /allowed_organization_id uuid NOT NULL REFERENCES organizations\(id\) ON DELETE RESTRICT/,
  'Each credential must be scoped to one existing organization');
assert.doesNotMatch(migration, /token\s+text/i, 'Migration must never store a raw bearer token');
assert.match(credentialScript, /randomBytes\(32\)/, 'Issued bearer secret must have 256 bits of entropy');
assert.match(credentialScript, /createHash\('sha256'\)\.update\(secret\)/,
  'The database stores only the one-way hash of the bearer secret');
assert.match(credentialScript, /SET revoked_at=COALESCE\(revoked_at,now\(\)\)/,
  'Credential revocation must be idempotent');
assert.match(credentialScript, /action === 'audit'[\s\S]*action LIKE 'alphasat\.adapter\.%'/,
  'Global adapter audit events must be retrievable by an operator');
assert.match(acceptance, /redirect: 'manual'/, 'Acceptance client must detect redirects without following them');
assert.match(acceptance, /otherOrganizationResponse\.status, 404/,
  'Acceptance must verify isolation from unrelated organizations');

console.log('ALPHASAT ADAPTER CONTRACT: PASS');
