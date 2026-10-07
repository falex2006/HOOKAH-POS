'use strict';

const pow10 = (scale) => 10n ** BigInt(scale);

function decimalParts(value) {
  const raw = String(value ?? 0).trim();
  const match = raw.match(/^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
  if (!match) return { units: 0n, scale: 0 };
  const sign = match[1] === '-' ? -1n : 1n;
  const fraction = match[3] || '';
  let scale = fraction.length - Number(match[4] || 0);
  let units = sign * BigInt(`${match[2]}${fraction}` || '0');
  if (scale < 0) { units *= pow10(-scale); scale = 0; }
  if (scale > 30) throw new RangeError('pricing_decimal_scale_unsupported');
  return { units, scale };
}

function roundHalfUp(numerator, denominator) {
  if (numerator < 0n) return -roundHalfUp(-numerator, denominator);
  return (2n * numerator + denominator) / (2n * denominator);
}

function toCents(value) {
  const { units, scale } = decimalParts(value);
  const cents = roundHalfUp(units * 100n, pow10(scale));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('pricing_amount_out_of_range');
  return Number(cents);
}

function percentOfCents(amountCents, percent) {
  const { units, scale } = decimalParts(percent);
  const value = roundHalfUp(BigInt(amountCents) * units, pow10(scale) * 100n);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('pricing_amount_out_of_range');
  return Number(value);
}

function lineOrderKey(line, index) {
  return String(line.orderItemId ?? line.id ?? `legacy-${String(index).padStart(12, '0')}`);
}

function reconcileLineGrossCents(subtotalCents, lines) {
  const values = lines.map((line, index) => {
    const quantity = decimalParts(line.quantity);
    const unitPrice = decimalParts(line.unitPrice);
    const scale = quantity.scale + unitPrice.scale;
    const numerator = quantity.units < 0n || unitPrice.units < 0n ? 0n : quantity.units * unitPrice.units * 100n;
    return { line, index, id: line.orderItemId ?? line.id ?? null, key: lineOrderKey(line, index), numerator, denominator: pow10(scale), scale };
  });
  const stableIds = values.map((item) => item.id).filter((id) => id !== null).map(String);
  if (new Set(stableIds).size !== stableIds.length) throw new Error('pricing_line_id_duplicate');
  const commonScale = values.reduce((max, item) => Math.max(max, item.scale), 0);
  let floorTotal = 0n;
  for (const item of values) {
    const exact = item.numerator * pow10(commonScale - item.scale) / pow10(commonScale);
    item.floorCents = Number(exact);
    item.remainder = item.numerator * pow10(commonScale - item.scale) % pow10(commonScale);
    floorTotal += exact;
  }
  const remainderCents = BigInt(subtotalCents) - floorTotal;
  if (remainderCents < 0n || remainderCents > BigInt(values.length)) throw new Error('pricing_line_subtotal_mismatch');
  const ranked = [...values].sort((a, b) => a.remainder === b.remainder ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.remainder > b.remainder ? -1 : 1);
  const pennyRecipients = new Set(ranked.slice(0, Number(remainderCents)).map((item) => item.index));
  return values.map((item) => ({
    ...item.line,
    orderItemId: item.id,
    grossCents: item.floorCents + Number(pennyRecipients.has(item.index)),
  })).sort((a, b) => { const left = lineOrderKey(a, 0); const right = lineOrderKey(b, 0); return left < right ? -1 : left > right ? 1 : 0; });
}

function subtotalFromLines(lines) {
  const values = lines.map((line) => {
    const quantity = decimalParts(line.quantity);
    const unitPrice = decimalParts(line.unitPrice);
    const scale = quantity.scale + unitPrice.scale;
    const numerator = quantity.units < 0n || unitPrice.units < 0n ? 0n : quantity.units * unitPrice.units * 100n;
    return { numerator, scale };
  });
  const commonScale = values.reduce((max, item) => Math.max(max, item.scale), 0);
  const total = values.reduce((sum, item) => sum + item.numerator * pow10(commonScale - item.scale), 0n);
  return fromCents(Number(roundHalfUp(total, pow10(commonScale))));
}

function allocateCents(amountCents, lines) {
  const totalWeight = lines.reduce((sum, line) => sum + line.grossCents, 0);
  if (!amountCents || !totalWeight) return new Map();
  const ranked = lines.map((line, index) => {
    const numerator = BigInt(amountCents) * BigInt(line.grossCents);
    return { line, index, floor: Number(numerator / BigInt(totalWeight)), remainder: numerator % BigInt(totalWeight), key: lineOrderKey(line, index) };
  });
  const allocated = new Map(ranked.map((item) => [item.index, item.floor]));
  const remaining = amountCents - ranked.reduce((sum, item) => sum + item.floor, 0);
  ranked.sort((a, b) => a.remainder === b.remainder ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.remainder > b.remainder ? -1 : 1);
  for (const item of ranked.slice(0, remaining)) allocated.set(item.index, allocated.get(item.index) + 1);
  return allocated;
}

const fromCents = (value) => value / 100;
const stableId = (line) => line.orderItemId ?? line.id ?? null;

function evaluateLoyaltyPricing({ subtotal, approvedDiscounts = [], groupPercent = 0, groupName = null, hasGroup = false, promotions = [], lines = [], now = new Date() }) {
  const baseCents = Math.max(0, toCents(subtotal));
  const base = fromCents(baseCents);
  const reconciledLines = lines.length ? reconcileLineGrossCents(baseCents, lines) : [];
  const manualCents = Math.min(baseCents, approvedDiscounts.reduce((sum, entry) => {
    const valueCents = Math.max(0, toCents(entry.value));
    return sum + (entry.type === 'percent' ? percentOfCents(baseCents, Math.max(0, Math.min(100, Number(entry.value) || 0))) : entry.type === 'fixed' ? valueCents : 0);
  }, 0));
  const groupCents = hasGroup ? Math.min(baseCents, Math.max(0, percentOfCents(baseCents, Math.min(100, Math.max(0, Number(groupPercent) || 0))))) : 0;
  const offers = [
    { source: 'manual', label: 'Согласованная ручная скидка', amount: fromCents(manualCents), amountCents: manualCents, eligibleBasis: base, eligibleBasisCents: baseCents, reasonCode: manualCents ? 'eligible' : 'no_approved_discount' },
    { source: 'guest_group', label: groupName || 'Скидка группы гостя', amount: fromCents(groupCents), amountCents: groupCents, eligibleBasis: base, eligibleBasisCents: baseCents, reasonCode: hasGroup && groupCents ? 'eligible' : 'no_group_discount' }
  ];
  const offerLines = new Map([[offers[0], reconciledLines], [offers[1], reconciledLines]]);
  const instant = new Date(now).getTime();
  for (const promo of promotions) {
    let reasonCode = 'eligible';
    const start = new Date(promo.startsAt).getTime(); const end = new Date(promo.endsAt).getTime();
    if (promo.status !== 'active') reasonCode = promo.status === 'archived' ? 'archived' : 'draft';
    else if (!Number.isFinite(start) || instant < start) reasonCode = 'not_started';
    else if (!Number.isFinite(end) || instant >= end) reasonCode = 'expired';
    const includeProducts = new Set((promo.includeProductIds || []).map(String));
    const excludeProducts = new Set((promo.excludeProductIds || []).map(String));
    const includeCategories = new Set(promo.includeCategories || []);
    const excludeCategories = new Set(promo.excludeCategories || []);
    const included = reconciledLines.filter((line) => includeProducts.has(String(line.productId)) || includeCategories.has(String(line.category || line.station || '')));
    const eligibleLines = included.filter((line) => !excludeProducts.has(String(line.productId)) && !excludeCategories.has(String(line.category || line.station || '')) && line.productActive !== false);
    const eligibleBasisCents = eligibleLines.reduce((sum, line) => sum + line.grossCents, 0);
    if (reasonCode === 'eligible' && !eligibleBasisCents) reasonCode = included.length ? 'excluded_or_inactive_items' : 'no_matching_items';
    const benefitValue = Number(promo.benefitValue) || 0;
    const rawCents = promo.benefitKind === 'percent' ? percentOfCents(eligibleBasisCents, Math.max(0, Math.min(100, benefitValue))) : Math.max(0, toCents(benefitValue));
    const amountCents = !eligibleBasisCents ? 0 : Math.min(eligibleBasisCents, rawCents);
    const offer = { source: 'promotion', promotionId: promo.promotionId, version: Number(promo.version), label: promo.name, benefitKind: promo.benefitKind, benefitValue, priority: Number(promo.priority || 0), eligibleBasis: fromCents(eligibleBasisCents), eligibleBasisCents, amount: fromCents(amountCents), amountCents, reasonCode };
    offers.push(offer);
    offerLines.set(offer, eligibleLines);
  }
  const candidates = offers.filter((offer) => offer.reasonCode === 'eligible' && offer.amountCents > 0);
  candidates.sort((a, b) => b.amountCents - a.amountCents
    || (a.source === 'promotion' && b.source === 'promotion' ? b.priority - a.priority : (a.source === 'promotion' ? -1 : b.source === 'promotion' ? 1 : a.source === 'guest_group' ? -1 : b.source === 'guest_group' ? 1 : 0))
    || (String(a.promotionId || '') < String(b.promotionId || '') ? -1 : String(a.promotionId || '') > String(b.promotionId || '') ? 1 : 0));
  const winner = candidates[0] || null;
  for (const offer of offers) if (offer.reasonCode === 'eligible') offer.reasonCode = offer === winner ? 'selected' : 'better_offer_selected';
  const winnerLines = winner ? offerLines.get(winner) || [] : [];
  const allocation = allocateCents(winner?.amountCents || 0, winnerLines);
  const eligibleIndexes = new Set(winnerLines.map((line) => reconciledLines.indexOf(line)));
  const lineAllocations = reconciledLines.map((line, index) => {
    const discountCents = allocation.get(winnerLines.indexOf(line)) || 0;
    const itemId = stableId(line);
    return { ...(itemId ? { orderItemId: itemId } : {}), gross: fromCents(line.grossCents), grossCents: line.grossCents, eligibleForSelectedOffer: Boolean(winner && eligibleIndexes.has(index)), discount: fromCents(discountCents), discountCents, net: fromCents(line.grossCents - discountCents), netCents: line.grossCents - discountCents };
  });
  for (const offer of offers) offer.eligibleItemIds = (offerLines.get(offer) || []).map(stableId).filter((id) => id !== null).sort((a, b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
  const selectedPromotion = winner?.source === 'promotion' ? { ...winner, name: winner.label } : null;
  return {
    subtotal: base,
    discount: fromCents(winner?.amountCents || 0),
    net: fromCents(baseCents - (winner?.amountCents || 0)),
    source: winner?.source || 'none',
    groupDiscount: fromCents(groupCents),
    groupDiscountBase: hasGroup ? base : null,
    groupDiscountAmount: winner?.source === 'guest_group' ? fromCents(groupCents) : hasGroup ? 0 : null,
    selectedPromotion,
    offers,
    lineAllocations
  };
}

module.exports = { evaluateLoyaltyPricing, subtotalFromLines };
