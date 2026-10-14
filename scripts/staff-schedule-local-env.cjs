'use strict';
function isolatedEnvironment(c, fixtures, inherited = process.env) {
  const env = {};
  const allowed = new Set(['systemroot', 'windir', 'path', 'pathext', 'temp', 'tmp', 'comspec', 'localappdata', 'appdata', 'userprofile', 'programfiles', 'programfiles(x86)', 'programdata']);
  for (const [key, value] of Object.entries(inherited)) if (allowed.has(key.toLowerCase())) env[key] = value;
  return Object.assign(env, {
    HOST: '127.0.0.1', PORT: String(c.appPort), NODE_ENV: 'test', AUTH_REQUIRED: 'true', DEMO_MODE: 'false', SKIP_LOCAL_ENV: 'true',
    API_RATE_LIMIT: '10000', // Existing bounded app setting, for sequential local acceptance traffic only.
    DATABASE_URL: `postgresql://${encodeURIComponent(c.dbUser)}:${encodeURIComponent(c.dbPassword)}@127.0.0.1:${c.dbPort}/${c.database}`,
    STAFF_PASSPORT_KEY: c.appKey, SESSION_SECRET: c.appKey, VENUE_ID: fixtures.venues[0],
    SAAS_OWNER_EMAIL: 'schedule-platform@example.test', SAAS_OWNER_PASSWORD: c.appKey
  });
}
module.exports = { isolatedEnvironment };
