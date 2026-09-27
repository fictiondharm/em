/**
 * Presentation mapping for status → colour. Single source of truth for the UI so
 * truck, shipment, incident and plan states stay visually consistent.
 */
import type { IncidentStatus, RecoveryPlanStatus, ShipmentStatus, TruckStatus } from './types';

export type Tone = 'healthy' | 'warn' | 'danger' | 'accent' | 'neutral';

const TRUCK_TONE: Record<TruckStatus, Tone> = {
  AVAILABLE: 'healthy',
  ASSIGNED: 'accent',
  LOADING: 'accent',
  IN_TRANSIT: 'accent',
  DELIVERED: 'neutral',
  DELAYED: 'warn',
  INCIDENT: 'danger',
  RECOVERY: 'warn',
};

const SHIPMENT_TONE: Record<ShipmentStatus, Tone> = {
  DRAFT: 'neutral',
  // Live on the board with drivers, waiting for the first accept. Blue, not green:
  // nothing is secured yet, so it must not read like a completed booking.
  AWAITING_DRIVER: 'accent',
  CAPACITY_RESERVED: 'accent',
  CONFIRMED: 'accent',
  IN_TRANSIT: 'accent',
  AT_RISK: 'danger',
  RECOVERY: 'warn',
  DELIVERED: 'healthy',
};

const INCIDENT_TONE: Record<IncidentStatus, Tone> = {
  OPEN: 'danger',
  ANALYZING: 'warn',
  PLAN_READY: 'warn',
  RESOLVED: 'healthy',
  ESCALATED: 'danger',
};

const PLAN_TONE: Record<RecoveryPlanStatus, Tone> = {
  DRAFT: 'neutral',
  PROPOSED: 'accent',
  PENDING_APPROVAL: 'warn',
  APPROVED: 'healthy',
  EXECUTING: 'accent',
  COMPLETED: 'healthy',
  REJECTED: 'danger',
};

export const truckTone = (s: TruckStatus): Tone => TRUCK_TONE[s] ?? 'neutral';
export const shipmentTone = (s: ShipmentStatus): Tone => SHIPMENT_TONE[s] ?? 'neutral';
export const incidentTone = (s: IncidentStatus): Tone => INCIDENT_TONE[s] ?? 'neutral';
export const planTone = (s: RecoveryPlanStatus): Tone => PLAN_TONE[s] ?? 'neutral';

export const incidentTypeLabel: Record<string, string> = {
  TRUCK_BREAKDOWN: 'Truck Breakdown',
  ACCIDENT: 'Accident',
  DELAY: 'Delay',
  CARGO_DAMAGE: 'Cargo Damage',
  ROUTE_BLOCKED: 'Route Blocked',
  OTHER: 'Other',
};
