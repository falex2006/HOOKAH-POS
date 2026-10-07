'use strict';

const STATUS_REASONS = Object.freeze({
  open: 'order_open',
  in_progress: 'order_in_progress',
  ready: 'order_ready',
});

function orderAttentionReasons(order) {
  const reasons = [];
  const statusReason = STATUS_REASONS[order?.status];
  if (statusReason) reasons.push(statusReason);

  const paymentDue = Number(order?.attentionPaymentDue);
  if (order?.status !== 'cancelled' && Number.isFinite(paymentDue) && Math.round(paymentDue * 100) > 0) reasons.push('payment_due');
  return reasons;
}

module.exports = { orderAttentionReasons };
