# Payroll product to department mapping

**Status:** owner-approved design boundary; additive migration and conditional candidate-source/readiness adapter implemented locally. Owner revision API/editor and end-to-end browser acceptance remain incomplete. This contract does not make department attribution a POS fact and does not enable official payroll calculations, snapshots, runs, entries, or expenses.

## Purpose and source boundary

Payroll rules can use a department for employee department-day caps, team pools, and item rules. The POS pricing snapshot currently preserves an immutable `productId`, product name, category text, and station, but no stable payroll department. Current product/category records and `order_items.station` may change and do not prove a past payroll classification.

The payroll owner may maintain an explicit classification `product_id → payroll department`. This is an owner assertion for payroll only. It does not classify POS/Finance revenue, select commission eligibility, provide cost of goods, or define an employee's HR/shift department. The classifier never changes an amount or a protected ledger.

## Revision rules

- Every revision is a complete immutable mapping snapshot with venue, revision number, parent revision, reason, idempotency key, canonical payload SHA-256, row count, owner identity/name, database timestamp, and effective boundary.
- Each row stores stable product UUID, department code and name snapshots, and inclusive effective dates. A product may have gaps but never overlapping ranges within one revision. Missing and ambiguous matches block department coverage.
- A normal owner save takes effect at the next venue-local calendar day. The server derives the boundary from the saved venue timezone; the caller cannot backdate a normal revision. Each full snapshot preserves unchanged earlier intervals so source can classify old sale dates under that revision.
- A retroactive revision is a distinct owner action. It requires an explicit attestation naming the payroll mapping action and a bounded reason. It creates a new revision and never edits a prior revision or an already saved payroll snapshot.
- The API verifies newly assigned product IDs against the server-derived venue. Department codes and names are payroll-owned, owner-authored snapshot values, not foreign IDs or POS catalog departments. Historical reads use only frozen rows and never join the current catalog to infer old assignments.
- Repeating the same idempotency key and payload returns the same revision. Reusing the key with a different payload or stale parent fails. Concurrent revision creation is serialized per venue.

## Candidate source behavior

When a saved mode/configuration depends on departments, the owner-only sourced preview resolves recognized sale lines using the immutable `productId` from the POS pricing snapshot and the frozen sale's recognized local date. It pins the selected mapping revision, reports per-line department and coverage, and binds both the mapping revision and recognition manifest into the SHA-256 watermark. It does not recalculate recognized money.

Refund lines inherit the department of their original sale line, even when the refund is recognized later and after a mapping change. Refund amount, commission base, and adjustment policy remain separate source decisions. A missing original sale line, product ID, or mapping makes the department source incomplete; the current mapping and refund date are not fallback inputs.

If the selected saved configuration does not require department attribution, the source is `not_required`, not zero and not verified. Dependency detection must include all modes, role parameters, personal overrides, caps, item rules, and team settings resolved for the period.

Even with complete department coverage, the envelope remains candidate-only until all other calculation facts and financial decisions are ready. `calculatorInput` stays null; no calculation run, snapshot, payroll entry, or expense is written.

## UI/API/permission contract

| Action | Endpoint | Permission | Result |
|---|---|---|---|
| Read current mapping and recent revision history | `GET /api/payroll/product-department-mappings` | Active venue owner, repeated by the service against PostgreSQL | Mapping snapshots, current revision ID/number, watermark, and owner-readable history |
| Read an exact immutable revision | `GET /api/payroll/product-department-mappings/revisions/:revisionId` | Active venue owner | Frozen revision header and full mapping rows |
| Save normal full mapping | `POST /api/payroll/product-department-mappings/revisions` | Active venue owner + same-origin mutation check | New revision effective next venue-local day; concurrent/stale parent is rejected |
| Attest a retroactive full mapping | `POST /api/payroll/product-department-mappings/retroactive-revisions` | Active venue owner + same-origin mutation check + explicit confirmation and reason | New historical assertion revision with separate lineage and audit fields |

Both write requests use `expectedRevisionId` (the current revision ID or `null` for the first revision), `idempotencyKey`, `reason`, and the full snapshot `mappings`. Normal mapping rows contain `productId`, `departmentCode`, and `departmentName`; the server supplies product-name snapshots from the venue catalog. The retroactive request additionally carries `effectiveFrom`, `retroactiveReason`, and the exact `ownerAttestation: { confirmed: true, action: "retroactive_payroll_product_department_mapping" }`. The server does not trust a client-supplied product name.

The payroll screen explains that this is a payroll-only classification, displays the effective boundary and revision history, and requires an explicit second confirmation for retroactive changes. Managers and other roles cannot read or write these mappings.

## Protected boundaries

The feature does not edit `orders`, `order_items`, `products`, `product_categories`, pricing snapshots, sale/refund event producers, payment/refund tenders, loyalty, shift cash, `payroll_entries`, or expenses. It does not backfill old POS snapshots or mutate any existing mapping revision. Department mapping must not be described as an immutable POS department fact.

## Acceptance evidence

- Migration replay twice; immutable revision/row guards; count and digest validation; owner-only insert enforcement; service-level same-venue product checks; tenant-scoped revision behavior; stale-parent race rejection.
- Normal save boundary follows venue timezone including midnight/DST; retroactive save requires its own endpoint, attestation, and reason. Missing or invalid attestation fails closed.
- Full-snapshot revisions preserve their previous historical intervals and reproduce old candidates by pinned revision; current catalog rename/archive/deletion cannot rewrite the saved mapping snapshots.
- Exact mapping coverage includes every recognized sale line, with known zero only when the full line manifest is covered. Unknown product ID, legacy line, missing mapping, overlap, duplicate/missing event, and cross-tenant input block.
- Refund after a mapping change uses the original sale's date and mapping revision. Department classification does not change recognized sale/refund sums or commission base.
- Owner UI → API → PostgreSQL save → reload/readback works; manager and adjacent venue are denied. Read-only source preview creates no run/entry/expense and leaves protected ledgers unchanged.
