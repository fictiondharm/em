import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api } from '../lib/api';
import { flashKindFor, type FlashKind } from '../lib/flash';
import { toastToneFor, type Toast } from '../lib/notifications';
import { useRealtime, type ConnectionStatus } from '../lib/realtime';
import type { DemoLoginResponse, FleetSnapshot, Mode, RealtimeEventType } from '../lib/types';

const EMPTY_SNAPSHOT: FleetSnapshot = {
  generatedAt: '',
  organizations: [],
  users: [],
  drivers: [],
  trucks: [],
  shipments: [],
  capacityOffers: [],
  incidents: [],
  recoveryPlans: [],
  payments: [],
  events: [],
  notifications: [],
};

/** Realtime messages that invalidate the client cache and require a refetch. */
const REFETCH_EVENTS: ReadonlySet<RealtimeEventType> = new Set<RealtimeEventType>([
  'demo.reset',
  'truck.updated',
  'driver.updated',
  'shipment.created',
  'shipment.updated',
  // A broadcast board moves when a request opens, is taken, or loses a driver, and the
  // driver tab is showing live counts of who is still holding what. Refetch on all three
  // or the tab quietly shows a stale board.
  'load_request.opened',
  'load_request.accepted',
  'load_request.declined',
  'load_request.closed',
  'capacity.updated',
  'incident.created',
  'incident.updated',
  'recovery.updated',
  'payment.updated',
  'notification.created',
]);

const MODE_STORAGE_KEY = 'fleetgrid.mode';

interface FleetContextValue {
  snapshot: FleetSnapshot;
  loading: boolean;
  error: string | null;
  connection: ConnectionStatus;
  mode: Mode | null;
  session: DemoLoginResponse | null;
  lastEvent: { type: string; at: number } | null;
  /** Highlights rows touched by the most recent realtime event. */
  flashIds: string[];
  /**
   * Tone for the rows in `flashIds`, derived from the event that triggered the
   * refetch. A decline flashes amber, not green, so a rejection never reads as a
   * completed action.
   */
  flashTone: FlashKind;
  refresh: () => Promise<void>;
  setMode: (mode: Mode) => Promise<void>;
  /**
   * Enters a mode using an account that already exists, instead of re-running
   * `POST /auth/demo-login`. This is how a freshly registered user becomes the
   * active session, so the app acts as *them* rather than as a seeded user.
   */
  adoptAccount: (mode: Mode, session: DemoLoginResponse) => void;
  resetDemo: () => Promise<void>;
  lastEventLabel: string | null;
  /** Live notifications addressed to this session's organization. */
  toasts: Toast[];
  dismissToast: (id: string) => void;
}

const FleetContext = createContext<FleetContextValue | null>(null);

export function FleetProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<FleetSnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setModeState] = useState<Mode | null>(() => readStoredMode());
  const [session, setSession] = useState<DemoLoginResponse | null>(null);
  const [lastEvent, setLastEvent] = useState<{ type: string; at: number } | null>(null);
  const [flashIds, setFlashIds] = useState<string[]>([]);
  const [flashTone, setFlashTone] = useState<FlashKind>('ok');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const sessionRef = useRef<DemoLoginResponse | null>(null);
  const pushToast = useCallback((t: Toast) => {
    setToasts((prev) => {
      if (prev.some((x) => x.id === t.id)) return prev;
      return [t, ...prev].slice(0, 4);
    });
  }, []);
  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pendingRef = useRef<number | null>(null);
  const flashTimerRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api.state();
      setSnapshot(next);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Realtime events never mutate local state directly — they only mark the cache
   * stale and trigger a refetch of the authoritative server snapshot.
   */
  const handleMessage = useCallback(
    (message: { type: string; payload: unknown }) => {
      setLastEvent({ type: message.type, at: Date.now() });

      if (message.type === 'connected') {
        void refresh();
        return;
      }

      if (REFETCH_EVENTS.has(message.type as RealtimeEventType)) {
        const payload = message.payload as { id?: string; truckId?: string; shipmentId?: string } | null;

        // A notification is addressed to an organization, not a row, so it becomes a
        // toast rather than a row flash. Delivered only to the recipient's own org,
        // and it must not flash the notification id as if it were a shipment id.
        if (message.type === 'notification.created') {
          const n = message.payload as { id?: string; type?: string; message?: string; recipientId?: string };
          // A notification is addressed either to an organization (shipper/operator notices)
      // or to one individual user (a driver being asked to take a load, or told they lost
      // it). Matching only the organization meant drivers were told about a request they
      // were part of and saw nothing when they were one.
      const addressedToMe =
        n.recipientId === sessionRef.current?.organization?.id || n.recipientId === sessionRef.current?.user.id;
      if (n?.id && n.recipientId && addressedToMe) {
            pushToast({
              id: n.id,
              type: n.type ?? 'NOTIFICATION',
              message: n.message ?? '',
              tone: toastToneFor(n.type ?? ''),
              at: Date.now(),
            });
          }
        } else {
          const ids = [payload?.id, payload?.truckId, payload?.shipmentId].filter(
            (v): v is string => typeof v === 'string',
          );
          if (ids.length) {
            setFlashIds(ids);
            setFlashTone(flashKindFor(message.type));
            if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
            flashTimerRef.current = window.setTimeout(() => setFlashIds([]), 1600);
          }
        }

        if (pendingRef.current) window.clearTimeout(pendingRef.current);
        pendingRef.current = window.setTimeout(() => {
          pendingRef.current = null;
          void refresh();
        }, 80);
      }
    },
    [refresh],
  );

  const connection = useRealtime({ onMessage: handleMessage, onOpen: () => void refresh() });

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () => () => {
      if (pendingRef.current) window.clearTimeout(pendingRef.current);
      if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    },
    [],
  );

  const setMode = useCallback(
    async (next: Mode) => {
      setModeState(next);
      // Harmless UI preference only — never fleet data.
      try {
        window.localStorage.setItem(MODE_STORAGE_KEY, next);
      } catch {
        /* private mode: ignore */
      }
      try {
        // REGISTER is only a screen, so there is no seeded role to log into for it.
        if (next === 'REGISTER') return;
        const login = await api.demoLogin(next);
        setSession(login);
        sessionRef.current = login;
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [],
  );

  const adoptAccount = useCallback((next: Mode, account: DemoLoginResponse) => {
    setModeState(next);
    try {
      window.localStorage.setItem(MODE_STORAGE_KEY, next);
    } catch {
      /* private mode: ignore */
    }
    setSession(account);
    sessionRef.current = account;
    setError(null);
  }, []);

  const resetDemo = useCallback(async () => {
    setLoading(true);
    try {
      await api.resetDemo();
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [refresh]);

  const lastEventLabel = useMemo(() => {
    if (!lastEvent) return null;
    const age = Date.now() - lastEvent.at;
    return `${lastEvent.type} · ${new Date(lastEvent.at).toLocaleTimeString('en-GB')} (${Math.round(age / 100) / 10}s ago)`;
  }, [lastEvent]);

  const value: FleetContextValue = {
    snapshot,
    loading,
    error,
    connection,
    mode,
    session,
    lastEvent,
    flashIds,
    flashTone,
    toasts,
    dismissToast,
    refresh,
    setMode,
    adoptAccount,
    resetDemo,
    lastEventLabel,
  };

  return <FleetContext.Provider value={value}>{children}</FleetContext.Provider>;
}

export function useFleet(): FleetContextValue {
  const ctx = useContext(FleetContext);
  if (!ctx) throw new Error('useFleet must be used inside <FleetProvider>');
  return ctx;
}

function readStoredMode(): Mode | null {
  try {
    const stored = window.localStorage.getItem(MODE_STORAGE_KEY);
    if (stored === 'CONTROL_TOWER' || stored === 'BUSINESS' || stored === 'DRIVER' || stored === 'REGISTER') return stored;
  } catch {
    /* ignore */
  }
  return null;
}
