/**
 * In-app notification delivery.
 *
 * The server already stores notifications and broadcasts `notification.created`
 * (recovery has always done this). What was missing is a way for the person being
 * notified to actually see one — a decline used to roll the shipment back to DRAFT
 * with nothing said. These are shown live, addressed to the session's organization.
 */
import type { FlashKind } from './flash';
/** Mirrors `FlashKind` in `flash.ts` so a toast and a row flash agree on tone. */
export type ToastTone = FlashKind;

export interface Toast {
  id: string;
  type: string;
  message: string;
  tone: ToastTone;
  /** Epoch ms, so a relative "just now" works without a date string. */
  at: number;
}

/**
 * `recipientId` is a shipper org id for a declined load and an operator org id for
 * the freed-capacity note, so a screen has to match on its own organization to
 * avoid showing a crew member someone else's news.
 */
export function notificationsFor(
  notifications: Array<{ id: string; recipientId: string; type: string; message: string; createdAt: string }>,
  recipientId: string | null | undefined,
) {
  if (!recipientId) return [];
  return notifications
    .filter((n) => n.recipientId === recipientId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function toastToneFor(type: string): ToastTone {
  if (type === 'SHIPMENT_ACCEPTED' || type === 'SHIPMENT_DELIVERED') return 'ok';
  // You were asked to take a load: worth interrupting for, but it is an opportunity,
  // not a fault, so it reads as a neutral announcement rather than an alert.
  if (type === 'LOAD_REQUEST_OPEN') return 'release';
  // Somebody took it and somebody else did not: both are outcomes to report, not failures.
  if (type === 'LOAD_REQUEST_TAKEN' || type === 'LOAD_REQUEST_PARTIAL') return 'release';
  if (type === 'SHIPMENT_DECLINED' || type === 'CAPACITY_DECLINED') return 'release';
  if (type.includes('INCIDENT') || type.includes('RISK') || type.includes('RECOVERY')) return 'alert';
  return 'ok';
}
