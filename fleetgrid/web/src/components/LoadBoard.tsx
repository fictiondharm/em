import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useFleet } from '../store/FleetContext';
import { Panel } from './Panel';
import { StatusPill } from './Primitives';
import { cn, formatMoney, formatT, formatTime } from '../lib/format';
import { truckTone } from '../lib/tone';
import type { BoardEntry, DriverRequests, DriverRosterRow, LoadRequestBoard, Shipment } from '../lib/types';

/**
 * Every driver, and the open board they are all holding.
 *
 * The driver console used to be scoped to whoever was signed in, which made the fleet
 * look like one truck. This lists the whole crew and lets you act as any of them, so a
 * single load can be seen going to the drivers who were asked, answered by one of them,
 * and taken by another, without logging in and out nine times.
 *
 * The board is read from the server, never assembled in the browser: accepting is a
 * compare-and-set, so what a driver can do is decided by the backend and this only shows
 * what it was told.
 */
export function LoadBoard({ selfDriverId }: { selfDriverId: string | null }) {
  const { snapshot, refresh } = useFleet();

  const [roster, setRoster] = useState<DriverRosterRow[]>([]);
  const [rosterCounts, setRosterCounts] = useState({ total: 0, onATruck: 0, awaitingApproval: 0 });
  const [selected, setSelected] = useState<string | null>(selfDriverId);
  const [requests, setRequests] = useState<DriverRequests | null>(null);
  const [board, setBoard] = useState<LoadRequestBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ id: string; tone: 'ok' | 'warn'; text: string } | null>(null);

  // Roster + board both change when the snapshot does, so a decision taken on the
  // Business screen lands here without a reload.
  const signature = `${snapshot.shipments.length}:${snapshot.trucks.length}:${snapshot.drivers.length}`;

  useEffect(() => {
    let cancelled = false;
    void api
      .drivers()
      .then((res) => {
        if (cancelled) return;
        setRoster(res.drivers);
        setRosterCounts(res.counts);
        setSelected((cur) => cur ?? res.drivers[0]?.id ?? null);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [signature]);

  useEffect(() => {
    if (!selected) {
      setRequests(null);
      return;
    }
    let cancelled = false;
    void api
      .driverRequests(selected)
      .then((res) => {
        if (!cancelled) {
          setRequests(res);
          setError(null);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, signature]);

  const open = requests?.open ?? [];
  const won = requests?.won ?? [];
  const lost = requests?.lost ?? [];
  const driver = roster.find((d) => d.id === selected) ?? null;

  async function accept(shipmentId: string) {
    if (!selected) return;
    setBusy(`${shipmentId}:accept`);
    setError(null);
    setOutcome(null);
    try {
      const res = await api.acceptLoadRequest(shipmentId, selected);
      setBoard(res.board);
      setOutcome({
        id: shipmentId,
        tone: 'ok',
        text: `You took ${shipmentId} on ${res.shipment.truckId}. ${res.board.counts.asked - 1} other driver${
          res.board.counts.asked - 1 === 1 ? '' : 's'
        } can no longer accept it.`,
      });
      await refresh();
    } catch (err) {
      // A 409 here is the normal outcome of losing a race, not a failure. It names the
      // winner, so say that rather than "something went wrong".
      const message = err instanceof ApiError ? err.message : (err as Error).message;
      setError(message);
      setOutcome({ id: shipmentId, tone: 'warn', text: message });
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function decline(shipmentId: string) {
    if (!selected) return;
    setBusy(`${shipmentId}:decline`);
    setError(null);
    setOutcome(null);
    try {
      const res = await api.declineLoadRequest(shipmentId, selected, 'Passed from the driver board');
      setBoard(res.board);
      setOutcome({
        id: shipmentId,
        tone: 'warn',
        text: res.stillOpen
          ? `You passed on ${shipmentId}. It is still open with ${res.board.counts.pending} driver${
              res.board.counts.pending === 1 ? '' : 's'
            } to answer.`
          : `You were the last driver holding ${shipmentId}, so it closed and nothing is reserved.`,
      });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel
        eyebrow="Crew"
        title="All drivers"
        bodyClassName="p-0"
        className="min-h-[200px]"
        actions={
          <span className="text-2xs text-ink-500">
            {rosterCounts.total} drivers · {rosterCounts.onATruck} on a truck
          </span>
        }
      >
        <ul className="grid grid-cols-1 gap-px bg-base-700 sm:grid-cols-2 lg:grid-cols-3">
          {roster.map((d) => {
            const isSelected = d.id === selected;
            return (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(d.id);
                    setBoard(null);
                    setOutcome(null);
                  }}
                  className={cn(
                    'flex w-full flex-col gap-1.5 px-3.5 py-3 text-left transition',
                    isSelected ? 'bg-accent/15 ring-1 ring-inset ring-accent/50' : 'bg-base-850 hover:bg-base-800',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-xs font-medium text-ink-50">{d.name}</span>
                    {d.id === selfDriverId && (
                      <span className="rounded border border-accent/50 px-1 py-0.5 text-[9px] uppercase tracking-[0.1em] text-accent">
                        you
                      </span>
                    )}
                    {d.truckStatus && <StatusPill status={d.truckStatus} tone={truckTone(d.truckStatus)} />}
                  </div>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-mono text-[10px] text-ink-400">
                      {d.truckId ?? 'no truck'} · {d.lane ?? 'no lane'}
                    </span>
                    <span className="tabular shrink-0 text-[11px] font-semibold text-ink-200">
                      {d.availableT === null ? '—' : formatT(d.availableT)}
                    </span>
                  </div>
                  {d.awaitingApproval > 0 && (
                    <span className="text-[10px] text-warn">
                      {d.awaitingApproval} load{d.awaitingApproval === 1 ? '' : 's'} waiting
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </Panel>

      {driver && (
        <Panel
          eyebrow={driver.truckId ? `Acting as ${driver.name} · ${driver.truckId}` : `Acting as ${driver.name}`}
          title="Load board"
          bodyClassName="p-0"
          className="min-h-[220px]"
          actions={
            <span className="text-2xs text-ink-500">
              {requests?.counts.open ?? 0} open · {requests?.counts.won ?? 0} won · {requests?.counts.lost ?? 0} lost
            </span>
          }
        >
          {error && <div className="px-4 py-2 text-[11px] text-danger">{error}</div>}

          {open.length === 0 && won.length === 0 && lost.length === 0 && !error ? (
            <div className="px-4 py-8 text-center text-xs text-ink-400">
              {driver.name} is not on any open request right now.
            </div>
          ) : (
            <>
              {open.length > 0 && (
                <div className="border-b border-base-700">
                  <div className="px-4 pb-1 pt-3 text-[9px] font-semibold uppercase tracking-[0.14em] text-ink-500">
                    Open requests you can answer
                  </div>
                  <ul className="divide-y divide-base-800">
                    {open.map(({ shipment, competingDrivers }) => (
                      <RequestRow
                        key={shipment.id}
                        shipment={shipment}
                        competingDrivers={competingDrivers}
                        busy={busy === `${shipment.id}:accept` || busy === `${shipment.id}:decline`}
                        onAccept={() => void accept(shipment.id)}
                        onDecline={() => void decline(shipment.id)}
                        onShowBoard={() => void showBoard(shipment.id, setBoard)}
                        outcome={outcome?.id === shipment.id ? outcome : null}
                      />
                    ))}
                  </ul>
                </div>
              )}

              {won.length > 0 && (
                <div className="border-b border-base-700">
                  <div className="px-4 pb-1 pt-3 text-[9px] font-semibold uppercase tracking-[0.14em] text-ink-500">
                    Won
                  </div>
                  <ul className="divide-y divide-base-800">
                    {won.map((s) => (
                      <li key={s.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                        <span className="font-mono text-[11px] text-ink-300">{s.id}</span>
                        <span className="truncate text-[11px] text-ink-400">
                          {s.cargoName} · {formatT(s.weightT)}T · {s.origin} → {s.destination}
                        </span>
                        <span className="shrink-0 text-[11px] font-semibold text-healthy">
                          {formatMoney(s.price, s.currency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {lost.length > 0 && (
                <div>
                  <div className="px-4 pb-1 pt-3 text-[9px] font-semibold uppercase tracking-[0.14em] text-ink-500">
                    Went to another driver
                  </div>
                  <ul className="divide-y divide-base-800">
                    {lost.map(({ shipment, wonBy }) => (
                      <li key={shipment.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                        <span className="font-mono text-[11px] text-ink-300">{shipment.id}</span>
                        <span className="truncate text-[11px] text-ink-500">
                          {shipment.origin} → {shipment.destination}
                        </span>
                        <span className="shrink-0 text-[11px] text-ink-400">
                          {wonBy ? `Taken by ${wonBy}` : 'Closed'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </Panel>
      )}

      {board && <BoardDetail board={board} onClose={() => setBoard(null)} />}
    </div>
  );
}

/** Loads the full ask list on demand, so the roster rows stay cheap. */
async function showBoard(id: string, set: (b: LoadRequestBoard) => void) {
  const res = await api.loadRequestBoard(id);
  set(res);
}

function RequestRow({
  shipment,
  competingDrivers,
  busy,
  onAccept,
  onDecline,
  onShowBoard,
  outcome,
}: {
  shipment: Shipment;
  competingDrivers: number;
  busy: boolean;
  onAccept: () => void;
  onDecline: () => void;
  onShowBoard: () => void;
  outcome: { tone: 'ok' | 'warn'; text: string } | null;
}) {
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] font-semibold text-ink-50">{shipment.id}</span>
            <StatusPill status="AWAITING_DRIVER" tone="accent" />
            {competingDrivers > 0 && (
              <span className="rounded border border-base-600 px-1.5 py-0.5 text-[9px] text-ink-400">
                {competingDrivers} other driver{competingDrivers === 1 ? '' : 's'} also holding this
              </span>
            )}
            {competingDrivers === 0 && (
              <span className="rounded border border-healthy/50 bg-healthy/10 px-1.5 py-0.5 text-[9px] text-healthy">
                you are the only one left
              </span>
            )}
          </div>
          <div className="mt-1 truncate text-[11px] text-ink-300">
            {shipment.cargoName} · {formatT(shipment.weightT)}T · {shipment.origin} → {shipment.destination}
          </div>
          <div className="mt-0.5 text-[10px] text-ink-500">
            {formatMoney(shipment.price, shipment.currency)} · posted {formatTime(shipment.createdAt)}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button type="button" className="btn-quiet text-2xs" onClick={onShowBoard} disabled={busy}>
            Who else
          </button>
          <button type="button" className="btn-quiet text-2xs" onClick={onDecline} disabled={busy}>
            Decline
          </button>
          <button type="button" className="btn-primary text-2xs" onClick={onAccept} disabled={busy}>
            {busy ? 'Working' : 'Accept'}
          </button>
        </div>
      </div>

      {outcome && (
        <div
          className={cn(
            'mt-2 rounded border px-2.5 py-1.5 text-[11px]',
            outcome.tone === 'ok'
              ? 'border-healthy/50 bg-healthy/10 text-healthy'
              : 'border-warn/50 bg-warn/10 text-warn',
          )}
        >
          {outcome.text}
        </div>
      )}
    </li>
  );
}

/** "Who all got this request", one row per asked driver with what they did about it. */
function BoardDetail({ board, onClose }: { board: LoadRequestBoard; onClose: () => void }) {
  return (
    <Panel
      eyebrow={`${board.shipment.id} · ${board.route}`}
      title="Who got this request"
      bodyClassName="p-0"
      className="min-h-[160px]"
      actions={
        <button type="button" className="btn-quiet text-2xs" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="flex flex-wrap items-center gap-4 border-b border-base-700 px-4 py-2.5 text-[10px] text-ink-400">
        <span>
          asked <span className="font-semibold text-ink-100">{board.counts.asked}</span>
        </span>
        <span>
          still holding <span className="font-semibold text-accent">{board.counts.pending}</span>
        </span>
        <span>
          declined <span className="font-semibold text-warn">{board.counts.declined}</span>
        </span>
        <span>
          won <span className="font-semibold text-healthy">{board.counts.won}</span>
        </span>
        {board.winner && (
          <span className="ml-auto text-ink-200">
            Taken by {board.winner.driverName} on {board.winner.truckId}
          </span>
        )}
        {!board.open && !board.winner && <span className="ml-auto text-warn">Closed - every driver passed</span>}
      </div>

      <ul className="divide-y divide-base-800">
        {board.board.map((entry) => (
          <BoardRow key={entry.driverId} entry={entry} />
        ))}
      </ul>
    </Panel>
  );
}

const RESPONSE_STYLE: Record<BoardEntry['response'], { label: string; cls: string }> = {
  PENDING: { label: 'holding', cls: 'border-accent/50 text-accent' },
  DECLINED: { label: 'declined', cls: 'border-warn/50 text-warn' },
  WON: { label: 'took it', cls: 'border-healthy/50 text-healthy' },
  LOST: { label: 'too late', cls: 'border-base-600 text-ink-500' },
};

function BoardRow({ entry }: { entry: BoardEntry }) {
  const style = RESPONSE_STYLE[entry.response];
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-2.5">
      <div className="min-w-0">
        <span className="truncate text-[11px] text-ink-200">{entry.driverName}</span>
        <span className="ml-2 font-mono text-[10px] text-ink-500">{entry.truckId ?? 'no truck'}</span>
      </div>
      <span className={cn('shrink-0 rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.1em]', style.cls)}>
        {style.label}
      </span>
    </li>
  );
}
