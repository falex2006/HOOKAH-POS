import { cpSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { publishedHtmlFiles, routeAliases, publishedHtmlPaths, localPreviewHtmlFiles } from './published-html-manifest.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cssRevision = '387';
const portalRevision = '438';
const lockRevision = '22';
const appRevision = '181';
const platformRevision = '6';
const platformCssRevision = '2';
const staffProfileRevision = '6';
const loginRevision = '98';
const authSmokeRevision = '3';
const authSmokeCssRevision = '2';
const staffAdminCardRevision = '11';
const payrollSchemeUiRevision = '1';
const purchaseDocumentValidationRevision = '1';
const brandRevision = '2';
const brandHead = `<!-- Hookah POS brand icons -->
<link rel="icon" href="/assets/brand/icons/favicon.ico?rev=${brandRevision}" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/assets/brand/icons/favicon-32.png?rev=${brandRevision}">
<link rel="icon" type="image/svg+xml" href="/assets/brand/icons/favicon.svg?rev=${brandRevision}">
<link rel="mask-icon" href="/assets/brand/icons/safari-pinned-tab.svg?rev=${brandRevision}" color="#171A20">
<link rel="apple-touch-icon" sizes="180x180" href="/assets/brand/icons/apple-touch-icon-180.png?rev=${brandRevision}">
<link rel="manifest" href="/assets/brand/manifest.webmanifest?rev=${brandRevision}">
<meta name="msapplication-TileImage" content="/assets/brand/icons/mstile-150.png?rev=${brandRevision}">
<meta name="theme-color" content="#171A20">
<meta property="og:image" content="/assets/brand/icons/og-image-1200x630.png?rev=${brandRevision}">
<!-- /Hookah POS brand icons -->`;

// SaaS-only work must not rewrite POS pages just to publish its own assets.
// Keep the full-project sync below for coordinated application releases.
if (process.argv.includes('--saas-only')) {
  const sources = ['platform.html', 'login.html'];
  const aliases = Object.entries(routeAliases).filter(([, source]) => sources.includes(source));
  for (const source of sources) cpSync(resolve(root, source), resolve(root, 'dist', source));
  for (const [alias, source] of aliases) {
    mkdirSync(resolve(root, 'dist', alias, '..'), { recursive: true });
    cpSync(resolve(root, source), resolve(root, 'dist', alias));
  }
  const paths = [...sources.map((name) => resolve(root, name)), ...sources.map((name) => resolve(root, 'dist', name)), ...aliases.map(([alias]) => resolve(root, 'dist', alias))];
  for (const path of paths) {
    const html = readFileSync(path, 'utf8')
      .replace(/style\.css\?rev=\d+/g, `style.css?rev=${cssRevision}`)
      .replace(/platform\.css\?rev=\d+/g, `platform.css?rev=${platformCssRevision}`)
      .replace(/platform\.js\?rev=\d+/g, `platform.js?rev=${platformRevision}`)
      .replace(/login\.js\?rev=\d+/g, `login.js?rev=${loginRevision}`);
    writeFileSync(path, html);
  }
  cpSync(resolve(root, 'platform.js'), resolve(root, 'dist', 'platform.js'));
  cpSync(resolve(root, 'platform.css'), resolve(root, 'dist', 'platform.css'));
  cpSync(resolve(root, 'login.js'), resolve(root, 'dist', 'login.js'));
  console.log('Synced SaaS platform and shared login assets only; POS pages were not visited.');
  process.exit(0);
}

// Keep flat pages and directory-index aliases in dist aligned with their source
// templates. Static hosts commonly resolve /login/ to dist/login/index.html,
// so every public route alias must receive the same safe initial markup.
for (const name of readdirSync(root).filter(entry => entry.endsWith('.html'))) {
  if (!publishedHtmlFiles.includes(name) && !localPreviewHtmlFiles.includes(name)) throw new Error(`Undeclared HTML template: ${name}`);
}
for (const name of publishedHtmlFiles) {
  cpSync(resolve(root, name), resolve(root, 'dist', name));
}
for (const [alias, source] of Object.entries(routeAliases)) {
  mkdirSync(resolve(root, 'dist', alias, '..'), { recursive: true });
  cpSync(resolve(root, source), resolve(root, 'dist', alias));
}
const htmlFiles = [
  ...publishedHtmlFiles.map(name => resolve(root, name)),
  ...publishedHtmlPaths.map(name => resolve(root, 'dist', name)),
];

for (const path of htmlFiles) {
  const html = readFileSync(path, 'utf8')
    .replace(/<!-- Hookah POS brand icons -->[\s\S]*?<!-- \/Hookah POS brand icons -->\s*/g, '')
    .replace('</head>', `${brandHead}</head>`)
    .replace(/(\/assets\/brand\/hookah-pos-[a-z-]+\.svg)(?:\?rev=\d+)?/g, `$1?rev=${brandRevision}`)
    .replace(/(<picture class="hookah-pos-brand">)([\s\S]*?)(<\/picture>)/g, (_, open, content, close) => {
      const animated = content.replace(/(<img src=")\/assets\/brand\/hookah-pos-lockup(?:-animated)?\.svg\?rev=\d+/, `$1/assets/brand/hookah-pos-lockup-animated.svg?rev=${brandRevision}`);
      const withReducedMotion = animated.includes('prefers-reduced-motion') ? animated : animated.replace('<img ', `<source media="(prefers-reduced-motion:reduce)" srcset="/assets/brand/hookah-pos-lockup.svg?rev=${brandRevision}"><img `);
      return open + withReducedMotion + close;
    })
    .replace(/style\.css\?rev=\d+/g, `style.css?rev=${cssRevision}`)
    .replace(/platform\.css\?rev=\d+/g, `platform.css?rev=${platformCssRevision}`)
    .replace(/portal\.js\?rev=\d+/g, `portal.js?rev=${portalRevision}`)
    .replace(/lock\.js\?rev=\d+/g, `lock.js?rev=${lockRevision}`)
    .replace(/app\.js\?rev=\d+/g, `app.js?rev=${appRevision}`)
    .replace(/platform\.js\?rev=\d+/g, `platform.js?rev=${platformRevision}`)
    .replace(/(<script\s+src="\/?(?:portal|app)\.js\?rev=\d+"[^>]*>)/g,(tag,_,offset,html)=>html.slice(0,offset).includes('notification-center.js?rev=1')?tag:'<script src="/notification-center.js?rev=1"></script>'+tag)
    .replace(/staff-profile\.js\?rev=\d+/g, `staff-profile.js?rev=${staffProfileRevision}`)
    .replace(/login\.js\?rev=\d+/g, `login.js?rev=${loginRevision}`)
    .replace(/auth-smoke\.js\?rev=\d+/g, `auth-smoke.js?rev=${authSmokeRevision}`)
    .replace(/auth-smoke\.css\?rev=\d+/g, `auth-smoke.css?rev=${authSmokeCssRevision}`)
    .replace(/staff-admin-card\.js\?rev=\d+/g, `staff-admin-card.js?rev=${staffAdminCardRevision}`);`r`n    .replace(/payroll-scheme-ui\\.js\\?rev=\\d+/g, `payroll-scheme-ui.js?rev=${payrollSchemeUiRevision}`);
  const versionedHtml = html.replace(/purchase-document-validation\.js\?rev=\d+/g, `purchase-document-validation.js?rev=${purchaseDocumentValidationRevision}`);
  writeFileSync(path, versionedHtml);
}
cpSync(resolve(root, 'notification-center.js'), resolve(root, 'dist', 'notification-center.js'));
cpSync(resolve(root, 'portal.js'), resolve(root, 'dist', 'portal.js'));
cpSync(resolve(root, 'lock.js'), resolve(root, 'dist', 'lock.js'));
cpSync(resolve(root, 'app.js'), resolve(root, 'dist', 'app.js'));
cpSync(resolve(root, 'platform.js'), resolve(root, 'dist', 'platform.js'));
cpSync(resolve(root, 'platform.css'), resolve(root, 'dist', 'platform.css'));
cpSync(resolve(root, 'staff-telegram-link.js'), resolve(root, 'dist', 'staff-telegram-link.js'));
cpSync(resolve(root, 'vip-deposit-ui.js'), resolve(root, 'dist', 'vip-deposit-ui.js'));
cpSync(resolve(root, 'staff-profile.js'), resolve(root, 'dist', 'staff-profile.js'));
cpSync(resolve(root, 'login.js'), resolve(root, 'dist', 'login.js'));
cpSync(resolve(root, 'style.css'), resolve(root, 'dist', 'style.css'));
for (const name of ['auth-smoke.js', 'auth-smoke.css']) cpSync(resolve(root, name), resolve(root, 'dist', name));
for (const name of ['login-smoke-ambient.png', 'login-smoke-ambient.mp4']) cpSync(resolve(root, 'assets', name), resolve(root, 'dist', 'assets', name));
cpSync(resolve(root, 'staff-admin-card.js'), resolve(root, 'dist', 'staff-admin-card.js'));
cpSync(resolve(root, 'payroll-scheme-ui.js'), resolve(root, 'dist', 'payroll-scheme-ui.js'));
cpSync(resolve(root, 'purchase-document-validation.js'), resolve(root, 'dist', 'purchase-document-validation.js'));
cpSync(resolve(root, 'assets', 'tabler-icons.svg'), resolve(root, 'dist', 'assets', 'tabler-icons.svg'));
cpSync(resolve(root, 'assets', 'login-background.mp4'), resolve(root, 'dist', 'assets', 'login-background.mp4'));
cpSync(resolve(root, 'assets', 'brand'), resolve(root, 'dist', 'assets', 'brand'), { recursive: true });
console.log(`Synced app.js rev=${appRevision}, portal.js rev=${portalRevision}, lock.js rev=${lockRevision}, staff-profile.js rev=${staffProfileRevision}, login.js rev=${loginRevision}, staff-admin-card.js rev=${staffAdminCardRevision}, style.css rev=${cssRevision} across ${htmlFiles.length} source and dist routes.`);


