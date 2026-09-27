import { useEffect } from 'react';
import { cn, formatRelative } from '../lib/format';
import { useFleet } from '../store/FleetContext';
import type { Toast } from '../lib/notifications';

const TONE_STYLE = {
  ok: 'border-healthy/50 bg-healthy/[0.12]',
  release: 'border-warn/50 bg-warn/[0.12]',
  alert: 'border-danger/50 bg-danger/[0.12]',
} as const;

const TONE_LABEL = {
  ok: 'Confirmed',
  release: 'Declined',
  alert: 'Action needed',
} as const;

const TONE_TEXT = {
  ok: 'text-healthy',
  release: 'text-warn',
  alert: 'text-danger',
} as const;

/**
 * Live notification feed.
 *
 * A decline used to be invisible to the person who made the request: their shipment
 * quietly went back to DRAFT. This surfaces the server's `notification.created` event
 * as soon as it is broadcast, so "someone declined your load" is actually told.
 */
export function NotificationToasts() {
  const { toasts, dismissToast } = useFleet();

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(92vw,380px)] flex-col gap-2">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={() => dismissToast(t.id)} />
      ))}
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  // Auto-dismiss so a stack of them does not sit over the UI, but long enough to read.
  useEffect(() => {
    const t = window.setTimeout(onDismiss, 12000);
    return () => window.clearTimeout(t);
  }, [onDismiss]);

  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto animate-slide-up rounded-md border px-3.5 py-3 shadow-lg',
        TONE_STYLE[toast.tone],
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            'text-[9px] font-semibold uppercase tracking-[0.14em]',
            TONE_TEXT[toast.tone],
          )}
        >
          {TONE_LABEL[toast.tone]}
        </span>
        <button type="button" className="btn-quiet text-2xs" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-200">{toast.message}</p>
      <p className="mt-1 text-[9px] text-ink-500">{formatRelative(new Date(toast.at).toISOString())}</p>
    </div>
  );
}
