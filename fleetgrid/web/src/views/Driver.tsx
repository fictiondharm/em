import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { flashClassFor } from '../lib/flash';
import { useFleet } from '../store/FleetContext';
import { AppHeader } from '../components/AppHeader';
import { Panel, Placeholder } from '../components/Panel';
import { LoadBoard } from '../components/LoadBoard';
import { StatusPill } from '../components/Primitives';
import { cn, formatT, formatRelative } from '../lib/format';
import { incidentTypeLabel, shipmentTone, truckTone } from '../lib/tone';
import type { Incident, IncidentType } from '../lib/types';

const INCIDENT_TYPES: Array<{ value: IncidentType; label: string; defaultLocation: string; defaultDescription: string }> = [
  {
    value: 'TRUCK_BREAKDOWN',
    label: 'Truck Breakdown',
    defaultLocation: 'Hosur',
    defaultDescription: 'Engine failure / truck unable to continue',
  },
  { value: 'ACCIDENT', label: 'Accident', defaultLocation: 'Hosur', defaultDescription: 'Accident on the highway' },
  { value: 'DELAY', label: 'Delay', defaultLocation: 'Hosur', defaultDescription: 'Running behind schedule' },
  { value: 'ROUTE_BLOCKED', label: 'Route Blocked', defaultLocation: 'Hosur', defaultDescription: 'Cannot proceed on this route' },
  { value: 'CARGO_DAMAGE', label: 'Cargo Damage', defaultLocation: 'Hosur', defaultDescription: 'Cargo damaged in transit' },
  { value: 'OTHER', label: 'Other', defaultLocation: 'Hosur', defaultDescription: '' },
];

/**
 * DRIVER — mobile-first console for the assigned truck.
 * Mobile-friendly on purpose: this screen is meant to be demoed on a phone.
 */
export function Driver() {
  const { snapshot, session, refresh, connection, flashIds, flashTone } = useFleet();

  const truckId = session?.driver?.assignedTruckId ?? 'FG-027';
  const truck = snapshot.trucks.find((t) => t.id === truckId) ?? null;
  const assigned = useMemo(
    () =>
      snapshot.shipments
        .filter((s) => s.truckId === truckId && s.status !== 'DELIVERED')
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    [snapshot.shipments, truckId],
  );
  const cargo = assigned[0] ?? null;
  const myIncidents = useMemo(
    () =>
      snapshot.incidents
        .filter((i) => i.truckId === truckId)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    [snapshot.incidents, truckId],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const [incidentType, setIncidentType] = useState<IncidentType>('TRUCK_BREAKDOWN');
  const [location, setLocation] = useState('Hosur');
  const [description, setDescription] = useState('Engine failure / truck unable to continue');
  const [submitted, setSubmitted] = useState<Incident | null>(null);

  // The approval queue comes from the server, not from local filtering, so what the
  // driver sees is exactly what POST /shipments/:id/confirm and /decline will accept.
  const [queue, setQueue] = useState<Awaited<ReturnType<typeof api.driverOffers>> | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  const driverId = session?.driver?.id ?? null;

  // Reload whenever the authoritative snapshot changes, so a booking made on the
  // Business screen shows up here on the next realtime refetch.
  useEffect(() => {
    if (!driverId) {
      setQueue(null);
      return;
    }
    let cancelled = false;
    void api
      .driverOffers(driverId)
      .then((res) => {
        if (!cancelled) {
          setQueue(res);
          setQueueError(null);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setQueueError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [driverId, snapshot]);

  const pending = queue?.pending ?? [];
  const accepted = queue?.accepted ?? [];

  async function acceptOffer(shipmentId: string) {
    setActing(shipmentId);
    setError(null);
    try {
      await api.acceptShipment(shipmentId, driverId ?? undefined);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setActing(null);
    }
  }

  async function declineOffer(shipmentId: string) {
    setActing(shipmentId);
    setError(null);
    try {
      await api.declineShipment(shipmentId, 'Driver declined from the cab view', driverId ?? undefined);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setActing(null);
    }
  }

  const canDepart =
    !!truck &&
    ['ASSIGNED', 'AVAILABLE', 'DELAYED'].includes(truck.status) &&
    !!cargo &&
    cargo.status !== 'IN_TRANSIT' &&
    // The server refuses to depart with an unaccepted load, so do not offer a
    // button that can only fail.
    pending.length === 0;
  const inTransit = truck?.status === 'IN_TRANSIT';

  async function startJourney() {
    if (!truck) return;
    setBusy(true);
    setError(null);
    try {
      await api.depart(truck.id, session?.driver?.id);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function pickType(value: IncidentType) {
    setIncidentType(value);
    const preset = INCIDENT_TYPES.find((t) => t.value === value);
    if (preset) {
      setLocation(preset.defaultLocation);
      setDescription(preset.defaultDescription);
    }
  }

  async function reportIncident() {
    if (!truck) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.createIncident({
        truckId: truck.id,
        type: incidentType,
        location,
        description,
        ...(session?.driver?.id ? { actorId: session.driver.id } : {}),
      });
      setSubmitted(res.incident);
      setReporting(false);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!truck) {
    return (
      <div className="relative z-10 min-h-screen">
        <AppHeader />
        <main className="mx-auto max-w-md px-4 py-8">
          <Panel eyebrow="Driver" title="No truck assigned">
            <p className="text-xs text-ink-400">
              This driver has no assigned truck in the current server state. Run Reset Demo State from the Control
              Tower.
            </p>
          </Panel>
        </main>
      </div>
    );
  }

  return (
    <div className="relative z-10 min-h-screen">
      <AppHeader />

      <main className="mx-auto max-w-6xl px-4 py-4">
        {/* The crew and the open board come first: one load can sit in front of every
            driver who can take it, and that is the thing worth seeing. */}
        <LoadBoard selfDriverId={driverId} />

        <div className="mx-auto mt-6 max-w-md space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="eyebrow">Driver</div>
              <h1 className="mt-1 text-lg font-semibold tracking-tight text-ink-50">
                {session?.driver?.name ?? session?.user.name ?? 'Driver'}
              </h1>
            </div>
            <StatusPill
              status={truck.status}
              tone={truckTone(truck.status)}
              size="md"
              pulse={truck.status === 'INCIDENT'}
            />
          </div>

          {/* Truck identity */}
          <div
            className={cn(
              'panel p-4',
              truck.status === 'INCIDENT' && 'border-danger/45 shadow-incident',
              flashClassFor(flashTone, truck.id, flashIds),
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="eyebrow">Truck</div>
                <div className="mt-1 font-mono text-3xl font-semibold tracking-tight text-ink-50">{truck.id}</div>
                <div className="mt-1 text-[11px] text-ink-400">{truck.registrationNo}</div>
              </div>
              <svg viewBox="0 0 64 32" className="h-10 w-20 text-ink-500" fill="none" aria-hidden="true">
                <path
                  d="M2 22h34v6H2zM36 22l8-11h10l6 11v6H36z"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                />
                <circle cx="14" cy="28" r="3.4" stroke="currentColor" strokeWidth="1.4" />
                <circle cx="48" cy="28" r="3.4" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            </div>

            <div className="mt-4 flex items-center gap-2 text-sm">
              <span className="font-medium text-ink-50">{truck.origin}</span>
              <span className="text-ink-600">→</span>
              <span className="font-medium text-ink-50">{truck.destination}</span>
            </div>

            <div className="tabular mt-3 grid grid-cols-2 gap-2">
              <div className="rounded border border-base-600 bg-base-900/60 px-3 py-2">
                <div className="eyebrow">Capacity</div>
                <div className="mt-0.5 text-lg font-semibold text-ink-50">{formatT(truck.capacityT)}</div>
              </div>
              <div className="rounded border border-base-600 bg-base-900/60 px-3 py-2">
                <div className="eyebrow">Remaining</div>
                <div
                  className={cn(
                    'mt-0.5 text-lg font-semibold',
                    truck.availableT > 0 ? 'text-healthy' : 'text-warn',
                  )}
                >
                  {formatT(truck.availableT)}
                </div>
              </div>
            </div>

            <div className="mt-2 h-1 overflow-hidden rounded-full bg-base-700">
              <div
                className={cn(
                  'h-full rounded-full transition-all duration-500',
                  truckTone(truck.status) === 'danger' ? 'bg-danger' : 'bg-healthy',
                )}
                style={{ width: `${(truck.availableT / Math.max(truck.capacityT, 0.001)) * 100}%` }}
              />
            </div>
          </div>

          {/* Approval queue — the driver decides what to carry. */}
          <Panel
            eyebrow="Your call"
            title={pending.length > 0 ? `Loads waiting for you (${pending.length})` : 'Loads waiting for you'}
            bodyClassName="p-0"
          >
            {queueError && (
              <p className="border-b border-base-700 px-4 py-2.5 text-[11px] text-danger">{queueError}</p>
            )}

            {pending.length === 0 ? (
              <p className="px-4 py-4 text-[11px] leading-relaxed text-ink-500">
                Nothing needs your approval right now. When a business books capacity on your truck, the offer
                appears here and you choose whether to take it.
              </p>
            ) : (
              <ul className="divide-y divide-base-700">
                {pending.map((offer) => (
                  <li
                    key={offer.shipment.id}
                    className={cn('px-4 py-3.5', flashClassFor(flashTone, offer.shipment.id, flashIds))}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm font-semibold text-ink-50">
                            {offer.shipment.id}
                          </span>
                          <StatusPill status="CAPACITY_RESERVED" tone="warn" size="sm" />
                        </div>
                        <div className="mt-1 truncate text-[11px] text-ink-400">{offer.shipment.cargoName}</div>
                        <div className="mt-0.5 text-[10px] text-ink-600">
                          {offer.shipperName ?? offer.shipment.shipperId}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="tabular text-base font-semibold text-ink-50">
                          {formatT(offer.shipment.weightT)}
                        </div>
                        <div className="text-[10px] text-ink-600">{offer.currency}</div>
                      </div>
                    </div>

                    <div className="mt-2.5 flex items-center gap-1.5 text-[11px] text-ink-400">
                      <span className="font-medium text-ink-300">{offer.shipment.origin}</span>
                      <span className="text-ink-600">→</span>
                      <span className="font-medium text-ink-300">{offer.shipment.destination}</span>
                    </div>

                    {offer.shipment.deadlineAt && (
                      <div className="mt-1 text-[10px] text-ink-600">
                        Deliver by {formatRelative(offer.shipment.deadlineAt)}
                      </div>
                    )}

                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        disabled={acting !== null}
                        onClick={() => void acceptOffer(offer.shipment.id)}
                        className={cn(
                          'flex-1 rounded-md border border-healthy/40 bg-healthy/10 py-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-healthy transition-colors',
                          'hover:bg-healthy/20 disabled:opacity-50',
                        )}
                      >
                        {acting === offer.shipment.id ? 'Working…' : 'Accept'}
                      </button>
                      <button
                        type="button"
                        disabled={acting !== null}
                        onClick={() => void declineOffer(offer.shipment.id)}
                        className={cn(
                          'flex-1 rounded-md border border-base-600 py-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-400 transition-colors',
                          'hover:border-danger/40 hover:text-danger disabled:opacity-50',
                        )}
                      >
                        Decline
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {accepted.length > 0 && (
              <div className="border-t border-base-700 px-4 py-3">
                <div className="eyebrow mb-1.5">Already accepted</div>
                <ul className="space-y-1">
                  {accepted.map((offer) => (
                    <li key={offer.shipment.id} className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="font-mono text-ink-300">{offer.shipment.id}</span>
                        <span className="truncate text-ink-600">{offer.shipment.cargoName}</span>
                      </span>
                      <span className="shrink-0 text-ink-500">{formatT(offer.shipment.weightT)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Panel>

          {/* Cargo */}
          <Panel eyebrow="Load" title="Assigned shipment" bodyClassName="p-4">
            {cargo ? (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-base font-semibold text-ink-50">{cargo.cargoName}</div>
                    <div className="mt-0.5 font-mono text-[10px] text-ink-500">{cargo.id}</div>
                  </div>
                  <StatusPill
                    status={cargo.status}
                    tone={shipmentTone(cargo.status)}
                    pulse={cargo.status === 'AT_RISK'}
                  />
                </div>
                <div className="tabular mt-3 text-[11px] text-ink-400">
                  {formatT(cargo.weightT)} · {cargo.origin} → {cargo.destination}
                </div>
              </>
            ) : (
              <p className="text-xs text-ink-400">
                No shipment on this truck yet. Create one from Business mode and it will appear here immediately.
              </p>
            )}
          </Panel>

          {/* Primary actions */}
          <div className="space-y-2.5">
            {canDepart && (
              <button type="button" className="btn-primary w-full py-3.5 text-base" onClick={startJourney} disabled={busy}>
                {busy ? 'Starting…' : 'Start Journey'}
              </button>
            )}

            {inTransit && !reporting && (
              <button
                type="button"
                className="btn-danger w-full py-3.5 text-base"
                onClick={() => setReporting(true)}
                disabled={busy}
              >
                Report Incident
              </button>
            )}

            {truck.status === 'INCIDENT' && !reporting && (
              <div className="rounded-md border border-danger/40 bg-danger/10 px-3.5 py-3 text-center text-xs text-danger">
                Truck reported INCIDENT. The Control Tower has been notified and owns the recovery decision.
              </div>
            )}

            {!canDepart && !inTransit && truck.status !== 'INCIDENT' && !reporting && (
              <p className="text-center text-[11px] text-ink-500">
                Journey actions are unavailable while the truck is {truck.status.toLowerCase().replace('_', ' ')}.
              </p>
            )}
          </div>

          {/* Incident form */}
          {reporting && (
            <Panel eyebrow="Incident report" title="What happened?" bodyClassName="p-4">
              <label className="block">
                <span className="label">Incident type</span>
                <select
                  className="field"
                  value={incidentType}
                  onChange={(e) => pickType(e.target.value as IncidentType)}
                >
                  {INCIDENT_TYPES.map((t) => (
                    <option key={t.value} value={t.value} className="bg-base-800">
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="mt-3 block">
                <span className="label">Location</span>
                <input className="field" value={location} onChange={(e) => setLocation(e.target.value)} />
              </label>

              <label className="mt-3 block">
                <span className="label">Description</span>
                <textarea
                  className="field min-h-[80px] resize-y"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>

              <div className="mt-3 flex gap-2">
                <button type="button" className="btn-ghost flex-1" onClick={() => setReporting(false)} disabled={busy}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn-danger flex-1"
                  onClick={reportIncident}
                  disabled={busy || !location.trim()}
                >
                  {busy ? 'Sending…' : 'Report Incident'}
                </button>
              </div>
              <p className="mt-2 text-[10px] text-ink-500">
                Voice capture (ElevenLabs) replaces this form in a later phase. Text reports already reach the same
                structured backend incident.
              </p>
            </Panel>
          )}

          {error && (
            <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>
          )}

          {/* Post-report confirmation */}
          {submitted && (
            <div className="rounded-lg border border-danger/45 bg-danger/[0.07] p-4">
              <div className="text-2xs font-semibold uppercase tracking-[0.18em] text-danger">Incident Reported</div>
              <div className="mt-2 space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-ink-400">Incident</span>
                  <span className="font-mono text-ink-50">{submitted.id}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-ink-400">Status</span>
                  <StatusPill status={submitted.status} tone="danger" />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-ink-400">Truck</span>
                  <StatusPill status={truck.status} tone={truckTone(truck.status)} />
                </div>
                {cargo && (
                  <div className="flex items-center justify-between">
                    <span className="text-ink-400">Shipment</span>
                    <StatusPill status={cargo.status} tone={shipmentTone(cargo.status)} />
                  </div>
                )}
              </div>
              <p className="mt-3 text-[10px] leading-relaxed text-ink-400">
                Broadcast to every connected device. The Control Tower sees this incident and can run Analyze Recovery.
              </p>
            </div>
          )}

          {/* Incident history */}
          {myIncidents.length > 0 && (
            <Panel eyebrow="History" title="Reported incidents" bodyClassName="p-0">
              <ul className="divide-y divide-base-700">
                {myIncidents.map((i) => (
                  <li key={i.id} className="px-4 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-ink-50">{incidentTypeLabel[i.type] ?? i.type}</span>
                      <StatusPill status={i.status} tone={truckTone(truck.status) === 'danger' ? 'danger' : 'neutral'} />
                    </div>
                    <div className="mt-1 text-[10px] text-ink-500">
                      {i.location} · {formatRelative(i.createdAt)} · <span className="font-mono">{i.id}</span>
                    </div>
                    {i.affectedShipmentIds.length > 0 && (
                      <div className="mt-1 text-[10px] text-ink-400">
                        Affected: <span className="font-mono">{i.affectedShipmentIds.join(', ')}</span>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <Placeholder>Realtime is {connection}. Driver notifications from recovery execution are stored as PENDING until a delivery provider is added.</Placeholder>
        </div>
      </main>
    </div>
  );
}
