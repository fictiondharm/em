/**
 * FleetGrid domain types.
 *
 * Source of truth: 01_FleetGrid_Master_PRD.docx §10 (Core Database Schema) and §7 (State Machines).
 * The web client keeps a mirrored copy in `web/src/lib/types.ts` because the browser build
 * does not compile server code. The server remains authoritative.
 */

export type Role = 'CONTROL_TOWER' | 'BUSINESS' | 'DRIVER' | 'OPERATOR' | 'VERIFIER';

export type OrganizationType = 'SHIPPER' | 'FLEET_OPERATOR';
export type OrganizationStatus = 'ACTIVE' | 'SUSPENDED';

/** Master PRD §7 — Truck state machine. */
export type TruckStatus =
  | 'AVAILABLE'
  | 'ASSIGNED'
  | 'LOADING'
  | 'IN_TRANSIT'
  | 'DELIVERED'
  | 'DELAYED'
  | 'INCIDENT'
  | 'RECOVERY';

/** Master PRD §7 — Shipment state machine. (Exactly the states the Master PRD defines.) */
export type ShipmentStatus =
  | 'DRAFT'
  | 'AWAITING_DRIVER'
  | 'CAPACITY_RESERVED'
  | 'CONFIRMED'
  | 'IN_TRANSIT'
  | 'AT_RISK'
  | 'RECOVERY'
  | 'DELIVERED';

/** Master PRD §7 — Payment state machine. */
export type PaymentStatus = 'CREATED' | 'PENDING' | 'PAID' | 'FAILED';

/** Master PRD §7 — RecoveryPlan state machine. */
export type RecoveryPlanStatus =
  | 'DRAFT'
  | 'PROPOSED'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'EXECUTING'
  | 'COMPLETED'
  | 'REJECTED';

/** Master PRD §7 — Incident state machine. */
export type IncidentStatus = 'OPEN' | 'ANALYZING' | 'PLAN_READY' | 'RESOLVED' | 'ESCALATED';

export type IncidentType =
  | 'TRUCK_BREAKDOWN'
  | 'ACCIDENT'
  | 'DELAY'
  | 'CARGO_DAMAGE'
  | 'ROUTE_BLOCKED'
  | 'OTHER';

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type CapacityOfferStatus = 'OPEN' | 'HELD' | 'CLOSED';

/** Master PRD §9 — proof must never be faked. `NOT_ANCHORED` is the honest pre-anchor state. */
export type ProofStatus = 'NOT_ANCHORED' | 'PENDING' | 'CONFIRMED' | 'FAILED';

export type ActorType = 'SYSTEM' | 'AGENT' | 'OPERATOR' | 'DRIVER' | 'BUSINESS';

export interface Organization {
  id: string;
  name: string;
  type: OrganizationType;
  status: OrganizationStatus;
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
  /**
   * Broadcast requests only. Every driver who was asked to carry this load when it
   * opened, frozen at open time so "who got this request" stays answerable after the
   * fact instead of shifting as trucks come and go. Empty for a single-truck
   * reservation, where the driver is implied by `truckId`.
   *
   * Optional because a data dir written before broadcast requests existed has no such
   * field; `POST /demo/reset` rewrites it. Read them as `shipment.askedDriverIds ?? []`.
   */
  askedDriverIds?: string[];
  /**
   * Broadcast requests only. Drivers who have said no. A decline removes that driver
   * from the board; it does not close the request while others are still holding it.
   */
  declinedDriverIds?: string[];
  /** Why the last remaining driver declined, when that closed the request. */
  closedReason?: string | null;
  price: number;
  currency: string;
  createdAt: string;
  updatedAt: string;
}

export interface CapacityOffer {
  id: string;
  truckId: string;
  route: string;
  origin: string;
  destination: string;
  availableT: number;
  departureAt: string | null;
  status: CapacityOfferStatus;
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
  actorType: ActorType;
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

/** Placeholder only — real payment provider lands in a later phase (Dodo Payments). */
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

/** Placeholder only — production notification infrastructure is a later phase. */
export interface Notification {
  id: string;
  recipientId: string;
  type: string;
  message: string;
  status: 'PENDING' | 'SENT';
  createdAt: string;
}

/** Canonical realtime envelope pushed over `WS /realtime`. */
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

export const TRUCK_TRANSITIONS: Record<TruckStatus, TruckStatus[]> = {
  AVAILABLE: ['ASSIGNED', 'DELAYED'],
  ASSIGNED: ['LOADING', 'AVAILABLE', 'IN_TRANSIT', 'DELAYED', 'INCIDENT'],
  LOADING: ['IN_TRANSIT', 'DELAYED', 'INCIDENT'],
  IN_TRANSIT: ['DELIVERED', 'DELAYED', 'INCIDENT'],
  DELAYED: ['IN_TRANSIT', 'INCIDENT', 'DELIVERED'],
  INCIDENT: ['RECOVERY', 'IN_TRANSIT'],
  RECOVERY: ['AVAILABLE', 'IN_TRANSIT', 'INCIDENT'],
  DELIVERED: [],
};

export const SHIPMENT_TRANSITIONS: Record<ShipmentStatus, ShipmentStatus[]> = {
  // A broadcast request can be opened from DRAFT, or a single-truck reservation can
  // still go straight to CAPACITY_RESERVED. AWAITING_DRIVER is the open board: many
  // drivers hold it, the first accept binds a truck and confirms, and it returns to
  // DRAFT only when the last driver has declined.
  DRAFT: ['AWAITING_DRIVER', 'CAPACITY_RESERVED'],
  AWAITING_DRIVER: ['CONFIRMED', 'DRAFT'],
  CAPACITY_RESERVED: ['CONFIRMED', 'AT_RISK'],
  CONFIRMED: ['IN_TRANSIT', 'AT_RISK'],
  IN_TRANSIT: ['AT_RISK', 'DELIVERED'],
  AT_RISK: ['RECOVERY', 'DELIVERED'],
  RECOVERY: ['IN_TRANSIT', 'AT_RISK'],
  DELIVERED: [],
};

export const INCIDENT_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  OPEN: ['ANALYZING', 'ESCALATED', 'RESOLVED'],
  ANALYZING: ['PLAN_READY', 'ESCALATED', 'RESOLVED'],
  PLAN_READY: ['RESOLVED', 'ESCALATED'],
  ESCALATED: ['ANALYZING', 'RESOLVED'],
  RESOLVED: [],
};

export const RECOVERY_PLAN_TRANSITIONS: Record<RecoveryPlanStatus, RecoveryPlanStatus[]> = {
  DRAFT: ['PROPOSED'],
  PROPOSED: ['PENDING_APPROVAL', 'DRAFT'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED'],
  APPROVED: ['EXECUTING', 'REJECTED'],
  EXECUTING: ['COMPLETED', 'APPROVED'],
  COMPLETED: [],
  REJECTED: ['DRAFT'],
};

export const PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  CREATED: ['PENDING', 'FAILED'],
  PENDING: ['PAID', 'FAILED'],
  PAID: [],
  FAILED: ['PENDING'],
};
