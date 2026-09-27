/**
 * Mirror of `server/src/types.ts`.
 *
 * The server is the single source of truth for FleetGrid data. These types exist
 * only so the browser bundle can typecheck API responses — never to hold state
 * locally. The browser is forbidden from storing fleet/shipment/incident/recovery
 * state in localStorage, IndexedDB or component memory as an authority.
 */
export type Role = 'CONTROL_TOWER' | 'BUSINESS' | 'DRIVER' | 'OPERATOR' | 'VERIFIER';
/** `REGISTER` is a screen, not a role — it hands off to BUSINESS or DRIVER. */
export type Mode = 'CONTROL_TOWER' | 'BUSINESS' | 'DRIVER' | 'REGISTER';

export type TruckStatus =
  | 'AVAILABLE'
  | 'ASSIGNED'
  | 'LOADING'
  | 'IN_TRANSIT'
  | 'DELIVERED'
  | 'DELAYED'
  | 'INCIDENT'
  | 'RECOVERY';

export type ShipmentStatus =
  | 'DRAFT'
  | 'AWAITING_DRIVER'
  | 'CAPACITY_RESERVED'
  | 'CONFIRMED'
  | 'IN_TRANSIT'
  | 'AT_RISK'
  | 'RECOVERY'
  | 'DELIVERED';

export type IncidentStatus = 'OPEN' | 'ANALYZING' | 'PLAN_READY' | 'RESOLVED' | 'ESCALATED';
export type RecoveryPlanStatus =
  | 'DRAFT'
  | 'PROPOSED'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'EXECUTING'
  | 'COMPLETED'
  | 'REJECTED';
export type PaymentStatus = 'CREATED' | 'PENDING' | 'PAID' | 'FAILED';
export type ProofStatus = 'NOT_ANCHORED' | 'PENDING' | 'CONFIRMED' | 'FAILED';
export type IncidentType =
  | 'TRUCK_BREAKDOWN'
  | 'ACCIDENT'
  | 'DELAY'
  | 'CARGO_DAMAGE'
  | 'ROUTE_BLOCKED'
  | 'OTHER';
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface Organization {
  id: string;
  name: string;
  type: 'SHIPPER' | 'FLEET_OPERATOR';
  status: 'ACTIVE' | 'SUSPENDED';
  createdAt: string;
}

export interface User {
  id: string;
  name: string;
  role: Role;
  organizationId: string;
  contact: string;
  createdAt: string;
}

export interface Driver {
  id: string;
  organizationId: string;
  userId: string;
  name: string;
  phone: string;
  assignedTruckId: string | null;
  status: 'AVAILABLE' | 'ON_JOURNEY' | 'OFF_DUTY';
  createdAt: string;
}

export interface Truck {
  id: string;
  organizationId: string;
  registrationNo: string;
  capacityT: number;
  availableT: number;
  status: TruckStatus;
  lat: number;
  lng: number;
  origin: string;
  destination: string;
  departureAt: string | null;
  driverId: string | null;
  createdAt: string;
}

export interface Shipment {
  id: string;
  reference: string;
  cargoName: string;
  shipperId: string;
  origin: string;
  destination: string;
  weightT: number;
  deadlineAt: string | null;
  status: ShipmentStatus;
  truckId: string | null;
  capacityOfferId: string | null;
  /** Broadcast requests: every driver who was asked, frozen when it opened. */
  askedDriverIds?: string[];
  /** Broadcast requests: drivers who have passed. The request stays open for the rest. */
  declinedDriverIds?: string[];
  closedReason?: string | null;
  price: number;
  currency: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * One driver on a broadcast board. PENDING means they can still act; LOST means the
 * load was won by someone else before they answered, so the tab must not keep offering
 * an accept that can no longer succeed.
 */
export interface BoardEntry {
  driverId: string;
  driverName: string;
  truckId: string | null;
  response: 'PENDING' | 'DECLINED' | 'WON' | 'LOST';
  reason: string | null;
}

export interface LoadRequestBoard {
  shipment: Shipment;
  route: string;
  open: boolean;
  winner: { driverId: string; driverName: string; truckId: string } | null;
  board: BoardEntry[];
  counts: { asked: number; pending: number; declined: number; lost: number; won: number };
}

export interface DriverRequests {
  driver: { id: string; name: string; status: string; assignedTruckId: string | null } | null;
  truck: Truck | null;
  open: Array<{ shipment: Shipment; competingDrivers: number }>;
  won: Shipment[];
  lost: Array<{ shipment: Shipment; wonBy: string | null }>;
  counts: { open: number; won: number; lost: number };
  note: string;
}

export interface EligibleDriver {
  driver: { id: string; name: string; status: string };
  truck: { id: string; origin: string; destination: string; availableT: number };
  fit: string;
  freeT: number;
  pricePerT: number;
  /** Plain-language reason this driver can or cannot take the load. */
  note: string;
}

export interface CapacityOffer {
  id: string;
  truckId: string;
  route: string;
  origin: string;
  destination: string;
  availableT: number;
  departureAt: string | null;
  status: 'OPEN' | 'HELD' | 'CLOSED';
  priceRule: string;
  pricePerT: number;
  updatedAt: string;
}

export interface Incident {
  id: string;
  truckId: string;
  type: IncidentType;
  location: string;
  severity: Severity;
  transcript: string;
  structuredSummary: string;
  status: IncidentStatus;
  source: 'DRIVER_APP' | 'VOICE' | 'OPERATOR' | 'SYSTEM';
  affectedShipmentIds: string[];
  recoveryPlanId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ShipmentEvent {
  id: string;
  shipmentId: string | null;
  incidentId: string | null;
  truckId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  actorType: string;
  actorId: string | null;
  timestamp: string;
  hash: string;
  blockchainTx: string | null;
  proofStatus: ProofStatus;
}

export interface RecoveryOption {
  truckId: string;
  availableT: number;
  etaMinutes: number;
  distanceKm: number;
  cost: number;
  currency: string;
  compatible: boolean;
  reason: string;
}

export interface RecoveryPlan {
  id: string;
  incidentId: string;
  affectedShipmentIds: string[];
  options: RecoveryOption[];
  selectedTruckId: string | null;
  cost: number;
  etaDeltaMinutes: number;
  status: RecoveryPlanStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Payment {
  id: string;
  shipmentId: string | null;
  recoveryPlanId: string | null;
  provider: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  providerReference: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Notification {
  id: string;
  recipientId: string;
  type: string;
  message: string;
  status: 'PENDING' | 'SENT';
  createdAt: string;
}

export interface FleetSnapshot {
  generatedAt: string;
  organizations: Organization[];
  users: User[];
  drivers: Driver[];
  trucks: Truck[];
  shipments: Shipment[];
  capacityOffers: CapacityOffer[];
  incidents: Incident[];
  recoveryPlans: RecoveryPlan[];
  payments: Payment[];
  events: ShipmentEvent[];
  notifications: Notification[];
}

export interface CapacityMatch {
  offer: CapacityOffer;
  truck: Truck;
  driverName: string | null;
  route: string;
  etaLabel: string;
  estimatedPrice: number;
  currency: string;
  matchesRequestedRoute: boolean;
  fitsRequestedWeight: boolean;
  blockers: string[];
  segmentFit: 'EXACT' | 'PARTIAL' | 'NONE' | 'REVERSED' | 'UNKNOWN';
  /** Why a truck qualifies despite not matching the requested lane exactly. */
  segmentNote: string | null;
  canCarryT: number;
  spareAfterT: number | null;
  priceForRequest: number | null;
  priceForSplit: number | null;
}

export interface SplitLeg {
  truck: Truck;
  offer: CapacityOffer;
  assignedT: number;
  spareAfterT: number;
  price: number;
  segmentFit: CapacityMatch['segmentFit'];
}

/** The answer to "I have 10T and no single truck is big enough". */
export interface CapacityOptions {
  request: { origin: string | null; destination: string | null; weightT: number };
  single: CapacityMatch[];
  partial: CapacityMatch[];
  split: {
    legs: SplitLeg[];
    coveredT: number;
    uncoveredT: number;
    fullyCovered: boolean;
    totalPrice: number;
    truckCount: number;
  } | null;
  /** Plain-language reason the request cannot be served, or null. */
  impossible: string | null;
  note: string;
}

/** One row of `GET /drivers` — a driver joined to their truck and current load. */
export interface DriverRosterRow {
  id: string;
  name: string;
  phone: string;
  contact: string;
  status: 'AVAILABLE' | 'ON_JOURNEY' | 'OFF_DUTY';
  truckId: string | null;
  truckRegistrationNo: string | null;
  truckStatus: TruckStatus | null;
  capacityT: number | null;
  availableT: number | null;
  lane: string | null;
  departureAt: string | null;
  pricePerT: number | null;
  activeShipments: number;
  awaitingApproval: number;
  awaitingShipmentIds: string[];
}

export type RealtimeEventType =
  | 'connected'
  | 'demo.reset'
  | 'truck.updated'
  | 'driver.updated'
  | 'shipment.created'
  | 'shipment.updated'
  | 'load_request.opened'
  | 'load_request.accepted'
  | 'load_request.declined'
  | 'load_request.closed'
  | 'capacity.updated'
  | 'incident.created'
  | 'incident.updated'
  | 'recovery.updated'
  | 'payment.updated'
  | 'notification.created'
  | 'event.appended';

export interface RealtimeMessage {
  type: RealtimeEventType;
  payload: unknown;
  ts: string;
}

export interface DemoLoginResponse {
  ok: true;
  mode: 'demo';
  warning: string;
  user: User;
  organization: Organization | null;
  driver: Driver | null;
  availableRoles: Role[];
}
