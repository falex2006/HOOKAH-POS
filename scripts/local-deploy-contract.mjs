import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const deploy = read('deploy-vps.sh');
const migrate = read('migrate-vps.sh');
const compose = read('docker-compose.yml');
const envExample = read('.env.example');
const https = read('nginx/https.conf.example');
const server = read('server.js');
const postDeploy = read('post-deploy-acceptance.sh');
const backup = read('backup-postgres.sh');
const gitignore = read('.gitignore');
const dockerfile = read('Dockerfile');

for (const script of [deploy, migrate]) {
  assert.match(script, /docker compose version/, 'deployment scripts must require Compose plugin');
}
for (const secret of ['POSTGRES_PASSWORD', 'DEMO_ADMIN_PASSWORD', 'DEMO_OWNER_PASSWORD', 'DEMO_STAFF_PASSWORD', 'STAFF_PASSPORT_KEY', 'SAAS_OWNER_PASSWORD']) {
  assert.match(deploy, new RegExp(`\\b${secret}\\b`), `${secret} must be checked before deployment`);
}
assert.match(deploy, /SAAS_OWNER_EMAIL is required/);
for (const secret of ['STAFF_PASSPORT_KEY', 'SAAS_OWNER_EMAIL', 'SAAS_OWNER_PASSWORD']) {
  assert.ok(compose.split(/\r?\n/).some(line => line.trim().startsWith(`${secret}:`) && line.includes('${' + secret + ':-')), `${secret} must be forwarded to the CRM container`);
}
assert.match(deploy, /\*@example\.com/);
assert.match(deploy, /replace-with|replace-\*/, 'replace placeholders must be rejected');
assert.match(deploy, /AUTH_REQUIRED=true/);
assert.match(deploy, /allow_http_deploy_once="\$\{ALLOW_HTTP_DEPLOY_ONCE:-\}"[\s\S]*?unset ALLOW_HTTP_DEPLOY_ONCE/);
assert.match(deploy, /skip_menu_seed_once="\$\{SKIP_MENU_SEED_ONCE:-\}"[\s\S]*?unset SKIP_MENU_SEED_ONCE/);
assert.match(deploy, /SKIP_MENU_SEED_ONCE must be true when provided/);
assert.match(deploy, /if \[ "\$skip_menu_seed_once" = 'true' \]; then[\s\S]*?Skipping menu seed for this explicitly scoped release[\s\S]*?else[\s\S]*?npm run db:seed-menu[\s\S]*?fi/);
assert.ok(deploy.indexOf('skip_menu_seed_once=') < deploy.indexOf('. ./.env'), 'one-time menu seed opt-out must be captured before loading persistent environment');
assert.ok(deploy.indexOf('SKIP_MENU_SEED_ONCE must be true') < deploy.indexOf('BACKUP_DIR='), 'invalid one-time menu seed opt-out must fail before backup or deployment changes');
assert.match(deploy, /COOKIE_SECURE=true, or explicitly invoke this release once with ALLOW_HTTP_DEPLOY_ONCE=true/);
assert.match(deploy, /COOKIE_SECURE=false/);
assert.match(deploy, /\[ "\$allow_http_deploy_once" = 'true' \]/);
assert.ok(deploy.indexOf('allow_http_deploy_once=') < deploy.indexOf('. ./.env'), 'one-time HTTP opt-in must be captured before loading persistent environment');
assert.ok(deploy.indexOf('COOKIE_SECURE=false requires') < deploy.indexOf('BACKUP_DIR='), 'HTTP opt-in gate must run before backup or deployment changes');
assert.match(deploy, /WARNING: deploying with non-secure session cookies over HTTP by explicit configuration/);
assert.match(migrate, /psql --single-transaction -v ON_ERROR_STOP=1/, 'each VPS migration file must commit or roll back atomically');
assert.match(migrate, /export LC_ALL=C/, 'VPS migration order must match the Node migration runner');
assert.match(deploy, /git rev-parse --verify HEAD/, 'deployments must identify a committed release');
assert.match(deploy, /release_branch=.*git symbolic-ref --short HEAD[\s\S]*?\[ \"\$release_branch\" = 'main' \]/, 'deployments must come from canonical main');
assert.match(deploy, /git status --porcelain --untracked-files=all/, 'dirty and untracked release files must block deployment');
assert.match(deploy, /flock 8/, 'parallel deployments must be serialized');
assert.match(deploy, /\/var\/lock\/\$project_name-deploy\.lock/, 'deploy lock must be stable across checkouts of one Compose project');
assert.match(deploy, /config_hash=.*openssl dgst -sha256 -hmac/, 'release identity must include a private-key HMAC of resolved Compose configuration');
assert.match(deploy, /release_fingerprint=.*sha256sum/, 'release fingerprints must not truncate commit or config hashes');
assert.match(deploy, /docker inspect --format/, 'in-progress retries must verify the running container release label');
assert.match(compose, /CRM_RELEASE_ID:/, 'Compose must pass the release id into the service');
assert.match(compose, /name: \$\{COMPOSE_PROJECT_NAME:-hookah-pos\}/, 'new local Compose projects must use the HOOKAH POS name by default');
assert.match(compose, /name: \$\{POSTGRES_VOLUME_NAME:-territory-crm_pgdata\}/, 'the renamed default project must keep the existing PostgreSQL volume name');
for (const secret of ['DEMO_ADMIN_PASSWORD', 'DEMO_OWNER_PASSWORD', 'DEMO_STAFF_PASSWORD']) {
  assert.ok(compose.split(/\r?\n/).some(line => line.trim() === `${secret}: \${${secret}:-}`), `${secret} must default to empty so direct Compose startup cannot expose a known demo credential`);
  assert.match(envExample, new RegExp(`^${secret}\\s*=\\s*$`, 'm'), `${secret} in the sample environment must be blank so it cannot enable a known password`);
}
assert.match(server, /const demoAccounts = \[[\s\S]*?\]\.filter\(\(account\) => Boolean\(account\.password\)\)/, 'demo users without configured passwords must never be login candidates');
assert.match(server, /DEMO_OWNER_PASSWORD \|\| \(process\.env\.AUTH_REQUIRED === 'true' \? '' : 'demo'\)/, 'protected runtime must not fall back to owner/demo');
assert.match(server, /DEMO_STAFF_PASSWORD \|\| \(process\.env\.AUTH_REQUIRED === 'true' \? '' : 'demo'\)/, 'protected runtime must not fall back to staff/demo');
assert.match(compose, /com\.hookahpos\.release-id:/, 'Compose container must expose the release id label');
assert.match(dockerfile, /LABEL com\.hookahpos\.release-id=\$CRM_RELEASE_ID/, 'built image must identify its release');
const dockerFiles = new Set([...dockerfile.matchAll(/^COPY (.+) \.\/$/gm)].flatMap(match => match[1].split(/\s+/)));
const runtimeModules = new Set();
const visitRuntimeModule = moduleName => {
  const moduleFile = moduleName.endsWith('.js') ? moduleName : `${moduleName}.js`;
  if (runtimeModules.has(moduleFile)) return;
  const source = read(moduleFile);
  runtimeModules.add(moduleFile);
  for (const [, dependency] of source.matchAll(/require\(['"]\.\/([^'"]+)['"]\)/g)) visitRuntimeModule(dependency);
};
visitRuntimeModule('server');
for (const moduleFile of runtimeModules) {
  assert.ok(dockerFiles.has(moduleFile), `reachable server runtime module ${moduleFile} must be copied into the CRM image`);
}
assert.match(deploy, /state_dir="\/var\/lib\/territory-crm\/\$project_name"/, 'release state must be shared across checkouts');
assert.match(deploy, /backup_dir="\/var\/backups\/territory-crm\/\$project_name"/, 'release backups must be shared across checkouts');
assert.match(deploy, /openssl dgst -sha256 -hmac/, 'resolved config fingerprints must not expose secrets to offline guessing');
assert.match(deploy, /fingerprint_key" =~ \^\[A-Fa-f0-9\]\{64\}\$/, 'corrupt release fingerprint keys must fail closed');
assert.match(deploy, /deployed\|%s\|%s/, 'release status must retain its backup label');
assert.match(deploy, /in-progress\|%s\|%s/, 'an interrupted attempt must retain its own backup label');
assert.match(deploy, /recovery-\$\(date -u \+%Y%m%dT%H%M%S%N\)/, 'a new recovery attempt must receive a fresh backup while its retry keeps the persisted label');
assert.match(deploy, /already deployed and healthy; skipping duplicate deployment/, 'a healthy identical release must be idempotent');
assert.match(deploy, /BACKUP_LABEL="\$backup_label" \.\/backup-postgres\.sh/, 'each new release attempt must create or reuse its matching pre-release backup');
assert.ok(deploy.indexOf("printf 'in-progress|") < deploy.indexOf('BACKUP_LABEL="$backup_label"'), 'the attempt and backup label must be persisted before writing the snapshot');
assert.ok(deploy.indexOf('BACKUP_LABEL=') < deploy.indexOf('$COMPOSE pull'), 'the database backup must be verified before updating images');
assert.match(deploy, /\$COMPOSE pull db nginx/, 'pull only published infrastructure images; the CRM image is built from source');
assert.match(deploy, /\$COMPOSE build --pull crm/, 'build the CRM service from the checked-out release');
assert.match(backup, /if \[ -e "\$file" \]/, 'repeated releases must reuse a verified backup instead of creating duplicates');
assert.match(backup, /gzip -t "\$file"/, 'a reused backup must be integrity checked');
assert.match(backup, /flock 9/, 'parallel backup attempts must be serialized');
assert.match(backup, /umask 077/, 'temporary dumps must not be world-readable');
assert.match(backup, /tmp_file="\$file\.tmp\.\$\$"/, 'incomplete dumps must stay outside the final backup path');
assert.match(backup, /mv "\$tmp_file" "\$file"/, 'only verified dumps are promoted to final backups');
assert.match(gitignore, /\/backups\//);
assert.match(compose, /healthcheck:/);
assert.doesNotMatch(compose, /ports:\s*\n\s*-\s*['"]?5432:/, 'PostgreSQL must not be published publicly');
assert.match(https, /listen 443 ssl http2/);
assert.match(https, /return 301 https:\/\/\$host\$request_uri/);
assert.match(https, /ssl_certificate_key/);
assert.match(https, /Strict-Transport-Security/);
assert.match(envExample, /STAFF_PASSPORT_KEY=replace-/);
assert.match(envExample, /SAAS_OWNER_EMAIL=platform-owner@example\.com/);
assert.match(server, /platform-owner@example\.com/);
assert.match(server, /configuredApiRateLimit >= 30 && configuredApiRateLimit <= 10000[\s\S]*:\s*180;/, 'API rate limit remains 180 by default and only accepts a bounded operational override');
assert.doesNotMatch(server, /alphasat72@gmail\.com/);
assert.match(postDeploy, /jq -n --arg username/);
const trackedEnv = spawnSync('git', ['ls-files', '--error-unmatch', '.env'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
assert.notEqual(trackedEnv.status, 0, 'real .env must stay out of the repository; an ignored local .env may exist for development');

console.log('LOCAL DEPLOY CONTRACT: PASS (preflight, secrets, healthcheck and HTTPS template)');
