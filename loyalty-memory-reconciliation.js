'use strict';

const amount = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const localDateKey = (value, timeZone) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
};

const groupSum = (records, keyOf, valueOf) => {
  const result = {};
  for (const record of records) {
    const key = keyOf(record);
    const value = amount(valueOf(record));
    if (!key || value === null) continue;
    result[key] = (result[key] || 0) + value;
  }
  return result;
};

const totalWhenComplete = (records, valueOf) => {
  let total = 0;
  for (const record of records) {
    const value = amount(valueOf(record));
    if (value === null) return null;
    total += value;
  }
  return total;
};

function buildMemoryPeriodBusiness({ venueId, timeZone, from, to, orders = [], guests = [], reservations = [] }) {
  const inPeriod = (value) => {
    const key = localDateKey(value, timeZone);
    return Boolean(key && key >= from && key <= to);
  };
  const venueOrders = orders.filter((order) => order.venueId === venueId);
  const closedOrders = venueOrders.filter((order) => order.status === 'closed' && inPeriod(order.closedAt));
  const closedOrdersWithoutClosureDate = venueOrders.filter((order) => order.status === 'closed' && !localDateKey(order.closedAt, timeZone)).length;
  const itemGross = (order) => (order.items || []).reduce((sum, item) => {
    const price = amount(item.unitPrice ?? item.price);
    const quantity = amount(item.quantity);
    return price === null || quantity === null ? NaN : sum + price * quantity;
  }, 0);
  const gross = (order) => order.subtotalSnapshot ?? order.subtotal ?? itemGross(order);
  const discounts = (order) => order.discountTotalSnapshot ?? order.discountTotal;
  const minimumAdjustment = (order) => order.minimumAdjustmentSnapshot ?? order.minimumAdjustment;
  const net = (order) => order.finalTotalSnapshot ?? order.finalTotal ?? (order.payments || [])
    .filter((payment) => ['paid', 'partially_paid'].includes(payment.status))
    .reduce((sum, payment) => sum + (amount(payment.amount) ?? 0), 0);
  const snapshotComplete = (order) => Boolean(order.pricingVersion && order.subtotalSnapshot != null
    && order.discountTotalSnapshot != null && order.minimumAdjustmentSnapshot != null && order.finalTotalSnapshot != null);
  const sourceKnown = (order) => order.effectiveDiscountSource != null;
  const groupDiscountKnown = (order) => order.groupDiscountAmount != null;
  const promotionKnown = (order) => order.selectedPromotionSnapshot !== undefined || order.selectedPromotion !== undefined;
  const sumBySource = (records, keyOf, valueOf, known) => records.every((record) => known(record) && amount(valueOf(record)) !== null)
    ? groupSum(records, keyOf, valueOf)
    : null;

  const receipts = [];
  for (const guest of guests.filter((entry) => entry.venueId === venueId)) {
    for (const receipt of guest.depositTopUps || []) {
      if (inPeriod(receipt.createdAt)) receipts.push({ method: receipt.method, source: 'guest_account_top_up', amount: receipt.amount });
    }
  }
  for (const reservation of reservations.filter((entry) => entry.venueId === venueId)) {
    for (const receipt of reservation.prepaymentReceipts || []) {
      if (inPeriod(receipt.createdAt)) receipts.push({ method: receipt.method, source: 'reservation_prepayment', amount: receipt.amount });
    }
  }
  for (const order of venueOrders) {
    for (const payment of order.payments || []) {
      if (['paid', 'partially_paid'].includes(payment.status) && ['cash', 'card', 'qr'].includes(payment.method) && inPeriod(payment.createdAt)) {
        receipts.push({ method: payment.method, source: 'order_payment', amount: payment.amount });
      }
    }
  }

  const unavailable = [];
  const saleGross = totalWhenComplete(closedOrders, gross);
  const saleDiscounts = totalWhenComplete(closedOrders, discounts);
  const saleMinimumAdjustment = totalWhenComplete(closedOrders, minimumAdjustment);
  const saleNet = totalWhenComplete(closedOrders, net);
  if ([saleGross, saleDiscounts, saleMinimumAdjustment, saleNet].some((value) => value === null)) unavailable.push('sales fields for closed orders without saved price data');
  const discountsBySource = sumBySource(closedOrders, (order) => order.effectiveDiscountSource, discounts, sourceKnown);
  const discountsByGroup = sumBySource(closedOrders, (order) => Number(order.groupDiscountAmount || 0) > 0 ? (order.groupDiscountName || 'Без группы') : null, (order) => order.groupDiscountAmount || 0, groupDiscountKnown);
  const discountsByPromotion = sumBySource(closedOrders, (order) => order.selectedPromotionSnapshot?.name || order.selectedPromotion?.label || null, (order) => order.selectedPromotionSnapshot === null ? 0 : order.selectedPromotionSnapshot?.amount ?? order.selectedPromotion?.amount, promotionKnown);
  if (discountsBySource === null || discountsByGroup === null || discountsByPromotion === null) unavailable.push('discount breakdown for closed orders without price snapshots');
  if (closedOrdersWithoutClosureDate > 0) unavailable.push(`${closedOrdersWithoutClosureDate} closed order(s) have no valid closure date and are excluded from date-based sales`);
  const payoutMethods = null;
  const payoutSources = null;
  unavailable.push('external refund and payout ledgers');

  return {
    sales: {
      orders: closedOrders.length,
      unsnapshottedOrders: closedOrders.filter((order) => !snapshotComplete(order)).length,
      gross: saleGross,
      discounts: saleDiscounts,
      minimumAdjustment: saleMinimumAdjustment,
      net: saleNet,
      discountsBySource,
      discountsByGroup,
      discountsByPromotion
    },
    receipts: {
      byMethod: groupSum(receipts, (receipt) => receipt.method || 'не указан', (receipt) => receipt.amount),
      bySource: groupSum(receipts, (receipt) => receipt.source, (receipt) => receipt.amount)
    },
    payouts: { byMethod: payoutMethods, bySource: payoutSources },
    coverage: { source: 'memory', complete: false, unavailable }
  };
}

function summarizeMemoryReservationPrepayments(reservations = [], venueId) {
  const owned = reservations.filter((reservation) => reservation.venueId === venueId);
  let unapplied = 0;
  let verifiedCounterMismatchCount = 0;
  let verifiedCounterMismatchAmount = 0;
  for (const reservation of owned) {
    const receipts = reservation.prepaymentReceipts || [];
    const allocations = reservation.prepaymentAllocations || [];
    const allocationReversals = reservation.prepaymentAllocationReversals || [];
    const refunds = reservation.prepaymentRefunds || [];
    for (const receipt of receipts) {
      const allocated = allocations.filter((entry) => entry.receiptId === receipt.id).reduce((sum, entry) => sum + (amount(entry.amount) ?? 0), 0);
      const reversed = allocationReversals.filter((entry) => entry.receiptId === receipt.id).reduce((sum, entry) => sum + (amount(entry.amount) ?? 0), 0);
      const refunded = refunds.filter((entry) => entry.receiptId === receipt.id).reduce((sum, entry) => sum + (amount(entry.amount) ?? 0), 0);
      unapplied += Math.max(0, (amount(receipt.amount) ?? 0) - allocated + reversed - refunded);
    }
    if (reservation.verifiedDepositPaid !== undefined) {
      const receiptTotal = receipts.reduce((sum, receipt) => sum + (amount(receipt.amount) ?? 0), 0)
        - refunds.filter((entry) => receipts.some((receipt) => receipt.id === entry.receiptId))
          .reduce((sum, entry) => sum + (amount(entry.amount) ?? 0), 0);
      const difference = Math.abs((amount(reservation.verifiedDepositPaid) ?? 0) - receiptTotal);
      if (Math.round(difference * 100) !== 0) {
        verifiedCounterMismatchCount += 1;
        verifiedCounterMismatchAmount += difference;
      }
    }
  }
  return { unapplied, verifiedCounterMismatchCount, verifiedCounterMismatchAmount };
}

module.exports = { buildMemoryPeriodBusiness, summarizeMemoryReservationPrepayments, localDateKey };
