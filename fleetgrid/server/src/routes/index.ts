import { Router } from 'express';
import { authRouter } from './auth.js';
import { capacityRouter } from './capacity.js';
import { demoRouter } from './demo.js';
import { driverRouter } from './driver.js';
import { eventsRouter } from './events.js';
import { healthRouter } from './health.js';
import { incidentsRouter } from './incidents.js';
import { integrationsRouter } from './integrations.js';
import { loadRequestsRouter } from './loadRequests.js';
import { miscRouter } from './misc.js';
import { recoveryRouter } from './recovery.js';
import { shipmentsRouter } from './shipments.js';
import { trucksRouter } from './trucks.js';

export function buildRouter(): Router {
  const router = Router();

  router.use(healthRouter);
  router.use(authRouter);
  router.use(miscRouter);
  router.use(trucksRouter);
  router.use(capacityRouter);
  router.use(shipmentsRouter);
  router.use(loadRequestsRouter);
  router.use(driverRouter);
  router.use(incidentsRouter);
  router.use(recoveryRouter);
  router.use(eventsRouter);
  router.use(demoRouter);
  router.use(integrationsRouter);

  return router;
}

/** Machine-readable endpoint index for the demo team. */
export const ENDPOINT_INDEX = [
  { method: 'GET', path: '/health', purpose: 'Service health + counts' },
  { method: 'GET', path: '/state', purpose: 'Full read-only snapshot (client refetch target)' },
  { method: 'POST', path: '/auth/demo-login', purpose: 'Seeded demo role selection' },
  { method: 'POST', path: '/auth/register', purpose: 'Register as BUSINESS or DRIVER (no password/token — demo scope)' },
  { method: 'POST', path: '/demo/reset', purpose: 'Restore deterministic demo state' },
  { method: 'GET', path: '/organizations', purpose: 'List organizations' },
  { method: 'POST', path: '/organizations', purpose: 'Create organization' },
  { method: 'GET', path: '/trucks', purpose: 'List trucks' },
  { method: 'GET', path: '/trucks/:id', purpose: 'Truck detail with shipments, driver, incidents' },
  { method: 'GET', path: '/drivers', purpose: 'Full driver roster with truck, lane, spare tonnage and loads awaiting approval' },
  { method: 'POST', path: '/trucks', purpose: 'Register a truck' },
  { method: 'POST', path: '/trucks/:id/depart', purpose: 'Start journey (truck + shipments → IN_TRANSIT)' },
  { method: 'GET', path: '/capacity', purpose: 'Compatible open capacity search' },
  { method: 'GET', path: '/capacity/options', purpose: 'What can carry this load: one truck, a split across trucks, or why not' },
  { method: 'GET', path: '/capacity/nearby', purpose: 'Other trucks nearest the selected one, with real distance + spare tonnage' },
  { method: 'GET', path: '/capacity/:id', purpose: 'Capacity offer detail' },
  { method: 'POST', path: '/capacity/:id/reserve', purpose: 'Atomically reserve capacity for a DRAFT shipment' },
  { method: 'GET', path: '/shipments', purpose: 'List shipments' },
  { method: 'POST', path: '/shipments', purpose: 'Create shipment; with capacityOfferId reserves and leaves it awaiting driver approval' },
  { method: 'GET', path: '/shipments/:id', purpose: 'Shipment detail' },
  { method: 'POST', path: '/shipments/:id/confirm', purpose: 'Driver accepts: CAPACITY_RESERVED → CONFIRMED' },
  { method: 'POST', path: '/shipments/:id/decline', purpose: 'Driver declines: release tonnage, shipment → DRAFT, notify the requester' },
  { method: 'GET', path: '/shipments/:id/timeline', purpose: 'Append-only event timeline' },
  { method: 'POST', path: '/shipments/:id/confirm-delivery', purpose: 'IN_TRANSIT → DELIVERED (business confirms receipt)' },
  { method: 'GET', path: '/driver/offers', purpose: 'Driver approval queue: pending offers + accepted loads' },
  { method: 'POST', path: '/load-requests', purpose: 'Broadcast one request to every eligible driver (first accept wins)' },
  { method: 'GET', path: '/load-requests/eligible', purpose: 'Preview which drivers could take a lane and weight, and why the others cannot' },
  { method: 'GET', path: '/load-requests/:id/board', purpose: 'Who got a request, who answered, who won' },
  { method: 'POST', path: '/load-requests/:id/accept', purpose: 'Take the load; first accept binds the truck, 409 names the winner if beaten' },
  { method: 'POST', path: '/load-requests/:id/decline', purpose: 'Pass; the request stays open unless you were the last driver holding it' },
  { method: 'GET', path: '/driver/requests', purpose: 'One driver view of the open board, with how many others are still holding each request' },
  { method: 'GET', path: '/incidents', purpose: 'List incidents' },
  { method: 'POST', path: '/incidents', purpose: 'Report incident (truck → INCIDENT, shipment → AT_RISK)' },
  { method: 'GET', path: '/incidents/:id', purpose: 'Incident detail' },
  { method: 'GET', path: '/incidents/:id/recovery-options', purpose: 'Deterministic recovery option preview' },
  { method: 'POST', path: '/recovery-plans', purpose: 'Create plan in PENDING_APPROVAL' },
  { method: 'GET', path: '/recovery-plans', purpose: 'List plans' },
  { method: 'GET', path: '/recovery-plans/:id', purpose: 'Plan detail' },
  { method: 'POST', path: '/recovery-plans/:id/approve', purpose: 'Operator approval gate' },
  { method: 'POST', path: '/recovery-plans/:id/reject', purpose: 'Reject plan' },
  { method: 'POST', path: '/recovery-plans/:id/execute', purpose: 'Execute APPROVED plan (idempotent)' },
  { method: 'GET', path: '/events', purpose: 'Event log' },
  { method: 'POST', path: '/events', purpose: 'Append an event' },
  { method: 'GET', path: '/agent/tools', purpose: 'Agent tool contract + JSON Schema' },
  { method: 'GET', path: '/payments', purpose: 'Payments placeholder read model' },
  { method: 'POST', path: '/payments/create', purpose: 'Create payment intent (501 — Dodo not connected)' },
  { method: 'POST', path: '/webhooks/dodo', purpose: 'Dodo payment webhook (501 — Dodo not connected)' },
  { method: 'POST', path: '/proof/anchor', purpose: 'Anchor event hash on EVM testnet (501 — not configured)' },
  { method: 'GET', path: '/notifications', purpose: 'Notification placeholder read model' },
  { method: 'WS', path: '/realtime', purpose: 'Realtime state/events' },
] as const;
