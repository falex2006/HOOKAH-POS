'use strict';
// Only the disposable QA child loads this module with --require. No production hook.
const fs = require('node:fs');
const assert = require('node:assert/strict');
assert.equal(process.env.NODE_ENV, 'test');
const target = new URL(process.env.DATABASE_URL);
assert.equal(target.hostname, '127.0.0.1');
assert.equal(target.port, '31931');
assert.match(target.pathname, /^\/audit_qa_[a-f0-9]{16}$/);
const OriginalDate = Date;
if (process.env.RESERVATION_QA_LEGACY_BASELINE === '1') {
  const path = require('node:path'), Module = require('node:module');
  const root = path.resolve(__dirname, '..'), compile = Module.prototype._compile;
  Module.prototype._compile = function (source, filename) {
    if ([path.join(root, 'server.js'), path.join(root, 'db.js')].includes(filename)) {
      source = fs.readFileSync(path.join(root, 'tmp/fix044-baseline', path.basename(filename)), 'utf8');
    }
    return compile.call(this, source, filename);
  };
}
const instant = () => {
  const value = fs.readFileSync(process.env.RESERVATION_QA_CLOCK_FILE, 'utf8').trim();
  assert.match(value, /^2026-10-\d{2}T\d{2}:\d{2}:00\.000Z$/);
  return value;
};
global.Date = class extends OriginalDate {
  constructor(...args) { super(...(args.length ? args : [instant()])); }
  static now() { return OriginalDate.parse(instant()); }
};
const { Client } = require('pg');
const query = Client.prototype.query;
Client.prototype.query = function (config, ...args) {
  const rewrite = text => {
    const stamp = `'${instant()}'::timestamptz`;
    return text.replace(/\b(?:now|transaction_timestamp|statement_timestamp|clock_timestamp)\s*\(\s*\)/gi, `(${stamp})`)
      .replace(/\bCURRENT_TIMESTAMP\b/gi, `(${stamp})`).replace(/\bCURRENT_DATE\b/gi, `(${stamp})::date`);
  };
  return query.call(this, typeof config === 'string' ? rewrite(config) : config?.text ? { ...config, text: rewrite(config.text) } : config, ...args);
};
