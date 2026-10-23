import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const portal = fs.readFileSync(new URL('../portal.js', import.meta.url), 'utf8');
const distPortal = fs.readFileSync(new URL('../dist/portal.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const renderClients = portal.slice(portal.indexOf('function renderClients()'), portal.indexOf('function renderReservations()'));
const distRenderClients = distPortal.slice(distPortal.indexOf('function renderClients()'), distPortal.indexOf('function renderReservations()'));
const renderLoyalty = portal.slice(portal.indexOf('function renderLoyalty()'), portal.indexOf('function renderClients()'));

assert.match(renderClients, /id="new-client" aria-controls="client-editor" aria-expanded="false"/,
  'new guest action must announce and control the hidden editor');
assert.match(renderClients, /id="client-editor" aria-labelledby="client-editor-title" hidden/,
  'the guest editor must start hidden so the guest list is primary');
assert.match(renderClients, /id="client-cancel"[^>]*aria-label="Закрыть карточку"[^>]*>Закрыть/,
  'the editor must provide an explicit close action');
assert.match(renderClients, /const openEditor = \(client, trigger = newClientButton\) => \{[\s\S]*?newClientButton\.setAttribute\('aria-expanded', 'true'\)[\s\S]*?client-name'\)\.focus/,
  'opening a guest editor must expose it, update aria state, and focus its first field');
assert.match(renderClients, /const closeEditor = \(\) => \{[\s\S]*?editor\.hidden = true[\s\S]*?newClientButton\.setAttribute\('aria-expanded', 'false'\)[\s\S]*?focusTarget\.focus/,
  'closing the editor must hide it, restore state, and return focus');
assert.match(renderClients, /Сохраните карточку гостя, чтобы \$\{\[\.\.\.\(canTopUpGuestWallet \? \['пополнять денежный счёт'\] : \[\]\), \.\.\.\(canAdjustGuestLoyalty \? \['корректировать бонусы'\] : \[\]\)\]/,
  'new guest receives a role-appropriate explanation before account operations become available');
assert.match(renderClients, /depositTopUpForm\.hidden = !canTopUpGuestWallet \|\| !hasSavedGuest/,
  'cash top-up stays hidden until a saved guest is selected');
assert.match(renderClients, /loyaltyForm\.hidden = !canAdjustGuestLoyalty \|\| !hasSavedGuest/,
  'bonus correction stays hidden until a saved guest is selected');
assert.match(renderClients, /guestAccountPrerequisite\.hidden = hasSavedGuest \|\| !canUseGuestAccount/,
  'the precondition is shown only to a permitted role before the guest has an ID');
assert.equal(renderClients.match(/syncGuestAccountTools\(\)/g)?.length, 2,
  'account operation availability is refreshed on editor fill and successful creation');
const clientAccountTools = renderClients.match(/const syncGuestAccountTools = \(\) => \{[\s\S]*?\n  \};/)?.[0];
const distClientAccountTools = distRenderClients.match(/const syncGuestAccountTools = \(\) => \{[\s\S]*?\n  \};/)?.[0];
assert.ok(clientAccountTools, 'account-operation visibility sync exists');
assert.equal(distClientAccountTools, clientAccountTools, 'source and published account-operation visibility stay in sync');
const verifyAccountAvailability = ({ canTopUpGuestWallet, canAdjustGuestLoyalty, guestId = '' }) => {
  const clientId = { value: guestId };
  const depositTopUpForm = { hidden: false };
  const loyaltyForm = { hidden: false };
  const guestAccountPrerequisite = { hidden: false };
  const context = { canTopUpGuestWallet, canAdjustGuestLoyalty, canUseGuestAccount: canTopUpGuestWallet || canAdjustGuestLoyalty, depositTopUpForm, loyaltyForm, guestAccountPrerequisite, document: { querySelector: (selector) => selector === '#client-id' ? clientId : null } };
  vm.runInNewContext(`${clientAccountTools}\nglobalThis.sync = syncGuestAccountTools;`, context);
  context.sync();
  return { clientId, depositTopUpForm, loyaltyForm, guestAccountPrerequisite, sync: context.sync };
};
const beforeSave = verifyAccountAvailability({ canTopUpGuestWallet: true, canAdjustGuestLoyalty: true });
assert.equal(beforeSave.depositTopUpForm.hidden, true); assert.equal(beforeSave.loyaltyForm.hidden, true); assert.equal(beforeSave.guestAccountPrerequisite.hidden, false);
beforeSave.clientId.value = 'saved-guest'; beforeSave.sync();
assert.equal(beforeSave.depositTopUpForm.hidden, false); assert.equal(beforeSave.loyaltyForm.hidden, false); assert.equal(beforeSave.guestAccountPrerequisite.hidden, true);
const walletOnly = verifyAccountAvailability({ canTopUpGuestWallet: true, canAdjustGuestLoyalty: false, guestId: 'saved-guest' });
assert.equal(walletOnly.depositTopUpForm.hidden, false); assert.equal(walletOnly.loyaltyForm.hidden, true);
const unauthorized = verifyAccountAvailability({ canTopUpGuestWallet: false, canAdjustGuestLoyalty: false });
assert.equal(unauthorized.depositTopUpForm.hidden, true); assert.equal(unauthorized.loyaltyForm.hidden, true); assert.equal(unauthorized.guestAccountPrerequisite.hidden, true);
assert.match(renderClients, /aria-controls="client-editor" aria-expanded="\$\{String\(Boolean/,
  'guest cards must expose their relationship to the editor and selected state');
assert.match(css, /body\[data-page="clients"\] #client-editor\[hidden\]\{display:none!important\}/);
assert.match(css, /body\[data-page="clients"\] \.content-grid\{grid-template-columns:minmax\(0,1fr\)/,
  'initial desktop view must give the guest list the full width');
assert.match(css, /body\[data-page="clients"\] \.content-grid\.has-client-editor\{grid-template-columns:minmax\(0,1fr\) minmax\(340px,390px\)\}/,
  'desktop editor may use a side-by-side layout only after an explicit selection');
assert.match(css, /body\[data-page="clients"\] \.content-grid>#client-editor\{order:-1\}/,
  'when open on narrow screens, the editor must precede the list');
assert.match(css, /body\[data-page="clients"\] \.client-card-head\{[^}]*flex-direction:column[^}]*min-width:0[^}]*width:100%/,
  'narrow guest cards must stack their person/actions instead of squeezing identity text beside controls');
assert.match(css, /body\[data-page="clients"\] \.client-card-person>div\{[^}]*min-width:0[^}]*overflow-wrap:anywhere[^}]*word-break:normal/,
  'guest name and phone text must wrap as words when narrow, not one character per line');
assert.match(css, /@media\(max-width:700px\)\{\.velora-theme \.client-groups\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/,
  'mobile guest segments must expose all statuses in a wrapping grid rather than hide them in horizontal scrolling');
assert.match(renderLoyalty, /id="loyalty-program-filter"[\s\S]*?Включая архивные/,
  'managers need a direct filter for archived loyalty programs');
assert.match(renderLoyalty, /portalConfirm\('Архивировать программу\?'/,
  'archiving a loyalty program requires clear confirmation');
assert.match(renderLoyalty, /JSON\.stringify\(\{ active: !active \}\)/,
  'archive/restore must PATCH the active state rather than delete program history');
assert.match(renderLoyalty, /Восстановить/,
  'archived programs must expose an explicit restore action');
assert.match(portal, /includeArchived=true/,
  'the loyalty archive view must request inactive records explicitly');
assert.match(css, /\.loyalty-program\.is-archived\{opacity:/,
  'archived loyalty programs must be visibly distinct from active programs');

console.log('CLIENT/LOYALTY CONTRACT: PASS (guest editor accessibility, archive confirmation, and loyalty program restore path)');
