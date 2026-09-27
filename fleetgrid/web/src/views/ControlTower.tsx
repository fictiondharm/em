import { useMemo, useState } from 'react';
import { flashClassFor } from '../lib/flash';
import { useFleet } from '../store/FleetContext';
import { AppHeader } from '../components/AppHeader';
import { Metric, StatusPill } from '../components/Primitives';
import { Panel, Placeholder } from '../components/Panel';
import { NetworkMap } from '../components/NetworkMap';
import { ShipmentTable } from '../components/ShipmentTable';
import { EventFeed } from '../components/EventFeed';
import { IncidentPanel } from '../components/IncidentPanel';
import { DriverRoster } from '../components/DriverRoster';
import { cn, formatTime } from '../lib/format';
import { shipmentTone, truckTone } from '../lib/tone';

type FleetFilter = 'ALL' | 'AVAILABLE' | 'IN_TRANSIT' | 'INCIDENT' | 'RECOVERY';

/**
 * CONTROL TOWER — operator view over the whole network.
 * Every value is read from the server snapshot; nothing is simulated client-side.
 */
export function ControlTower() {
  const { snapshot, refresh, resetDemo, session, error, connection, lastEvent, flashIds, flashTone, loading } = useFleet();
  const [filter, setFilter] = useState<FleetFilter>('ALL');
  const [resetting, setResetting] = useState(false);
  const [feedTab, setFeedTab] = useState<'agent' | 'all'>('all');

  const { trucks, shipments, incidents, events, users } = snapshot;
  const operatorId = useMemo(() => {
    const operator = users.find((u) => u.role === 'OPERATOR') ?? users.find((u) => u.role === 'CONTROL_TOWER');
    return operator?.id ?? 'operator_demo';
  }, [users]);

  const counts = useMemo(
    () => ({
      available: trucks.filter((t) => t.status === 'AVAILABLE' || t.status === 'ASSIGNED').length,
      inTransit: trucks.filter((t) => t.status === 'IN_TRANSIT' || t.status === 'LOADING').length,
      incident: trucks.filter((t) => t.status === 'INCIDENT').length,
      recovery: trucks.filter((t) => t.status === 'RECOVERY' || t.status === 'DELAYED').length,
      spareT: Math.round(trucks.reduce((sum, t) => sum + t.availableT, 0) * 10) / 10,
    }),
    [trucks],
  );

  const visibleTrucks = useMemo(() => {
    if (filter === 'ALL') return trucks;
    if (filter === 'AVAILABLE') return trucks.filter((t) => t.status === 'AVAILABLE' || t.status === 'ASSIGNED');
    if (filter === 'RECOVERY') return trucks.filter((t) => t.status === 'RECOVERY' || t.status === 'DELAYED');
    return trucks.filter((t) => t.status === filter);
  }, [trucks, filter]);

  const recentEvents = useMemo(
    () => events.slice().sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)),
    [events],
  );

  return (
    <div className="relative z-10 min-h-screen">
      <AppHeader />

      <main className="px-4 py-4 lg:px-6">
        <div className="mx-auto max-w-[1600px] space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-ink-50">Network Control</h1>
              <p className="mt-0.5 text-xs text-ink-400">
                Live operational picture across {trucks.length} trucks ·{' '}
                {snapshot.generatedAt ? `server state ${formatTime(snapshot.generatedAt)}` : 'loading…'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {session && (
                <div className="hidden items-center gap-2 rounded-md border border-base-600 bg-base-850 px-3 py-1.5 text-2xs text-ink-400 sm:flex">
                  <span className="text-ink-200">{session.user.name}</span>
                  <span className="text-ink-600">·</span>
                  <span>{session.organization?.name}</span>
                </div>
              )}
              <button
                type="button"
                className="btn-ghost"
                disabled={resetting}
                onClick={() => {
                  setResetting(true);
                  void resetDemo().finally(() => setResetting(false));
                }}
              >
                {resetting ? 'Resetting…' : 'Reset Demo State'}
              </button>
            </div>
          </div>

          {error && (
            <div className="rounded-md border border-danger/40 bg-danger/10 px-3.5 py-2.5 text-xs text-danger">
              <span className="font-semibold">Server unreachable. </span>
              {error}
            </div>
          )}

          {connection !== 'live' && !error && (
            <div className="rounded-md border border-warn/35 bg-warn/[0.07] px-3.5 py-2.5 text-xs text-warn">
              Realtime {connection}. Displayed state may be stale — it will resync automatically.
            </div>
          )}

          <div className="panel grid grid-cols-2 divide-x divide-base-600 sm:grid-cols-3 lg:grid-cols-6">
            <Metric label="Available" value={counts.available} tone="healthy" hint={`${counts.spareT}T spare network-wide`} onClick={() => setFilter('AVAILABLE')} active={filter === 'AVAILABLE'} />
            <Metric label="In Transit" value={counts.inTransit} tone="accent" onClick={() => setFilter('IN_TRANSIT')} active={filter === 'IN_TRANSIT'} />
            <Metric label="Incident" value={counts.incident} tone="danger" onClick={() => setFilter('INCIDENT')} active={filter === 'INCIDENT'} />
            <Metric label="Recovery" value={counts.recovery} tone="warn" onClick={() => setFilter('RECOVERY')} active={filter === 'RECOVERY'} />
            <Metric label="Active Shipments" value={shipments.filter((s) => s.status !== 'DELIVERED').length} hint="Excludes delivered" />
            <Metric label="Realtime" value={lastEvent ? lastEvent.type.replace('.', ' ') : 'idle'} tone="neutral" hint={`${events.length} events logged`} />
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(340px,0.95fr)]">
            <div className="space-y-4">
              <Panel
                eyebrow="Live Network"
                title="Bengaluru → Chennai corridor"
                bodyClassName="p-0"
                actions={
                  filter !== 'ALL' ? (
                    <button type="button" className="btn-quiet text-2xs" onClick={() => setFilter('ALL')}>
                      Clear filter
                    </button>
                  ) : null
                }
              >
                <div className="h-[300px]">
                  <NetworkMap trucks={visibleTrucks} incidents={incidents} flashIds={flashIds} flashTone={flashTone} />
                </div>
              </Panel>

              <Panel eyebrow="Active Shipments" title="Cargo on the network" bodyClassName="p-0" className="min-h-[260px]">
                <div className="max-h-[320px]">
                  <ShipmentTable shipments={shipments} trucks={trucks} flashIds={flashIds} flashTone={flashTone} />
                </div>
              </Panel>

              <div className="min-h-[240px]">
                <DriverRoster />
              </div>

              <Panel
                eyebrow="Fleet"
                title="Trucks"
                bodyClassName="p-0"
                className="min-h-[220px]"
                actions={<span className="text-2xs text-ink-500">{visibleTrucks.length} shown</span>}
              >
                <div className="grid gap-px bg-base-700 sm:grid-cols-2 lg:grid-cols-3">
                  {visibleTrucks.map((truck) => (
                    <div
                      key={truck.id}
                      className={cn(
                        'bg-base-800 px-3.5 py-3 transition-colors hover:bg-base-750/60',
                        flashClassFor(flashTone, truck.id, flashIds),
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-sm font-semibold text-ink-50">{truck.id}</span>
                        <StatusPill
                          status={truck.status}
                          tone={truckTone(truck.status)}
                          pulse={truck.status === 'INCIDENT'}
                        />
                      </div>
                      <div className="mt-1 text-[10px] text-ink-500">
                        {truck.origin} → {truck.destination} · {truck.registrationNo}
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <div className="h-1 flex-1 overflow-hidden rounded-full bg-base-700">
                          <div
                            className={cn(
                              'h-full rounded-full transition-all duration-500',
                              truckTone(truck.status) === 'danger'
                                ? 'bg-danger'
                                : truckTone(truck.status) === 'warn'
                                  ? 'bg-warn'
                                  : 'bg-healthy',
                            )}
                            style={{ width: `${(truck.availableT / Math.max(truck.capacityT, 0.001)) * 100}%` }}
                          />
                        </div>
                        <span className="tabular shrink-0 font-mono text-[10px] text-ink-300">
                          {truck.availableT.toFixed(1)}/{truck.capacityT.toFixed(1)}T
                        </span>
                      </div>
                    </div>
                  ))}
                  {visibleTrucks.length === 0 && (
                    <div className="bg-base-800 px-3.5 py-6 text-center text-2xs text-ink-500 sm:col-span-2 lg:col-span-3">
                      No trucks match this filter.
                    </div>
                  )}
                </div>
              </Panel>
            </div>

            <div className="space-y-4">
              <Panel eyebrow="Incidents" title="Recovery desk" bodyClassName="p-3.5">
                <IncidentPanel
                  incidents={incidents}
                  shipments={shipments}
                  trucks={trucks}
                  plans={snapshot.recoveryPlans}
                  operatorId={operatorId}
                  flashIds={flashIds} flashTone={flashTone}
                  onAction={refresh}
                />
              </Panel>

              <Panel
                eyebrow="Agent Activity"
                title={feedTab === 'agent' ? 'Recovery + incident events' : 'All events'}
                bodyClassName="p-0"
                className="min-h-[280px]"
                actions={
                  <div className="flex rounded border border-base-600 p-0.5">
                    {(['agent', 'all'] as const).map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        onClick={() => setFeedTab(tab)}
                        className={cn(
                          'rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] transition-colors',
                          feedTab === tab ? 'bg-ink-50 text-base-950' : 'text-ink-400 hover:text-ink-100',
                        )}
                      >
                        {tab}
                      </button>
                    ))}
                  </div>
                }
              >
                <div className="max-h-[340px]">
                  <EventFeed
                    events={recentEvents}
                    filter={feedTab}
                    limit={30}
                    emptyHint="Agent activity is recorded as backend events. Run the demo flow to populate it."
                  />
                </div>
              </Panel>

              <Panel eyebrow="Payment & Proof" title="Honest status" bodyClassName="p-3.5">
                <Placeholder className="mb-2.5">
                  Dodo Payments integration, notification delivery and EVM proof anchoring are phase-2 work. Seeded
                  payment rows are labelled DEMO_PLACEHOLDER and no blockchain confirmation is ever claimed.
                </Placeholder>
                <div className="flex flex-wrap items-center gap-2">
                  {snapshot.payments.slice(-3).map((p) => (
                    <div key={p.id} className="rounded border border-base-600 bg-base-900/60 px-2.5 py-1.5">
                      <div className="flex items-center gap-2">
                        <StatusPill status={p.status} tone={p.status === 'PAID' ? 'healthy' : 'warn'} />
                        <span className="font-mono text-[10px] text-ink-400">{p.shipmentId}</span>
                      </div>
                      <div className="mt-0.5 text-[9px] uppercase tracking-[0.1em] text-ink-600">{p.provider}</div>
                    </div>
                  ))}
                  {snapshot.payments.length === 0 && (
                    <span className="text-2xs text-ink-500">No payment records.</span>
                  )}
                </div>
              </Panel>
            </div>
          </div>

          {loading && (
            <div className="pointer-events-none fixed bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-base-600 bg-base-850 px-3 py-1 text-2xs text-ink-400">
              syncing server state…
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export { shipmentTone };
