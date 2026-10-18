import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const liveConfig = fs.readFileSync(path.join(root, 'nginx', 'default.conf'), 'utf8');
const exampleConfig = fs.readFileSync(path.join(root, 'nginx', 'https.conf.example'), 'utf8');

assert.equal([...liveConfig.matchAll(/if \(\$host != "212\.192\.0\.58"\) \{ return 444; \}/g)].length, 2,
  'The live IP configuration must reject unexpected Host values on HTTP and HTTPS');
assert.match(liveConfig, /return 301 https:\/\/212\.192\.0\.58\$request_uri;/,
  'HTTP redirects must use the canonical IP instead of reflecting Host');
assert.doesNotMatch(liveConfig, /return\s+30[18]\s+https:\/\/\$host/i,
  'The live HTTPS redirect must not reflect an attacker-controlled Host');
assert.match(liveConfig, /proxy_set_header Host 212\.192\.0\.58;/,
  'The application must receive the canonical host');
assert.match(liveConfig, /Strict-Transport-Security "max-age=31536000" always;/,
  'The live HTTPS vhost must advertise HSTS');

assert.match(exampleConfig, /if \(\$host != "crm\.example\.com"\) \{ return 444; \}/,
  'The domain template must reject unexpected Host values');
assert.match(exampleConfig, /return 301 https:\/\/crm\.example\.com\$request_uri;/,
  'The domain template must redirect to its configured canonical host');
assert.doesNotMatch(exampleConfig, /return\s+30[18]\s+https:\/\/\$host/i,
  'The domain template must not reflect Host in redirects');

process.stdout.write('AlphaSat adapter Nginx host contract passed.\n');
