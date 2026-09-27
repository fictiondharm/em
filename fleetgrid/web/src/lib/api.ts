import { API_BASE } from './config';
import type {
  CapacityOptions,
  CapacityMatch,
  DriverRosterRow,
  DemoLoginResponse,
  FleetSnapshot,
  Incident,
  RecoveryOption,
  RecoveryPlan,
  Role,
  Shipment,
  ShipmentEvent,
  Truck,
} from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (err) {
    throw new ApiError(
      0,
      'NETWORK',
      `Cannot reach the FleetGrid server at ${API_BASE}. Is the backend running? (${(err as Error).message})`,
    );
  }

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    const error = (body as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiError(
      res.status,
      error?.code ?? 'ERROR',
      error?.message ?? `Request failed with status ${res.status}`,
      error?.details,
    );
  }

  return body as T;
}

const post = <T,>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? '{}' : JSON.stringify(body) });

export const api = {
  base: API_BASE,
  health: () => request<Record<string, unknown>>('/health'),
  state: () => request<FleetSnapshot>('/state'),
  demoLogin: (role: Role) => post<DemoLoginResponse>('/auth/demo-login', { role }),

  /**
   * Self-service onboarding. Returns the same `{ user, organization, driver }` shape
   * as demoLogin, so a freshly registered account can be used like a seeded one.
   */
  register: (input: {
    role: 'BUSINESS' | 'DRIVER';
    name: string;
    contact: string;
    organizationName?: string;
    truck?: { registrationNo: string; capacityT: number; origin: string; destination: string };
  }) =>
    post<{
      ok: true;
      mode: string;
      warning: string;
      user: DemoLoginResponse['user'];
      organization: DemoLoginResponse['organization'];
      driver: DemoLoginResponse['driver'];
      truck: Truck | null;
    }>('/auth/register', input),

  resetDemo: () => post<{ ok: true; trucks: number; shipments: number }>('/demo/reset'),

  trucks: () => request<{ trucks: Truck[] }>('/trucks'),
  truck: (id: string) => request<{ truck: Truck; shipments: Shipment[]; incidents: Incident[] }>(`/trucks/${id}`),
  depart: (id: string, driverId?: string) =>
    post<{ ok: true; truck: Truck; truckStatus: string; shipments: Shipment[] }>(
      `/trucks/${id}/depart`,
      driverId ? { driverId } : {},
    ),

    /**
     * Every way this load can actually move: one truck, a split across several, or a
     * plain reason it cannot be done. Returns something useful even when nothing fits,
     * which is the whole point — an empty list reads as a broken product.
     */
    capacityOptions: (params: { origin: string; destination: string; weightT: number }) => {
      const qs = new URLSearchParams({
        origin: params.origin,
        destination: params.destination,
        weightT: String(params.weightT),
      });
      return request<CapacityOptions>(`/capacity/options?${qs.toString()}`);
    },
    /** The whole crew with truck, lane, spare tonnage and loads awaiting approval. */
  drivers: () =>
    request<{
      drivers: DriverRosterRow[];
      counts: { total: number; onATruck: number; awaitingApproval: number };
    }>('/drivers'),
  capacity: (params: { origin?: string; destination?: string; weightT?: number; includeAll?: boolean }) => {
    const qs = new URLSearchParams();
    if (params.origin) qs.set('origin', params.origin);
    if (params.destination) qs.set('destination', params.destination);
    if (params.weightT !== undefined) qs.set('weightT', String(params.weightT));
    if (params.includeAll) qs.set('includeAll', 'true');
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<{ matches: CapacityMatch[]; count: number; note: string }>(`/capacity${suffix}`);
  },

  /**
   * Other trucks worth knowing about when one has been picked, nearest first.
   * `distanceFromSelectedKm` is straight-line from stored coordinates.
   */
  nearbyCapacity: (truckId: string, params: { origin?: string; destination?: string; weightT?: number } = {}) => {
    const qs = new URLSearchParams({ truckId });
    if (params.origin) qs.set('origin', params.origin);
    if (params.destination) qs.set('destination', params.destination);
    if (params.weightT !== undefined) qs.set('weightT', String(params.weightT));
    return request<{
      selected: CapacityMatch | null;
      selectedTruck: Truck | null;
      selectedTruckSpareT: number | null;
      suggestions: Array<CapacityMatch & {
        distanceFromSelectedKm: number | null;
        proximityLabel: string;
        canAlsoCarry: boolean;
      }>;
      note: string;
    }>(`/capacity/nearby?${qs.toString()}`);
  },

  createShipment: (input: {
    shipperId: string;
    cargoName: string;
    origin: string;
    destination: string;
    weightT: number;
    capacityOfferId?: string;
    actorId?: string;
  }) =>
    post<{
      ok: true;
      shipment: Shipment;
      reserved: boolean;
      confirmed: boolean;
      /** True when the load is now waiting on the driver's approval. */
      awaitingDriverApproval: boolean;
    }>('/shipments', input),

  shipments: () => request<{ shipments: Shipment[] }>('/shipments'),
  shipment: (id: string) => request<{ shipment: Shipment }>(`/shipments/${id}`),

  /** The driver accepts the load. CAPACITY_RESERVED → CONFIRMED. */
  acceptShipment: (id: string, actorId?: string) =>
    post<{ ok: true; shipment: Shipment; acceptedBy: string }>(
      `/shipments/${id}/confirm`,
      actorId ? { actorId } : {},
    ),

  /** The driver declines. Releases the tonnage and returns the shipment to DRAFT. */
  declineShipment: (id: string, reason?: string, actorId?: string) =>
    post<{
      ok: true;
      declined: boolean;
      shipment: Shipment;
      releasedTruck: Truck | null;
      releasedOffer: { id: string; availableT: number; status: string } | null;
    }>(`/shipments/${id}/decline`, {
      ...(reason ? { reason } : {}),
      ...(actorId ? { actorId } : {}),
    }),

  /** The driver's approval queue: what is waiting on them, and what they already took. */
  driverOffers: (driverId: string) =>
    request<{
      driver: { id: string; name: string; status: string; assignedTruckId: string | null } | null;
      truck: Truck | null;
      pending: Array<{
        shipment: Shipment;
        truck: Truck | null;
        shipperName: string | null;
        route: string;
        estimatedPay: number;
        currency: string;
        awaitingDriver: boolean;
      }>;
      accepted: Array<{
        shipment: Shipment;
        truck: Truck | null;
        shipperName: string | null;
        route: string;
        estimatedPay: number;
        currency: string;
        awaitingDriver: boolean;
      }>;
      counts: { pending: number; accepted: number };
      note: string;
    }>(`/driver/offers?driverId=${encodeURIComponent(driverId)}`),

  confirmDelivery: (id: string, actorId?: string) =>
    post<{ ok: true; shipment: Shipment; truck: Truck | null; truckCompleted: boolean }>(
      `/shipments/${id}/confirm-delivery`,
      actorId ? { actorId } : {},
    ),
  timeline: (id: string) =>
    request<{
      shipment: Shipment;
      truck: Truck | null;
      events: ShipmentEvent[];
      incidents: Incident[];
      recoveryPlans: RecoveryPlan[];
    }>(`/shipments/${id}/timeline`),

  createIncident: (input: {
    truckId: string;
    type: Incident['type'];
    location: string;
    description?: string;
    severity?: Incident['severity'];
    actorId?: string;
  }) =>
    post<{ ok: true; incident: Incident; truck: Truck; affectedShipments: Shipment[] }>('/incidents', input),
  incidents: () => request<{ incidents: Incident[] }>('/incidents'),
  incident: (id: string) => request<{ incident: Incident }>(`/incidents/${id}`),

  recoveryOptions: (incidentId: string) =>
    request<{
      options: RecoveryOption[];
      impact: {
        totalWeightT: number;
        notes: string[];
        affectedShipments: Array<{ id: string; cargoName: string; weightT: number }>;
      };
      engine: string;
    }>(`/incidents/${incidentId}/recovery-options`),

  createRecoveryPlan: (incidentId: string) =>
    post<{ ok: true; plan: RecoveryPlan; options: RecoveryOption[]; created: boolean; engine: string }>(
      '/recovery-plans',
      { incidentId },
    ),
  approvePlan: (planId: string, approvedBy: string) =>
    post<{ ok: true; plan: RecoveryPlan }>(`/recovery-plans/${planId}/approve`, { approvedBy }),
  executePlan: (planId: string, executedBy: string) =>
    post<{
      ok: true;
      plan: RecoveryPlan;
      verification: Record<string, string | number>;
      alreadyExecuted: boolean;
    }>(`/recovery-plans/${planId}/execute`, { executedBy }),

  recordEvent: (input: { eventType: string; shipmentId?: string; payload?: Record<string, unknown> }) =>
    post<{ ok: true; event: ShipmentEvent }>('/events', input),
};
