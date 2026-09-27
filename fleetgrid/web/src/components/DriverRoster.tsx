import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { flashClassFor } from '../lib/flash';
import { useFleet } from '../store/FleetContext';
import { Panel } from './Panel';
import { StatusPill } from './Primitives';
import { cn, formatT } from '../lib/format';
import { truckTone } from '../lib/tone';
import type { DriverRosterRow } from '../lib/types';

/**
 * The whole crew, not just whoever happens to be signed in.
 *
 * The Driver screen is deliberately scoped to one driver, which left no way to see
 * the rest of the fleet. This is the operator's view of who is out there, which
 * lane each one is on, how much room they have left, and who is sitting on a load
 * they have not answered yet.
 */
export function DriverRoster() {
  const { flashIds, flashTone } = useFleet();
  const [rows, setRows] = useState<DriverRosterRow[]>([]);
  const [counts, setCounts] = useState({ total: 0, onATruck: 0, awaitingApproval: 0 });
  const [error, setError] = useState<string | null>(null);

  // Refetched whenever the authoritative snapshot changes, so approvals and
  // departures move the roster without a reload.
  const { snapshot } = useFleet();
  const signature = `${snapshot.trucks.length}:${snapshot.shipments.length}:${snapshot.drivers.length}`;

  useEffect(() => {
    let cancelled = false;
    void api
      .drivers()
      .then((res) => {
        if (cancelled) return;
        setRows(res.drivers);
        setCounts(res.counts);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : (err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [signature]);

  return (
    <Panel
      eyebrow="Crew"
      title="Drivers"
      bodyClassName="p-0"
      className="min-h-[240px]"
      actions={
        <span className="text-[10px] text-ink-500">
          {counts.total} driver{counts.total === 1 ? '' : 's'} · {counts.onATruck} on a truck ·{' '}
          {counts.awaitingApproval} awaiting approval
        </span>
      }
    >
      {error ? (
        <div className="px-4 py-6 text-center text-xs text-danger">{error}</div>
      ) : rows.length === 0 ? (
        <div className="px-4 py-8 text-center text-xs text-ink-400">No drivers yet.</div>
      ) : (
        <ul className="divide-y divide-base-700">
          {rows.map((d) => (
            <li key={d.id} className={cn(flashClassFor(flashTone, d.truckId ?? d.id, flashIds))}>
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-ink-50">{d.name}</span>
                    {d.truckId ? (
                      <span className="font-mono text-[10px] text-ink-400">{d.truckId}</span>
                    ) : (
                      <span className="rounded border border-base-600 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.1em] text-ink-500">
                        no truck
                      </span>
                    )}
                    {d.truckStatus && <StatusPill status={d.truckStatus} tone={truckTone(d.truckStatus)} />}
                  </div>
                  <div className="mt-0.5 text-[10px] text-ink-500">
                    {d.lane ?? 'Not on a lane'} · {d.contact}
                    {d.pricePerT ? ` · ₹${d.pricePerT}/t demo rate` : ''}
                  </div>
                  {d.awaitingApproval > 0 && (
                    <div className="mt-1 text-[10px] text-warn">
                      {d.awaitingApproval} load{d.awaitingApproval === 1 ? '' : 's'} waiting on{' '}
                      {d.name.split(' ')[0]}: {d.awaitingShipmentIds.join(', ')}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <div className="tabular text-sm font-semibold text-ink-50">
                      {d.availableT === null ? '—' : `${formatT(d.availableT)}/${formatT(d.capacityT ?? 0)}`}
                    </div>
                    <div className="text-[9px] uppercase tracking-[0.1em] text-ink-500">free / capacity</div>
                  </div>
                  <div className="text-right">
                    <div className="tabular text-sm font-semibold text-ink-300">{d.activeShipments}</div>
                    <div className="text-[9px] uppercase tracking-[0.1em] text-ink-500">active loads</div>
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
