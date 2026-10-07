'use strict';

const moneyCents = (value) => Math.round(Number(value || 0) * 100);
const roundMoney = (value) => moneyCents(value) / 100;

function evaluateLoyaltyPricing({ subtotal, approvedDiscounts = [], groupPercent = 0, groupName = null, hasGroup = false, promotions = [], lines = [], now = new Date() }) {
  const base = roundMoney(Math.max(0, Number(subtotal) || 0));
  const manualAmount = Math.min(base, roundMoney(approvedDiscounts.reduce((sum, entry) => {
    const value = Math.max(0, Number(entry.value) || 0);
    return sum + roundMoney(entry.type === 'percent' ? base * Math.min(100, value) / 100 : entry.type === 'fixed' ? value : 0);
  }, 0)));
  const groupAmount = hasGroup ? Math.min(base, roundMoney(base * Math.min(100, Math.max(0, Number(groupPercent) || 0)) / 100)) : 0;
  const offers = [
    { source: 'manual', label: 'Согласованная ручная скидка', amount: manualAmount, eligibleBasis: base, reasonCode: manualAmount ? 'eligible' : 'no_approved_discount' },
    { source: 'guest_group', label: groupName || 'Скидка группы гостя', amount: groupAmount, eligibleBasis: base, reasonCode: hasGroup && groupAmount ? 'eligible' : 'no_group_discount' }
  ];
  const instant = new Date(now).getTime();
  const moneyLines = lines.map((line) => ({ ...line, amount: roundMoney(Math.max(0, Number(line.unitPrice) || 0) * Math.max(0, Number(line.quantity) || 0)) }));
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
    const included = moneyLines.filter((line) => includeProducts.has(String(line.productId)) || includeCategories.has(String(line.category || line.station || '')));
    const eligibleLines = included.filter((line) => !excludeProducts.has(String(line.productId)) && !excludeCategories.has(String(line.category || line.station || '')) && line.productActive !== false);
    const eligibleBasis = roundMoney(eligibleLines.reduce((sum, line) => sum + line.amount, 0));
    if (reasonCode === 'eligible' && !eligibleBasis) reasonCode = included.length ? 'excluded_or_inactive_items' : 'no_matching_items';
    const amount = !eligibleBasis ? 0 : Math.min(eligibleBasis, roundMoney(promo.benefitKind === 'percent' ? eligibleBasis * Number(promo.benefitValue) / 100 : Number(promo.benefitValue)));
    offers.push({ source: 'promotion', promotionId: promo.promotionId, version: Number(promo.version), label: promo.name, benefitKind: promo.benefitKind, benefitValue: Number(promo.benefitValue), priority: Number(promo.priority || 0), eligibleBasis, amount, reasonCode });
  }
  const candidates = offers.filter((offer) => offer.reasonCode === 'eligible' && offer.amount > 0);
  candidates.sort((a, b) => b.amount - a.amount
    || (a.source === 'promotion' && b.source === 'promotion' ? b.priority - a.priority : (a.source === 'promotion' ? -1 : b.source === 'promotion' ? 1 : a.source === 'guest_group' ? -1 : b.source === 'guest_group' ? 1 : 0))
    || String(a.promotionId || '').localeCompare(String(b.promotionId || '')));
  const winner = candidates[0] || null;
  for (const offer of offers) if (offer.reasonCode === 'eligible') offer.reasonCode = offer === winner ? 'selected' : 'better_offer_selected';
  return {
    subtotal: base,
    discount: winner?.amount || 0,
    net: roundMoney(Math.max(0, base - (winner?.amount || 0))),
    source: winner?.source || 'none',
    groupDiscount: groupAmount,
    groupDiscountBase: hasGroup ? base : null,
    groupDiscountAmount: winner?.source === 'guest_group' ? groupAmount : hasGroup ? 0 : null,
    selectedPromotion: winner?.source === 'promotion' ? { ...winner, name: winner.label } : null,
    offers
  };
}

module.exports = { evaluateLoyaltyPricing };
