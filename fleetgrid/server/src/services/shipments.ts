import { db } from '../store/db.js';
import { ApiError } from '../lib/errors.js';
import { canonicalLocation } from '../lib/geo.js';
import { newId, nowIso, round } from '../lib/ids.js';
import { runExclusive } from '../lib/mutex.js';
import { reserveCapacity, syncOfferForTruck } from './capacity.js';
import { assertTransition, recordEvent } from './events.js';
import { hub } from './realtime.js';
import { transitionTruck } from './trucks.js';
import { SHIPMENT_TRANSITIONS, type ActorType, type CapacityOffer, type Driver, type Notification, type Shipment, type ShipmentStatus, type Truck } from '../types.js';

export const MAX_SHIPMENT_WEIGHT_T = 50;

export async function listShipments(filter?: { status?: string; truckId?: string }): Promise<Shipment[]> {
  return db.shipments.find((s) => {
    if (filter?.status && s.status !== filter.status) return false;
    if (filter?.truckId && s.truckId !== filter.truckId) return false;
    return true;
  });
}

export async function getShipment(id: string): Promise<Shipment> {
  const shipment = await db.shipments.findById(id);
  if (!shipment) {
    throw ApiError.notFound(`Shipment ${id} does not exist.`);
  }
  return shipment;
}

/** Readable, deterministic IDs: SHP-1002, SHP-1003, ... */
async function nextShipmentId(): Promise<string> {
  const shipments = await db.shipments.get();
  const max = shipments.reduce((acc, s) => {
    const parsed = Number(s.id.replace(/^SHP-/, ''));
    return Number.isFinite(parsed) ? Math.max(acc, parsed) : acc;
  }, 1000);
  return `SHP-${max + 1}`;
}

export interface CreateShipmentInput {
  shipperId: string;
  cargoName: string;
  reference?: string | null;
  origin: string;
  destination: string;
  weightT: number;
  deadlineAt?: string | null;
  /** When present, capacity is reserved and the shipment is confirmed atomically. */
  capacityOfferId?: string | null;
  actorType?: 'BUSINESS' | 'AGENT' | 'OPERATOR';
  actorId?: string | null;
}

export interface CreateShipmentResult {
  shipment: Shipment;
  reserved: boolean;
  /**
   * False once the driver gate is in play: reserving capacity no longer confirms
   * the shipment. `POST /shipments/:id/confirm` is the driver's acceptance.
   */
  confirmed: boolean;
  /** True when the shipment is now sitting in CAPACITY_RESERVED awaiting a driver. */
  awaitingDriverApproval: boolean;
}

/**
 * POST /shipments.
 *
 * With `capacityOfferId` this creates the shipment and atomically reserves the
 * capacity in one locked step (Backend PRD §5), leaving it `CAPACITY_RESERVED`.
 * It deliberately does **not** confirm: Master PRD §6 has the driver start the
 * journey after the shipper reserves, and §7 defines `CAPACITY_RESERVED → CONFIRMED`
 * as a distinct step, so the driver accepting the load is that transition.
 *
 * Reserving without confirming is what the PRD's own API contract implies, since
 * it lists `POST /capacity/:id/reserve` separately from `POST /shipments`.
 */
export async function createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult> {
  return runExclusive(async () => {
    const shipper = await db.organizations.findById(input.shipperId);
    if (!shipper) {
      throw ApiError.badRequest(`shipperId ${input.shipperId} does not exist.`);
    }
    if (shipper.type !== 'SHIPPER') {
      throw ApiError.unprocessable(
        `Organization ${shipper.name} is a ${shipper.type}. Only a SHIPPER organization can create shipments.`,
      );
    }
    if (shipper.status !== 'ACTIVE') {
      throw ApiError.unprocessable(`Organization ${shipper.name} is ${shipper.status} and cannot create shipments.`);
    }

    const origin = canonicalLocation(input.origin);
    const destination = canonicalLocation(input.destination);
    if (!origin || !destination) {
      throw ApiError.badRequest('origin and destination are both required.');
    }
    if (origin === destination) {
      throw ApiError.unprocessable(`origin and destination are the same (${origin}). A shipment must actually move.`);
    }
    if (!Number.isFinite(input.weightT) || input.weightT <= 0) {
      throw ApiError.unprocessable(`weightT must be a positive number of tonnes (received ${input.weightT}).`);
    }
    if (input.weightT > MAX_SHIPMENT_WEIGHT_T) {
      throw ApiError.unprocessable(
        `weightT ${input.weightT}T exceeds the ${MAX_SHIPMENT_WEIGHT_T}T demo limit for a single shipment.`,
        { max: MAX_SHIPMENT_WEIGHT_T },
      );
    }
    if (!input.cargoName || input.cargoName.trim().length < 2) {
      throw ApiError.badRequest('cargoName is required (e.g. "ABC Electronics").');
    }

    const offer = input.capacityOfferId ? await db.capacityOffers.findById(input.capacityOfferId) : undefined;
    if (input.capacityOfferId && !offer) {
      throw ApiError.notFound(`Capacity offer ${input.capacityOfferId} does not exist.`);
    }

    const shipment: Shipment = {
      id: await nextShipmentId(),
      reference: input.reference?.trim() || `FG-${nowIso().slice(2, 10).replace(/-/g, '')}`,
      cargoName: input.cargoName.trim(),
      shipperId: input.shipperId,
      origin,
      destination,
      weightT: round(input.weightT),
      deadlineAt: input.deadlineAt ?? null,
      status: 'DRAFT',
      truckId: null,
      capacityOfferId: null,
      price: offer ? Math.round(offer.pricePerT * input.weightT) : 0,
      currency: 'INR',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    const created = await db.shipments.create(shipment);
    await recordEvent({
      eventType: 'shipment.created',
      shipmentId: created.id,
      payload: {
        cargoName: created.cargoName,
        weightT: created.weightT,
        origin: created.origin,
        destination: created.destination,
        shipperId: created.shipperId,
      },
      actorType: input.actorType ?? 'BUSINESS',
      actorId: input.actorId ?? null,
    });
    hub.broadcast('shipment.created', created);

    if (!offer) {
      return { shipment: created, reserved: false, confirmed: false, awaitingDriverApproval: false };
    }

    const reserved = await reserveCapacity({
      offerId: offer.id,
      shipmentId: created.id,
      actorType: input.actorType,
      actorId: input.actorId,
    });

    await recordEvent({
      eventType: 'shipment.capacity_reserved',
      shipmentId: created.id,
      truckId: reserved.truck.id,
      payload: {
        truckId: reserved.truck.id,
        weightT: created.weightT,
        availableBefore: round(reserved.truck.availableT + created.weightT),
        availableAfter: reserved.truck.availableT,
      },
      actorType: input.actorType ?? 'BUSINESS',
      actorId: input.actorId ?? null,
    });

    // Stop here on purpose. The driver has not agreed to carry this load yet, so
    // CONFIRMED would be a lie. `POST /shipments/:id/confirm` is the driver's accept.
    return {
      shipment: reserved.shipment,
      reserved: true,
      confirmed: false,
      awaitingDriverApproval: true,
    };
  });
}

/**
 * POST /shipments/:id/decline
 *
 * The driver says no. Releases the reserved tonnage back to the truck and the offer
 * so the business can re-book, and returns the shipment to DRAFT.
 *
 * Master PRD §7 has no CANCELLED state, so DRAFT is the honest resting place: the
 * shipment still exists and is still editable, it just no longer holds capacity.
 */
export async function declineShipment(
  shipmentId: string,
  input: { reason?: string | null; actorType?: ActorType; actorId?: string | null } = {},
): Promise<{ shipment: Shipment; truck: Truck | null; offer: CapacityOffer | null; notifications: Notification[] }> {
  return runExclusive(async () => {
    const shipment = await db.shipments.findById(shipmentId);
    if (!shipment) {
      throw ApiError.notFound(`Shipment ${shipmentId} does not exist.`);
    }
    if (shipment.status !== 'CAPACITY_RESERVED') {
      throw ApiError.conflict(
        `Shipment ${shipment.id} is ${shipment.status}. Only a shipment awaiting driver approval (CAPACITY_RESERVED) can be declined.`,
        { status: shipment.status },
      );
    }

    let releasedTruck: Truck | null = null;
    let releasedOffer: CapacityOffer | null = null;

    if (shipment.capacityOfferId) {
      const offer = await db.capacityOffers.findById(shipment.capacityOfferId);
      const truck = offer ? await db.trucks.findById(offer.truckId) : null;

      if (offer && truck) {
        const restored = round(truck.availableT + shipment.weightT);

        // Release the tonnage first, then decide whether the truck is free again.
        // Only go back to AVAILABLE when no other shipment still needs this truck,
        // so declining one offer cannot strand a multi-load truck in the wrong state.
        const otherLive = (await db.shipments.find((s) => s.truckId === truck.id)).filter(
          (s) => s.id !== shipment.id && ACTIVE_SHIPMENT_STATUSES.includes(s.status),
        );

        const updatedTruck = await db.trucks.update(truck.id, {
          availableT: restored,
          status: otherLive.length === 0 ? 'AVAILABLE' : truck.status,
        });
        const updatedOffer = await db.capacityOffers.update(offer.id, {
          availableT: restored,
          status: 'OPEN',
          updatedAt: nowIso(),
        });
        if (updatedTruck) {
          releasedTruck = updatedTruck;
          hub.broadcast('truck.updated', updatedTruck);
        }
        if (updatedOffer) {
          releasedOffer = updatedOffer;
          hub.broadcast('capacity.updated', updatedOffer);
        }
      }
    }

    const updated = await db.shipments.update(shipment.id, {
      status: 'DRAFT',
      truckId: null,
      capacityOfferId: null,
      updatedAt: nowIso(),
    });
    if (!updated) throw ApiError.notFound(`Shipment ${shipment.id} disappeared while declining.`);

    await recordEvent({
      shipmentId: updated.id,
      eventType: 'shipment.capacity_released',
      payload: {
        previousStatus: 'CAPACITY_RESERVED',
        status: 'DRAFT',
        releasedWeightT: shipment.weightT,
        reason: input.reason ?? 'Driver declined the offer',
      },
      actorType: input.actorType ?? 'DRIVER',
      actorId: input.actorId ?? null,
    });

    const notifications = await notifyDecline(updated, releasedTruck, input);

    return { shipment: updated, truck: releasedTruck, offer: releasedOffer, notifications };
  });
}

/**
 * Tell the requester a load is locked in.
 *
 * The mirror of `notifyDecline`. Accepting is easy to miss too: the reservation
 * flips to CONFIRMED and, without this, the person who booked finds out from a
 * table refresh rather than from a notification. Names the driver and truck, the
 * confirmed weight, and what happens next so the row is not ambiguous.
 */
async function notifyAcceptance(shipment: Shipment): Promise<Notification[]> {
  const truck = shipment.truckId ? await db.trucks.findById(shipment.truckId) : undefined;
  const driver = truck?.driverId ? await db.drivers.findById(truck.driverId) : undefined;
  const who = driver ? `${driver.name} (${truck!.id})` : truck ? truck.id : 'The driver';

  const row = await db.notifications.create({
    id: newId('ntf'),
    recipientId: shipment.shipperId,
    type: 'SHIPMENT_ACCEPTED',
    message:
      `${who} accepted ${shipment.id} (${shipment.cargoName}, ` +
      `${round(shipment.weightT)}T, ${shipment.origin}  ${shipment.destination}). ` +
      `The load is confirmed on ${truck ? truck.id : 'the truck'}` +
      `${shipment.price !== null ? ` at ${shipment.currency} ${round(shipment.price)}` : ''} - ` +
      `it is locked in and no longer competing for capacity.`,
    status: 'PENDING',
    createdAt: nowIso(),
  });

  hub.broadcast('notification.created', row);
  return [row];
}

/**
 * Tell everyone affected that a load was declined.
 *
 * A decline is the one outcome a shipper cannot see happening: their screen just
 * quietly goes back to DRAFT. The person who requested the load is notified, with
 * the driver and truck named so they know who to chase, plus what to do next. The
 * operator is notified too, because the tonnage is back on the market.
 *
 * Same shape as the recovery notifications — stored, broadcast, and never reported
 * as delivered, because delivery infrastructure is a later phase.
 */
async function notifyDecline(
  shipment: Shipment,
  truck: Truck | null,
  input: { reason?: string | null; actorType?: ActorType; actorId?: string | null },
): Promise<Notification[]> {
  const reason = input.reason?.trim() || 'No reason given';
  const rows: Notification[] = [];

  // Name the driver, not just the truck: the shipper needs to know who to chase.
  const driver = truck?.driverId ? await db.drivers.findById(truck.driverId) : undefined;
  const who = driver ? `${driver.name} (${truck!.id})` : truck ? truck.id : 'The driver';

  // The requester. This is the notification the shipper actually needs.
  rows.push(
    await db.notifications.create({
      id: newId('ntf'),
      recipientId: shipment.shipperId,
      type: 'SHIPMENT_DECLINED',
      message:
        `${who} declined ${shipment.id} (${shipment.cargoName}, ` +
        `${round(shipment.weightT)}T, ${shipment.origin} → ${shipment.destination}). ` +
        `Reason: ${reason}. Nothing is reserved and the tonnage is back on ` +
        `${truck ? truck.id : 'the truck'} — search again to rebook.`,
      status: 'PENDING',
      createdAt: nowIso(),
    }),
  );

  // The operator, so a freed truck going back on the road is visible centrally.
  if (truck) {
    rows.push(
      await db.notifications.create({
        id: newId('ntf'),
        recipientId: truck.organizationId,
        type: 'CAPACITY_DECLINED',
        message:
          `${truck.id} declined ${shipment.id} (${round(shipment.weightT)}T). ` +
          `${round(truck.availableT)}T is back on the truck and available to rebook. Reason: ${reason}.`,
        status: 'PENDING',
        createdAt: nowIso(),
      }),
    );
  }

  for (const row of rows) hub.broadcast('notification.created', row);
  return rows;
}

/**
 * CAPACITY_RESERVED → CONFIRMED.
 *
 * Now the driver acceptance gate: the client calls this from the driver view, so
 * DRIVER is the expected actor. It stays idempotent (already CONFIRMED returns the
 * shipment unchanged) and still validated against the state machine, so it cannot
 * skip the reservation step.
 */
export async function confirmShipment(
  shipmentId: string,
  actor?: { actorType?: ActorType; actorId?: string | null },
): Promise<{ shipment: Shipment; notifications: Notification[] }> {
  return runExclusive(async () => {
    const shipment = await getShipment(shipmentId);
    if (shipment.status === 'CONFIRMED') return { shipment, notifications: [] };
    assertTransition(SHIPMENT_TRANSITIONS, shipment.status, 'CONFIRMED', `Shipment ${shipment.id}`);

    const updated = await db.shipments.update(shipmentId, { status: 'CONFIRMED', updatedAt: nowIso() });
    if (!updated) throw ApiError.notFound(`Shipment ${shipmentId} disappeared during confirm.`);

    await recordEvent({
      eventType: 'shipment.confirmed',
      shipmentId: updated.id,
      truckId: updated.truckId,
      payload: { from: shipment.status, to: 'CONFIRMED', price: updated.price, currency: updated.currency },
      actorType: actor?.actorType ?? 'DRIVER',
      actorId: actor?.actorId ?? null,
    });
    hub.broadcast('shipment.updated', updated);

    // The accept side of the same promise: whoever asked for the load is told it is
    // locked in, with the truck, not left watching a reservation that never resolves.
    const notifications = await notifyAcceptance(updated);
    return { shipment: updated, notifications };
  });
}

/** Statuses that still represent cargo the truck is carrying or about to carry. */
const ACTIVE_SHIPMENT_STATUSES: ShipmentStatus[] = [
  'DRAFT',
  'CAPACITY_RESERVED',
  'CONFIRMED',
  'IN_TRANSIT',
  'AT_RISK',
  'RECOVERY',
];

export interface ConfirmDeliveryResult {
  shipment: Shipment;
  truck: Truck | null;
  /** True when this was the truck's last active shipment, so the truck also completed. */
  truckCompleted: boolean;
  /**
   * Set when the truck was left behind. Recovery execution leaves the receiving
   * truck `ASSIGNED`, and the Master PRD truck machine has no `ASSIGNED → DELIVERED`
   * edge, so the truck cannot complete here without inventing a transition. The
   * shipment is still delivered; this says plainly why the truck did not follow.
   */
  truckNote?: string;
}

/**
 * POST /shipments/:id/confirm-delivery — IN_TRANSIT → DELIVERED.
 *
 * The business is the party that confirms receipt, so the actor is BUSINESS. The
 * driver dropping the cargo is not proof of delivery, and the client is never
 * allowed to assert it: the transition is validated against the state machine here
 * and recorded as a hashed event.
 *
 * Idempotent, like `confirmShipment`: re-confirming a delivered shipment returns the
 * same row rather than a 409, so a double tap on three devices is safe.
 *
 * When this was the truck's last active shipment the truck completes too
 * (IN_TRANSIT → DELIVERED). That is a terminal state, so `npm run reset` is how the
 * demo starts a fresh run — the alternative, leaving a truck IN_TRANSIT with nothing
 * aboard, is not a state an operator would recognise.
 */
export async function confirmDelivery(
  shipmentId: string,
  actor?: { actorType?: 'BUSINESS' | 'AGENT' | 'OPERATOR'; actorId?: string | null },
): Promise<ConfirmDeliveryResult> {
  return runExclusive(async () => {
    const shipment = await getShipment(shipmentId);
    const truck = shipment.truckId ? await db.trucks.findById(shipment.truckId) : undefined;

    if (shipment.status === 'DELIVERED') {
      return {
        shipment,
        truck: truck ?? null,
        truckCompleted: truck?.status === 'DELIVERED',
        ...(truck && truck.status !== 'DELIVERED'
          ? { truckNote: `Shipment ${shipment.id} was already delivered; truck ${truck.id} is ${truck.status}.` }
          : {}),
      };
    }

    assertTransition(SHIPMENT_TRANSITIONS, shipment.status, 'DELIVERED', `Shipment ${shipment.id}`);

    const updated = await db.shipments.update(shipmentId, { status: 'DELIVERED', updatedAt: nowIso() });
    if (!updated) throw ApiError.notFound(`Shipment ${shipmentId} disappeared during delivery confirmation.`);

    await recordEvent({
      eventType: 'shipment.delivered',
      shipmentId: updated.id,
      truckId: updated.truckId,
      payload: {
        from: shipment.status,
        to: 'DELIVERED',
        destination: updated.destination,
        confirmedBy: actor?.actorType ?? 'BUSINESS',
      },
      actorType: actor?.actorType ?? 'BUSINESS',
      actorId: actor?.actorId ?? null,
    });
    hub.broadcast('shipment.updated', updated);

    if (!truck) {
      return {
        shipment: updated,
        truck: null,
        truckCompleted: false,
        truckNote: `Shipment ${updated.id} has no truck assigned, so no truck state changed.`,
      };
    }

    const stillCarrying = await db.shipments.find(
      (s) => s.truckId === truck.id && s.id !== updated.id && ACTIVE_SHIPMENT_STATUSES.includes(s.status),
    );

    if (stillCarrying.length > 0) {
      return {
        shipment: updated,
        truck,
        truckCompleted: false,
        truckNote: `Truck ${truck.id} still carries ${stillCarrying.map((s) => s.id).join(', ')}.`,
      };
    }

    if (truck.status !== 'IN_TRANSIT' && truck.status !== 'DELAYED') {
      return {
        shipment: updated,
        truck,
        truckCompleted: false,
        truckNote:
          `Truck ${truck.id} has no cargo left but is ${truck.status}, and the Master PRD truck machine ` +
          `has no ${truck.status} → DELIVERED transition. The shipment is delivered; the truck needs an ` +
          `explicit arrival to complete. Inventing that edge here would bypass the state machine.`,
      };
    }

    const completedTruck = await transitionTruck(
      truck,
      'DELIVERED',
      {},
      {
        eventType: 'truck.delivered',
        shipmentId: updated.id,
        payload: { deliveredShipmentIds: [updated.id], reason: 'All assigned cargo delivered' },
      },
    );

    return { shipment: updated, truck: completedTruck, truckCompleted: true };
  });
}

export async function setShipmentStatus(
  shipment: Shipment,
  to: ShipmentStatus,
  payload: Record<string, unknown>,
  actorType: 'SYSTEM' | 'AGENT' | 'OPERATOR' | 'DRIVER' | 'BUSINESS' = 'SYSTEM',
  actorId: string | null = null,
): Promise<Shipment> {
  assertTransition(SHIPMENT_TRANSITIONS, shipment.status, to, `Shipment ${shipment.id}`);
  const updated = await db.shipments.update(shipment.id, { status: to, updatedAt: nowIso() });
  if (!updated) throw ApiError.notFound(`Shipment ${shipment.id} disappeared during update.`);
  await recordEvent({
    eventType: `shipment.${to.toLowerCase()}`,
    shipmentId: updated.id,
    truckId: updated.truckId,
    payload: { from: shipment.status, to, ...payload },
    actorType,
    actorId,
  });
  hub.broadcast('shipment.updated', updated);
  return updated;
}

export interface DriverOffer {
  shipment: Shipment;
  truck: Truck | null;
  offer: CapacityOffer | null;
  shipperName: string | null;
  route: string;
  estimatedPay: number;
  currency: string;
  /** True while the driver still has to answer; false once it is already accepted. */
  awaitingDriver: boolean;
}

/**
 * GET /driver/offers — what a driver can currently be asked to carry.
 *
 * A read model over Shipment + CapacityOffer + Truck, not a new entity: the rows all
 * already exist, this just joins them for the driver screen. The approval gate lives
 * on `awaitingDriver`, which is true exactly when the shipment is `CAPACITY_RESERVED`
 * — the same condition `POST /shipments/:id/confirm` and `/decline` act on, so the
 * queue can never disagree with the state machine.
 */
export async function driverOffers(driverId: string): Promise<{
  driver: Driver | null;
  truck: Truck | null;
  pending: DriverOffer[];
  accepted: DriverOffer[];
}> {
  const [drivers, trucks, offers, shipments, orgs] = await Promise.all([
    db.drivers.get(),
    db.trucks.get(),
    db.capacityOffers.get(),
    db.shipments.get(),
    db.organizations.get(),
  ]);

  const driver = drivers.find((d) => d.id === driverId) ?? null;
  const truck = driver?.assignedTruckId ? trucks.find((t) => t.id === driver.assignedTruckId) ?? null : null;

  if (!truck) {
    return { driver, truck: null, pending: [], accepted: [] };
  }

  const offer = offers.find((o) => o.truckId === truck.id) ?? null;
  const mine = shipments.filter((s) => s.truckId === truck.id);

  const build = (shipment: Shipment): DriverOffer => ({
    shipment,
    truck,
    offer,
    shipperName: orgs.find((o) => o.id === shipment.shipperId)?.name ?? null,
    route: `${shipment.origin} → ${shipment.destination}`,
    estimatedPay: Math.round(shipment.weightT * (offer?.pricePerT ?? 0)),
    currency: shipment.currency,
    awaitingDriver: shipment.status === 'CAPACITY_RESERVED',
  });

  return {
    driver,
    truck,
    // Pending first: this is the queue the driver has to act on.
    pending: mine.filter((s) => s.status === 'CAPACITY_RESERVED').map(build),
    accepted: mine
      .filter((s) => s.status === 'CONFIRMED' || s.status === 'IN_TRANSIT' || s.status === 'AT_RISK')
      .map(build),
  };
}

export async function shipmentTimeline(shipmentId: string) {
  const shipment = await getShipment(shipmentId);
  const incidents = await db.incidents.find((i) => i.affectedShipmentIds.includes(shipmentId));
  const incidentIds = new Set(incidents.map((i) => i.id));

  // A shipment timeline = its own events + its truck's events + events of the
  // incidents that hit it. Each event is stored once; the timeline just links it.
  const [ownEvents, truckEvents, incidentEvents] = await Promise.all([
    db.events.find((e) => e.shipmentId === shipmentId),
    shipment.truckId ? db.events.find((e) => e.truckId === shipment.truckId) : Promise.resolve([]),
    db.events.find((e) => e.incidentId !== null && incidentIds.has(e.incidentId)),
  ]);

  const timeline = [...ownEvents, ...truckEvents, ...incidentEvents]
    .filter((event, index, all) => all.findIndex((e) => e.id === event.id) === index)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  const truck = shipment.truckId ? await db.trucks.findById(shipment.truckId) : undefined;
  const payments = await db.payments.find((p) => p.shipmentId === shipmentId);
  const recoveryPlans = await db.recoveryPlans.find((p) => p.affectedShipmentIds.includes(shipmentId));
  const notifications = await db.notifications.find((n) => n.recipientId === shipment.shipperId);

  return {
    shipment,
    truck: truck ?? null,
    events: timeline,
    incidents,
    payments,
    recoveryPlans,
    notifications,
  };
}

export interface ReleaseResult {
  truck: Truck;
  shipment: Shipment;
  releasedT: number;
}

/**
 * Releases previously reserved tonnage back to a truck and closes the offer.
 * Used by recovery execution and by any future cancellation path.
 */
export async function releaseCapacity(shipment: Shipment, reason: string): Promise<ReleaseResult> {
  if (!shipment.truckId) {
    throw ApiError.conflict(`Shipment ${shipment.id} has no truck, so there is no capacity to release.`);
  }
  const truck = await db.trucks.findById(shipment.truckId);
  if (!truck) throw ApiError.notFound(`Truck ${shipment.truckId} does not exist.`);

  const released = round(Math.min(shipment.weightT, truck.capacityT - truck.availableT));
  if (released <= 0) {
    return { truck, shipment, releasedT: 0 };
  }

  const updatedTruck = await db.trucks.update(truck.id, {
    availableT: round(truck.availableT + released),
  });
  if (!updatedTruck) throw ApiError.notFound(`Truck ${truck.id} disappeared during release.`);

  await syncOfferForTruck(updatedTruck, 'OPEN');
  await recordEvent({
    eventType: 'capacity.released',
    shipmentId: shipment.id,
    truckId: truck.id,
    payload: { releasedT: released, reason },
    actorType: 'AGENT',
  });
  hub.broadcast('truck.updated', updatedTruck);

  return { truck: updatedTruck, shipment, releasedT: released };
}
