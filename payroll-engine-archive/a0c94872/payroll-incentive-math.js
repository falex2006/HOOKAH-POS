'use strict';

// Exact, persistence-free primitives shared by personal targets, team funds and
// margin incentives. Inputs are scenario facts; this module attests no source.
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const integer = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`invalid_${name}`);
  return BigInt(value);
};
const safe = (value) => {
  if (value < 0n || value > MAX) throw new RangeError('amount_exceeds_safe_integer_cents');
  return Number(value);
};
const rate = (value, name) => {
  const result = integer(value, name);
  if (result > 10000n) throw new RangeError(`invalid_${name}`);
  return result;
};
const rounded = (basis, rateBps) => (basis * rateBps + 5000n) / 10000n;

const calculateTargetIncentive = ({ basisCents, targetCents, baseRateBps, bonusRateBps, excessRatePolicy }) => {
  const basis = integer(basisCents, 'basis_cents');
  const target = integer(targetCents, 'target_cents');
  const baseRate = rate(baseRateBps, 'base_rate_bps');
  const bonusRate = rate(bonusRateBps, 'bonus_rate_bps');
  if (!['replace_base', 'add_to_base'].includes(excessRatePolicy)) throw new TypeError('excess_rate_policy_required');
  const below = basis < target ? basis : target;
  const excess = basis - below;
  const baseBasis = excessRatePolicy === 'replace_base' ? below : basis;
  const base = rounded(baseBasis, baseRate);
  const bonus = rounded(excess, bonusRate);
  return {
    basisCents, targetCents, baseRateBps, bonusRateBps, excessRatePolicy,
    roundingPolicy: 'component_half_up_v1',
    belowTargetCents: safe(below), excessCents: safe(excess),
    baseBasisCents: safe(baseBasis), baseCommissionCents: safe(base),
    excessCommissionCents: safe(bonus), commissionCents: safe(base + bonus)
  };
};

// Allocate a rounded fund exactly once. Stable code-unit ID order resolves ties;
// neither client ordering nor host locale may change a recipient's final cents.
const allocateIncentiveFund = (fundCents, recipients) => {
  const fund = integer(fundCents, 'fund_cents');
  if (!Array.isArray(recipients)) throw new TypeError('recipients_required');
  const ids = new Set();
  const rows = recipients.map((row) => {
    if (!row || typeof row.id !== 'string' || !row.id.trim() || ids.has(row.id)) throw new TypeError('invalid_recipient_id');
    ids.add(row.id);
    return { id: row.id, weight: integer(row.weight, 'recipient_weight') };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0n);
  if (fund > 0n && totalWeight === 0n) throw new RangeError('positive_fund_requires_recipient_weight');
  let assigned = 0n;
  for (const row of rows) {
    const numerator = fund * row.weight;
    row.amount = totalWeight ? numerator / totalWeight : 0n;
    row.remainder = totalWeight ? numerator % totalWeight : 0n;
    assigned += row.amount;
  }
  const ranked = rows.slice().sort((a, b) => a.remainder > b.remainder ? -1 : a.remainder < b.remainder ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  let residual = fund - assigned;
  for (const row of ranked) {
    if (!residual) break;
    row.amount += 1n;
    residual -= 1n;
  }
  if (residual) throw new RangeError('fund_allocation_failed');
  return rows.map((row) => ({ id: row.id, weight: safe(row.weight), amountCents: safe(row.amount) }));
};

module.exports = { calculateTargetIncentive, allocateIncentiveFund };
