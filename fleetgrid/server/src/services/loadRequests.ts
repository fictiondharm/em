/**
 * Broadcast load requests: one request, many drivers, first accept wins.
 *
 * The single-truck reservation in `capacity.ts` answers "book this specific truck".
 * This answers the other half of the trade: a shipper who wants *a* truck on a lane
 * and does not care which one. The request goes to every driver whose truck can
 * actually serve it, all of them hold it at once, and the first accept takes it.
 *
 * Two rules make this behave like a load board instead of a race:
 *
 * - **A decline is not a cancellation.** It removes that driver from the board and
 *   leaves the request open for whoever has not answered yet. The request only
 *   returns to DRAFT when the last driver has said no.
 * - **Accepting is a compare-and-set.** The winner is decided by re-reading the
 *   shipment inside the mutex and checking it is still `AWAITING_DRIVER`, so two
 *   drivers tapping accept at the same moment produce one winner and one honest 409,
 *   never two trucks each believing they got the load.
 */

import { db } from '../store/db.js';
import { ApiError } from '../lib/errors.js';
import { canonicalLocation, segmentFit, type SegmentFit } from '../lib/geo.js';
import { newId, nowIso, round } from '../lib/ids.js';
import { runExclusive } from '../lib/mutex.js';
import { syncOfferForTruck } from './capacity.js';
import { assertTransition, recordEvent } from './events.js';
import { hub } from './realtime.js';
import {
  SHIPMENT_TRANSITIONS,
  type ActorType,
  type Driver,
  type Notification,
  type Shipment,
  type Truck,
} from '../types.js';

/** Truck states that cannot take new work, mirroring the booking path in capacity.ts. */
const BLOCKING_TRUCK_STATES = new Set(['DELIVERED', 'INCIDENT', 'RECOVERY']);

/** Drivers who are not on duty do not get asked. */
const ASKABLE_DRIVER_STATES = new Set(['AVAILABLE', 'ON_JOURNEY']);

export interface EligibleDriver {
  driver: Driver;
  truck: Truck;
  fit: SegmentFit;
  freeT: number;
  pricePerT: number;
  /** Why this driver can or cannot take the load, in words. Never a bare false. */
  note: string;
}

export interface OpenRequestInput {
  shipperId: string;
  cargoName: string;
  origin: string;
  destination: string;
  weightT: number;
  reference?: string | null;
  deadlineAt?: string | null;
  actorId?: string | null;
  actorType?: ActorType;
}
export interface BoardEntry {
  driverId: string;
  driverName: string;
  truckId: string | null;
  /**
   * PENDING means "still holding this, can still act". Once the load is won or closed,
   * an unanswered driver is LOST rather than PENDING — leaving them PENDING on a taken
   * load would tell the shipper drivers are still competing when they are not.
   */
  response: 'PENDING' | 'DECLINED' | 'WON' | 'LOST';
  reason: string | null;
}

export interface LoadRequestBoard {
  shipment: Shipment;
  route: string;
  open: boolean;
  winner: { driverId: string; driverName: string; truckId: string } | null;
  board: BoardEntry[];
  counts: {
  /** Everyone the request was opened to. Frozen at open time. */
  asked: number;
  /** Asked, not answered, and still able to accept. */
  pending: number;
  /** Passed. */
  declined: number;
  /** Answered too late: somebody else took it first. Never able to accept again. */
  lost: number;
  /** Took the load. At most one, enforced by the accept lock. */
  won: number;
};
}

/**
 * Which drivers could take this load right now.
 *
 * Deliberately the same rules the booking path enforces, so a driver can never be
 * shown a request they would be refused at accept time: the corridor has to cover
 * pickup and delivery in that direction, the truck has to be off the blocked list,
 * the driver has to be on duty with a truck, and there has to be room for the weight.
 */
export async function eligibleDriversFor(input: {
  origin: string;
  destination: string;
  weightT: number;
}): Promise<{ eligible: EligibleDriver[]; rejected: EligibleDriver[] }> {
  const [drivers, trucks, offers] = await Promise.all([
    db.drivers.get(),
    db.trucks.get(),
    db.capacityOffers.get(),
  ]);

  const eligible: EligibleDriver[] = [];
  const rejected: EligibleDriver[] = [];

  for (const driver of drivers) {
    const truck = driver.assignedTruckId ? trucks.find((t) => t.id === driver.assignedTruckId) : undefined;
    if (!truck) continue;

    const offer = offers.find((o) => o.truckId === truck.id);
    const fit = segmentFit(truck.origin, truck.destination, input.origin, input.destination);
    const freeT = round(truck.availableT);
    const row: EligibleDriver = {
      driver,
      truck,
      fit,
      freeT,
      pricePerT: offer?.pricePerT ?? 0,
      note: '',
    };

    if (!ASKABLE_DRIVER_STATES.has(driver.status)) {
      rejected.push({ ...row, note: `${driver.name} is ${driver.status.toLowerCase().replace('_', ' ')}.` });
      continue;
    }
    if (BLOCKING_TRUCK_STATES.has(truck.status)) {
      rejected.push({ ...row, note: `Truck ${truck.id} is ${truck.status.toLowerCase()}.` });
      continue;
    }
    if (fit === 'REVERSED') {
      rejected.push({ ...row, note: `Truck ${truck.id} runs the other way.` });
      continue;
    }
    if (fit === 'NONE' || fit === 'UNKNOWN') {
      rejected.push({ ...row, note: `Truck ${truck.id} does not run ${input.origin} to ${input.destination}.` });
      continue;
    }
    if (freeT < input.weightT) {
      rejected.push({ ...row, note: `Truck ${truck.id} has only ${freeT}T free, not ${round(input.weightT)}T.` });
      continue;
    }

    eligible.push({
      ...row,
      note:
        fit === 'PARTIAL'
          ? `Passes ${input.destination} on the way to ${truck.destination}.`
          : `Runs ${truck.origin} to ${truck.destination}.`,
    });
  }

  // Cheapest tonnage first, so the board leads with the best price for the shipper.
  eligible.sort((a, b) => a.pricePerT - b.pricePerT || a.driver.name.localeCompare(b.driver.name));
  return { eligible, rejected };
}

/**
 * POST /load-requests - open a request to every driver who can take it.
 *
 * The asked list is frozen onto the shipment. Recomputing it on every read would make
 * "who was asked" drift as trucks fill up, and the honest answer to that question has
 * to be the list as it stood when the shipper hit send.
 */
export async function openLoadRequest(
  input: OpenRequestInput,
): Promise<{ shipment: Shipment; board: LoadRequestBoard; notifications: Notification[] }> {
  return runExclusive(async () => {
    const shipper = await db.organizations.findById(input.shipperId);
    if (!shipper) throw ApiError.badRequest(`shipperId ${input.shipperId} does not exist.`);
    if (shipper.type !== 'SHIPPER') {
      throw ApiError.unprocessable(`Organization ${shipper.name} is a ${shipper.type}, not a SHIPPER.`);
    }
    if (shipper.status !== 'ACTIVE') {
      throw ApiError.unprocessable(`Organization ${shipper.name} is ${shipper.status} and cannot post loads.`);
    }

    const origin = canonicalLocation(input.origin);
    const destination = canonicalLocation(input.destination);
    if (!origin || !destination) throw ApiError.badRequest('origin and destination are both required.');
    if (origin === destination) {
      throw ApiError.unprocessable(`origin and destination are the same (${origin}). A load must actually move.`);
    }
    if (!Number.isFinite(input.weightT) || input.weightT <= 0) {
      throw ApiError.unprocessable(`weightT must be a positive number of tonnes (received ${input.weightT}).`);
    }
    if (!input.cargoName || input.cargoName.trim().length < 2) {
      throw ApiError.badRequest('cargoName is required (e.g. "ABC Electronics").');
    }

    const { eligible } = await eligibleDriversFor({ origin, destination, weightT: input.weightT });
    if (eligible.length === 0) {
      // Do not open a request nobody can see. That is a dead board, not an open one.
      throw ApiError.unprocessable(
        `No driver on the network can take ${round(input.weightT)}T from ${origin} to ${destination} right now.`,
        { origin, destination, weightT: round(input.weightT) },
      );
    }

    // Price the request off the best available rate, which is what a load board shows.
    const bestPerT = Math.min(...eligible.map((e) => e.pricePerT));
    const shipment: Shipment = {
      id: await nextBroadcastId(),
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
      askedDriverIds: eligible.map((e) => e.driver.id),
      declinedDriverIds: [],
      closedReason: null,
      price: Math.round(bestPerT * input.weightT),
      currency: 'INR',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    assertTransition(SHIPMENT_TRANSITIONS, 'DRAFT', 'AWAITING_DRIVER', `Load request ${shipment.id}`);
    const created = await db.shipments.create({ ...shipment, status: 'AWAITING_DRIVER' });

    await recordEvent({
      eventType: 'shipment.created',
      shipmentId: created.id,
      payload: {
        cargoName: created.cargoName,
        weightT: created.weightT,
        origin: created.origin,
        destination: created.destination,
        shipperId: created.shipperId,
        broadcast: true,
        askedCount: created.askedDriverIds?.length ?? 0,
      },
      actorType: input.actorType ?? 'BUSINESS',
      actorId: input.actorId ?? null,
    });
    hub.broadcast('load_request.opened', created);
    hub.broadcast('shipment.created', created);

    // Every asked driver hears about it, addressed to their user so the driver tab can
    // tell nine people apart. An org-level notice could not.
    const notifications = await Promise.all(eligible.map((e) => notifyDriverOfRequest(created, e)));
    const board = await loadRequestBoard(created.id);

    return { shipment: created, board, notifications };
  });
}

/** Readable, deterministic IDs that cannot collide with the single-truck SHP- series. */
async function nextBroadcastId(): Promise<string> {
  const shipments = await db.shipments.get();
  // Highest existing + 1 rather than a count, so a deleted request cannot hand out an
  // id that is already in use.
  const highest = shipments
    .map((s) => Number.parseInt(s.id.replace(/^REQ-/, ''), 10))
    .filter((n) => Number.isFinite(n))
    .reduce((max, n) => Math.max(max, n), 0);
  return `REQ-${highest + 1}`;
}

/**
 * GET /load-requests/:id/board - who got this request and who has answered.
 *
 * This is the "who all got it" view. It is computed from the frozen asked list rather
 * than from a live search, so it keeps telling the truth after the load is taken.
 */
export async function loadRequestBoard(shipmentId: string): Promise<LoadRequestBoard> {
  const [shipment, drivers, trucks] = await Promise.all([
    db.shipments.findById(shipmentId),
    db.drivers.get(),
    db.trucks.get(),
  ]);
  if (!shipment) throw ApiError.notFound(`Load request ${shipmentId} does not exist.`);

  const asked = shipment.askedDriverIds ?? [];
  const declined = shipment.declinedDriverIds ?? [];
  const isOpen = shipment.status === 'AWAITING_DRIVER';
  const winnerId = !isOpen && shipment.truckId
    ? trucks.find((t) => t.id === shipment.truckId)?.driverId ?? null
    : null;

  const board: BoardEntry[] = asked.map((driverId) => {
    const driver = drivers.find((d) => d.id === driverId);
    const truck = driver?.assignedTruckId ? trucks.find((t) => t.id === driver.assignedTruckId) : undefined;
    const response: BoardEntry['response'] =
      winnerId === driverId
        ? 'WON'
        : declined.includes(driverId)
          ? 'DECLINED'
          : isOpen
            ? 'PENDING'
            : 'LOST';
    return {
      driverId,
      driverName: driver?.name ?? driverId,
      truckId: truck?.id ?? null,
      response,
      reason: response === 'DECLINED' ? (shipment.closedReason ?? null) : null,
    };
  });

  return {
    shipment,
    route: `${shipment.origin} → ${shipment.destination}`,
    open: isOpen,
    winner:
      winnerId && shipment.truckId
        ? {
            driverId: winnerId,
            driverName: drivers.find((d) => d.id === winnerId)?.name ?? winnerId,
            truckId: shipment.truckId,
          }
        : null,
    board,
    counts: {
      asked: board.length,
      pending: board.filter((b) => b.response === 'PENDING').length,
      declined: board.filter((b) => b.response === 'DECLINED').length,
      lost: board.filter((b) => b.response === 'LOST').length,
      won: board.filter((b) => b.response === 'WON').length,
    },
  };
}

/**
 * POST /load-requests/:id/accept - first accept takes the load.
 *
 * The winner is chosen inside the mutex by re-reading the shipment, so the loser of a
 * simultaneous accept gets a 409 naming the driver who beat them rather than a second
 * truck quietly double-booked. Tonnage is only ever deducted once, by the winner.
 */
export async function acceptLoadRequest(
  shipmentId: string,
  input: { driverId: string; actorId?: string | null },
): Promise<{ board: LoadRequestBoard; shipment: Shipment; notifications: Notification[] }> {
  return runExclusive(async () => {
    const shipment = await db.shipments.findById(shipmentId);
    if (!shipment) throw ApiError.notFound(`Load request ${shipmentId} does not exist.`);

    if (shipment.status !== 'AWAITING_DRIVER') {
      // Someone already took it. Say who, so the loser is not left guessing.
      const board = await loadRequestBoard(shipmentId);
      throw ApiError.conflict(
        board.winner
          ? `${board.winner.driverName} (${board.winner.truckId}) already took this load.`
          : `This load is ${shipment.status} and is no longer open.`,
        { status: shipment.status, winner: board.winner },
      );
    }

    const asked = shipment.askedDriverIds ?? [];
    const declined = shipment.declinedDriverIds ?? [];
    if (!asked.includes(input.driverId)) {
      throw ApiError.forbidden(`Driver ${input.driverId} was not asked to carry ${shipmentId}.`);
    }
    if (declined.includes(input.driverId)) {
      throw ApiError.conflict(`You already declined ${shipmentId}.`, { declined: true });
    }

    const driver = await db.drivers.findById(input.driverId);
    const truck = driver?.assignedTruckId ? await db.trucks.findById(driver.assignedTruckId) : undefined;
    if (!driver || !truck) {
      throw ApiError.unprocessable('That driver has no truck assigned, so they cannot take a load.');
    }

    // Re-check the physical constraints at accept time, not just at open time. A truck
    // that filled up while the request sat on the board must not be accepted.
    const fit = segmentFit(truck.origin, truck.destination, shipment.origin, shipment.destination);
    if (fit === 'REVERSED' || fit === 'NONE' || fit === 'UNKNOWN') {
      throw ApiError.unprocessable(
        `Truck ${truck.id} no longer covers ${shipment.origin} to ${shipment.destination}.`,
      );
    }
    if (truck.availableT < shipment.weightT) {
      throw ApiError.conflict(
        `Truck ${truck.id} only has ${round(truck.availableT)}T free now, not ${shipment.weightT}T.`,
        { available: round(truck.availableT), requested: shipment.weightT },
      );
    }

    // Bind the truck and take the tonnage, once.
    const offer = await syncOfferForTruck(truck);
    const updatedTruck = await db.trucks.update(truck.id, {
      availableT: round(truck.availableT - shipment.weightT),
    });
    if (updatedTruck) await syncOfferForTruck(updatedTruck);

    const updated = await db.shipments.update(shipmentId, {
      status: 'CONFIRMED',
      truckId: truck.id,
      capacityOfferId: offer?.id ?? null,
      price: offer ? Math.round(offer.pricePerT * shipment.weightT) : shipment.price,
      updatedAt: nowIso(),
    });
    if (!updated) throw ApiError.notFound(`Load request ${shipmentId} disappeared during accept.`);

    await recordEvent({
      eventType: 'load_request.accepted',
      shipmentId: updated.id,
      truckId: truck.id,
      payload: {
        driverId: driver.id,
        driverName: driver.name,
        truckId: truck.id,
        weightT: updated.weightT,
        price: updated.price,
        currency: updated.currency,
        askedCount: asked.length,
        beatDrivers: asked.filter((d) => d !== driver.id).length,
      },
      actorType: 'DRIVER',
      actorId: input.actorId ?? driver.userId,
    });
    hub.broadcast('load_request.accepted', updated);
    hub.broadcast('shipment.updated', updated);
    if (updatedTruck) hub.broadcast('truck.updated', updatedTruck);

    const notifications = await notifyOutcome(updated, driver, truck, declined, asked);
    const board = await loadRequestBoard(shipmentId);
    return { board, shipment: updated, notifications };
  });
}

/**
 * POST /load-requests/:id/decline - drop this driver, keep the load open.
 *
 * A decline only closes the request when the driver saying no was the last one still
 * holding it. Otherwise the shipper hears that one driver passed but the load is still
 * live with the rest, which is the whole point of broadcasting in the first place.
 */
export async function declineLoadRequest(
  shipmentId: string,
  input: { driverId: string; reason?: string | null; actorId?: string | null },
): Promise<{ board: LoadRequestBoard; shipment: Shipment; stillOpen: boolean; notifications: Notification[] }> {
  return runExclusive(async () => {
    const shipment = await db.shipments.findById(shipmentId);
    if (!shipment) throw ApiError.notFound(`Load request ${shipmentId} does not exist.`);
    if (shipment.status !== 'AWAITING_DRIVER') {
      throw ApiError.conflict(`This load is ${shipment.status} and can no longer be declined.`, {
        status: shipment.status,
      });
    }

    const asked = shipment.askedDriverIds ?? [];
    const declined = shipment.declinedDriverIds ?? [];
    if (!asked.includes(input.driverId)) {
      throw ApiError.forbidden(`Driver ${input.driverId} was not asked to carry ${shipmentId}.`);
    }
    if (declined.includes(input.driverId)) {
      throw ApiError.conflict(`You already declined ${shipmentId}.`, { declined: true });
    }

    const driver = await db.drivers.findById(input.driverId);
    if (!driver) throw ApiError.notFound(`Driver ${input.driverId} does not exist.`);
    const reason = input.reason?.trim() || 'No reason given';

    const nextDeclined = [...declined, input.driverId];
    const remaining = asked.filter((d) => !nextDeclined.includes(d));
    const stillOpen = remaining.length > 0;

    // Only the final decline closes the request, and the state machine is asked before
    // anything is written, not after.
    if (!stillOpen) {
      assertTransition(SHIPMENT_TRANSITIONS, 'AWAITING_DRIVER', 'DRAFT', `Load request ${shipmentId}`);
    }

    const updated = await db.shipments.update(shipmentId, {
      declinedDriverIds: nextDeclined,
      status: stillOpen ? 'AWAITING_DRIVER' : 'DRAFT',
      closedReason: stillOpen ? null : reason,
      updatedAt: nowIso(),
    });
    if (!updated) throw ApiError.notFound(`Load request ${shipmentId} disappeared during decline.`);

    await recordEvent({
      eventType: stillOpen ? 'load_request.declined' : 'load_request.closed',
      shipmentId: updated.id,
      truckId: driver.assignedTruckId,
      payload: {
        driverId: driver.id,
        driverName: driver.name,
        reason,
        stillOpen,
        remainingDrivers: remaining.length,
      },
      actorType: 'DRIVER',
      actorId: input.actorId ?? driver.userId,
    });
    hub.broadcast(stillOpen ? 'load_request.declined' : 'load_request.closed', updated);
    hub.broadcast('shipment.updated', updated);

    const notifications = await notifyDecline(updated, driver, reason, stillOpen, remaining);
    const board = await loadRequestBoard(shipmentId);
    return { board, shipment: updated, stillOpen, notifications };
  });
}

/**
 * GET /driver/requests - one driver's view of the open board.
 *
 * A driver sees every open request they were asked to carry, plus how many other
 * drivers are holding the same one, so accepting is an informed choice rather than a
 * guess. Requests they already declined are excluded; requests lost to another driver
 * are returned separately so the tab can say "taken" instead of silently dropping them.
 */
export async function driverRequests(driverId: string): Promise<{
  driver: Driver | null;
  truck: Truck | null;
  open: Array<{ shipment: Shipment; competingDrivers: number }>;
  won: Shipment[];
  lost: Array<{ shipment: Shipment; wonBy: string | null }>;
}> {
  const [drivers, trucks, shipments] = await Promise.all([db.drivers.get(), db.trucks.get(), db.shipments.get()]);

  const driver = drivers.find((d) => d.id === driverId) ?? null;
  if (!driver) return { driver: null, truck: null, open: [], won: [], lost: [] };
  const truck = driver.assignedTruckId ? trucks.find((t) => t.id === driver.assignedTruckId) ?? null : null;

  const mine = shipments.filter((s) => (s.askedDriverIds ?? []).includes(driverId));
  const declinedByMe = (s: Shipment) => (s.declinedDriverIds ?? []).includes(driverId);

  // A request is off the board once it is no longer AWAITING_DRIVER. It then went to
  // exactly one driver, identified by the truck that was bound to it.
  const RESOLVED = ['CONFIRMED', 'IN_TRANSIT', 'AT_RISK', 'DELIVERED', 'RECOVERY'];
  const resolved = (s: Shipment) => RESOLVED.includes(s.status);
  const winnerOf = (s: Shipment) => {
    if (!s.truckId) return null;
    const t = trucks.find((x) => x.id === s.truckId);
    return t?.driverId ? drivers.find((d) => d.id === t.driverId) ?? null : null;
  };
  // Only the driver who actually took it. Keying this off the shipment status alone would
  // credit every driver who was asked the moment one of them won.
  const wonByMe = (s: Shipment) => resolved(s) && winnerOf(s)?.id === driverId;

  const open = mine
    .filter((s) => s.status === 'AWAITING_DRIVER' && !declinedByMe(s))
    .map((s) => {
      const stillHolding = (s.askedDriverIds ?? []).filter((d) => !(s.declinedDriverIds ?? []).includes(d));
      return { shipment: s, competingDrivers: Math.max(0, stillHolding.length - 1) };
    });

  const won = mine.filter(wonByMe);

  // Asked, never passed, and it resolved without them. Reported rather than dropped so
  // the tab can say who beat them to it instead of the request silently disappearing.
  // A request they passed themselves is not "lost", so it is excluded.
  const lost = mine
    .filter((s) => !declinedByMe(s) && s.status !== 'AWAITING_DRIVER' && !wonByMe(s))
    .map((s) => ({ shipment: s, wonBy: winnerOf(s)?.name ?? null }));

  return { driver, truck, open, won, lost };
}

async function notifyDriverOfRequest(shipment: Shipment, e: EligibleDriver): Promise<Notification> {
  return createNotification(
    // Addressed to the driver's user, not their org: one org holds the whole fleet, so
    // an org-level notice would wake all nine drivers for a single load.
    e.driver.userId,
    'LOAD_REQUEST_OPEN',
    `New load on your lane: ${shipment.cargoName}, ${round(shipment.weightT)}T, ` +
      `${shipment.origin} → ${shipment.destination}, ${shipment.currency} ${shipment.price} ` +
      `on ${e.truck.id}. ${e.note} Accept to take it, or decline to pass.`,
  );
}

/** Tell the requester who took it, and tell the drivers who did not. */
async function notifyOutcome(
  shipment: Shipment,
  winner: Driver,
  truck: Truck,
  declined: string[],
  asked: string[],
): Promise<Notification[]> {
  const rows: Notification[] = [];

  rows.push(
    await createNotification(
      shipment.shipperId,
      'SHIPMENT_ACCEPTED',
      `${winner.name} (${truck.id}) took ${shipment.id} (${shipment.cargoName}, ` +
        `${round(shipment.weightT)}T, ${shipment.origin} → ${shipment.destination}) out of ` +
        `${asked.length} drivers who were asked. It is confirmed and no longer open.`,
    ),
  );

  // Everyone else who was asked learns the load is gone, so their tab can stop showing
  // an action that can no longer succeed.
  const losers = asked.filter((id) => id !== winner.id && !declined.includes(id));
  for (const driverId of losers) {
    const d = await db.drivers.findById(driverId);
    if (!d) continue;
    rows.push(
      await createNotification(
        d.userId,
        'LOAD_REQUEST_TAKEN',
        `${shipment.id} on ${shipment.origin} → ${shipment.destination} went to ` +
          `${winner.name} (${truck.id}) before you answered. No action needed.`,
      ),
    );
  }

  return rows;
}

async function notifyDecline(
  shipment: Shipment,
  driver: Driver,
  reason: string,
  stillOpen: boolean,
  remaining: string[],
): Promise<Notification[]> {
  const rows: Notification[] = [];

  // The requester always hears that a driver passed, and whether the load is still live.
  rows.push(
    await createNotification(
      shipment.shipperId,
      stillOpen ? 'LOAD_REQUEST_PARTIAL' : 'SHIPMENT_DECLINED',
      stillOpen
        ? `${driver.name} passed on ${shipment.id} (${round(shipment.weightT)}T, ` +
            `${shipment.origin} → ${shipment.destination}). Reason: ${reason}. ` +
            `Still open with ${remaining.length} driver${remaining.length === 1 ? '' : 's'} to answer.`
        : `Every driver passed on ${shipment.id} (${shipment.cargoName}, ` +
            `${round(shipment.weightT)}T, ${shipment.origin} → ${shipment.destination}). ` +
            `Last reason: ${reason}. Nothing is reserved - widen the route, split the load, or rebook.`,
    ),
  );

  // Drivers still holding it are told the board moved, so the count they see is current.
  for (const driverId of remaining) {
    const d = await db.drivers.findById(driverId);
    if (!d) continue;
    rows.push(
      await createNotification(
        d.userId,
        'LOAD_REQUEST_PARTIAL',
        `${driver.name} passed on ${shipment.id}. You are one of ${remaining.length} driver` +
          `${remaining.length === 1 ? '' : 's'} still holding it.`,
      ),
    );
  }

  return rows;
}

/** Store, broadcast, and never claim delivered: there is no delivery layer yet. */
async function createNotification(recipientId: string, type: string, message: string): Promise<Notification> {
  const row = await db.notifications.create({
    id: newId('ntf'),
    recipientId,
    type,
    message,
    status: 'PENDING',
    createdAt: nowIso(),
  });
  hub.broadcast('notification.created', row);
  return row;
}
