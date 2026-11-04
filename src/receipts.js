import { safeError } from './errors.js';

// Only the message POST can have an ambiguous delivery result. A failed upload
// cannot deliver the message (srv_send_msg is always false).
export function failureDelivery(error, stage) {
  if (stage !== 'message') return 'not_sent';
  const safe = safeError(error);
  if (['API_NETWORK', 'API_RESPONSE'].includes(safe.code)) return 'unknown';
  if (safe.code === 'API_REJECTED' || safe.code === 'PERMISSION_REQUIRED') return safe.status >= 500 ? 'unknown' : 'rejected';
  return 'not_sent';
}

export function sendReceipt(sent, { total = 0, error, stage = 'validation', warnings = [] } = {}) {
  const failure = error && safeError(error);
  const delivery = failure && failureDelivery(error, stage);
  return Object.freeze({
    ...sent.at(-1),
    ok: !failure,
    status: !failure ? 'success' : sent.length ? 'partial' : delivery === 'unknown' ? 'unknown' : 'rejected',
    message_ids: Object.freeze(sent.map(item => item.message_id)),
    sent: Object.freeze(sent.map(item => Object.freeze({ ...item }))),
    total_parts: total,
    completed_parts: sent.length,
    ...(failure ? { failure: Object.freeze({ code: failure.code, message: failure.message, delivery, stage,
      part_index: sent.length, ...(failure.status ? { status: failure.status } : {}),
      ...(failure.platformCode ? { platformCode: failure.platformCode } : {}) }) } : {}),
    ...(warnings.length ? { warnings: Object.freeze([...warnings]) } : {})
  });
}
