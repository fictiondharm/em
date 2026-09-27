/**
 * End-to-end check of the golden demo flow, run against a live server.
 *
 *   npm run dev --prefix server      (terminal 1)
 *   npm test  --prefix server        (terminal 2)
 *
 * Verifies: seed determinism, capacity reservation arithmetic, state machine
 * transitions, incident handling, the approval gate, and that TWO independent
 * realtime clients both observe the same server-authoritative state.
 */
import WebSocket from 'ws';

const BASE = process.env.TEST_API_URL ?? 'http://localhost:4000';
const WS_URL = BASE.replace(/^http/, 'ws') + '/realtime';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}`);
    if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

async function api<T = any>(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body: body as T };
}

class RealtimeClient {
  readonly name: string;
  readonly events: Array<{ type: string; payload: any }> = [];
  private socket: WebSocket;
  connected = false;

  constructor(name: string) {
    this.name = name;
    this.socket = new WebSocket(WS_URL);
    this.socket.on('open', () => {
      this.connected = true;
    });
    this.socket.on('message', (raw) => {
      try {
        const parsed = JSON.parse(raw.toString()) as { type: string; payload: unknown };
        this.events.push({ type: parsed.type, payload: parsed.payload });
      } catch {
        /* ignore */
      }
    });
  }

  types(): string[] {
    return this.events.map((e) => e.type);
  }

  lastOfType(type: string): any | undefined {
    return [...this.events].reverse().find((e) => e.type === type)?.payload;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.socket.readyState === WebSocket.CLOSED) return resolve();
      this.socket.once('close', () => resolve());
      this.socket.close();
    });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log(`FleetGrid end-to-end flow test → ${BASE}`);

  section('1. Health + demo reset');
  const health = await api('/health');
  check('GET /health returns ok', health.status === 200 && health.body.status === 'ok', health.body);

  const reset = await api('/demo/reset', { method: 'POST' });
  check('POST /demo/reset succeeds', reset.status === 200, reset.body);

  const resetAgain = await api('/demo/reset', { method: 'POST' });
  check('POST /demo/reset is repeatable', resetAgain.status === 200, resetAgain.body);

  section('2. Deterministic seed');
  const trucks = await api('/trucks');
  const seedOffers = (await api('/capacity?includeAll=true')).body.matches.map((m: any) => m.offer);
  const byId = new Map<string, any>(trucks.body.trucks.map((t: any) => [t.id, t]));
  check('FG-027 exists', byId.has('FG-027'));
  check('FG-027 is 5.0T capacity / 3.8T spare / AVAILABLE',
    byId.get('FG-027')?.capacityT === 5 && byId.get('FG-027')?.availableT === 3.8 && byId.get('FG-027')?.status === 'AVAILABLE',
    byId.get('FG-027'));
  check('FG-041 is 5.0T capacity / 3.1T spare', byId.get('FG-041')?.availableT === 3.1);
  check('FG-052 is 8.0T capacity / 5.0T spare', byId.get('FG-052')?.availableT === 5);
  check('The network runs more than one lane',
    new Set(trucks.body.trucks.map((t: any) => `${t.origin}->${t.destination}`)).size >= 3,
    [...new Set(trucks.body.trucks.map((t: any) => `${t.origin}->${t.destination}`))]);
  check('Every truck publishes a capacity offer on its own lane',
    trucks.body.trucks.every((t: any) => seedOffers.some((o: any) =>
      o.truckId === t.id && o.origin === t.origin && o.destination === t.destination)),
    'a truck without a matching offer would be invisible to Business');
  check('Shorter lanes are priced below the full run',
    seedOffers.find((o: any) => o.truckId === 'FG-058')?.pricePerT <
      seedOffers.find((o: any) => o.truckId === 'FG-027')?.pricePerT,
    'Bengaluru → Hosur should cost less per tonne than Bengaluru → Chennai');

  const state1 = await api('/state');
  const demoLogin = await api('/auth/demo-login', {
    method: 'POST',
    body: JSON.stringify({ role: 'BUSINESS' }),
  });
  check('Demo login returns ABC Distributors for BUSINESS',
    demoLogin.status === 200 && demoLogin.body.organization?.name === 'ABC Distributors', demoLogin.body);
  const shipperId = demoLogin.body.organization.id;

  const driverLogin = await api('/auth/demo-login', { method: 'POST', body: JSON.stringify({ role: 'DRIVER' }) });
  check('Demo login returns Ravi Kumar on FG-027',
    driverLogin.body.user?.name === 'Ravi Kumar' && driverLogin.body.driver?.assignedTruckId === 'FG-027',
    driverLogin.body);
  const driverId = driverLogin.body.driver.id;

  section('3. Two realtime clients connect (Business laptop + Control Tower)');
  const tower = new RealtimeClient('control-tower');
  const business = new RealtimeClient('business');
  await sleep(400);
  check('Control Tower client connected', tower.connected);
  check('Business client connected', business.connected);
  check('Server accepted the hello frame', tower.types().includes('connected'));

  section('4. Business finds compatible capacity');
  const capacity = await api('/capacity?origin=Bengaluru&destination=Chennai&weightT=1');
  // Five trucks now run the main lane; the Bengaluru → Hosur, Hosur → Chennai and
  // Krishnagiri → Chennai trucks must NOT match a full-length run.
  check('GET /capacity returns 6 compatible offers on the main lane', capacity.body.count === 6, capacity.body.count);
  check('No off-lane truck leaks into a full-length run',
    capacity.body.matches.every((m: any) => m.route === 'Bengaluru → Chennai'), capacity.body.matches.map((m: any) => m.route));
  const fg027 = capacity.body.matches.find((m: any) => m.truck.id === 'FG-027');
  check('FG-027 offered at 3.8T spare on Bengaluru → Chennai',
    fg027?.truck.availableT === 3.8 && fg027?.route === 'Bengaluru → Chennai', fg027);
  check('A 1T request is priced on the requested tonnage, not all spare capacity',
    fg027?.priceForRequest === 850 && fg027?.estimatedPrice === 3230, { req: fg027?.priceForRequest, all: fg027?.estimatedPrice });

  section('4b. Half-route and split-load matching');
  const half = await api('/capacity/options?origin=Bengaluru&destination=Hosur&weightT=4');
  const halfIds = half.body.single.map((m: any) => m.truck.id);
  check('Bengaluru → Hosur is served by a Bengaluru → Hosur truck (exact)',
    half.body.single.some((m: any) => m.segmentFit === 'EXACT' && m.truck.id === 'FG-058'), halfIds);
  check('Bengaluru → Hosur is also served by main-lane trucks passing through (partial)',
    half.body.single.some((m: any) => m.segmentFit === 'PARTIAL' && m.truck.id === 'FG-052'), halfIds);
  check('A half-route request is cheaper than the same weight on the full lane',
    half.body.single.find((m: any) => m.truck.id === 'FG-058')?.priceForRequest === 1360,
    half.body.single.find((m: any) => m.truck.id === 'FG-058'));
  check('No split is offered when a single truck already covers the load', half.body.split === null, half.body.split);
  check('A Bengaluru → Hosur truck is not offered on a Hosur → Chennai request',
    !(await api('/capacity/options?origin=Hosur&destination=Chennai&weightT=4')).body.single.some((m: any) => m.truck.id === 'FG-058'),
    'FG-058 must not appear on the second half');

  const big = await api('/capacity/options?origin=Bengaluru&destination=Chennai&weightT=10');
  check('A 10T request matches no single truck', big.body.single.length === 0, big.body.single.length);
  check('A 10T request returns a concrete split plan instead of nothing', big.body.split !== null, big.body);
  check('The split plan covers the full 10T',
    big.body.split?.coveredT === 10 && big.body.split?.uncoveredT === 0 && big.body.split?.fullyCovered === true, big.body.split);
  check('The split uses the fewest trucks possible', big.body.split?.truckCount === 2, big.body.split?.truckCount);
  check('Split legs sum to the requested weight',
    Math.round(big.body.split.legs.reduce((s: number, l: any) => s + l.assignedT, 0)) === 10,
    big.body.split.legs.map((l: any) => [l.truck.id, l.assignedT]));
  check('No leg is assigned more than the truck actually has spare',
    big.body.split.legs.every((l: any) => l.assignedT <= l.truck.availableT && l.assignedT > 0), big.body.split.legs);
  check('An impossible request says so in plain words',
    (await api('/capacity/options?origin=Bengaluru&destination=Hosur&weightT=99')).body.impossible !== null,
    (await api('/capacity/options?origin=Bengaluru&destination=Hosur&weightT=99')).body);

  section('4a. The whole driver roster');
  const roster = await api('/drivers');
  check('GET /drivers returns every seeded driver', roster.body.drivers.length === 9, roster.body.drivers.length);
  check('Each driver is joined to their truck and lane',
    roster.body.drivers.every((d: any) => d.truckId && d.lane && typeof d.lane === 'string'),
    roster.body.drivers.filter((d: any) => !d.lane).map((d: any) => d.name));
  check('The roster shows real lanes, not one lane for everyone',
    new Set(roster.body.drivers.map((d: any) => d.lane)).size >= 4,
    [...new Set(roster.body.drivers.map((d: any) => d.lane))]);
  check('Spare tonnage and capacity are both reported per driver',
    roster.body.drivers.every((d: any) => d.availableT !== null && d.capacityT !== null && d.availableT <= d.capacityT),
    roster.body.drivers.map((d: any) => [d.truckId, d.availableT, d.capacityT]));
  check('Roster counts agree with the rows',
    roster.body.counts.total === roster.body.drivers.length &&
      roster.body.counts.onATruck === roster.body.drivers.filter((d: any) => d.truckId).length,
    roster.body.counts);
  check('Ravi Kumar is one of many, not the only driver',
    roster.body.drivers.some((d: any) => d.name === 'Ravi Kumar') && roster.body.drivers.length > 1,
    roster.body.drivers.map((d: any) => d.name));

  // Search and booking must agree. Booking a half-route load on a truck that is
  // passing through used to fail with a route-mismatch error after the UI had
  // already offered that truck.
  const halfShipper = (await api('/auth/demo-login', { method: 'POST', body: JSON.stringify({ role: 'BUSINESS' }) }))
    .body.organization.id;
  const halfBooked = await api('/shipments', {
    method: 'POST',
    body: JSON.stringify({
      shipperId: halfShipper,
      cargoName: 'Half Route Electronics',
      origin: 'Bengaluru',
      destination: 'Hosur',
      weightT: 4,
      capacityOfferId: half.body.single.find((m: any) => m.segmentFit === 'PARTIAL').offer.id,
    }),
  });
  check('A half-route load books on a passing truck', halfBooked.status === 201, halfBooked.body);
  check('The shipment keeps the requested drop-off, not the truck lane',
    halfBooked.body?.shipment?.destination === 'Hosur', halfBooked.body?.shipment);
  check('A half-route booking still waits for driver approval',
    halfBooked.body?.shipment?.status === 'CAPACITY_RESERVED' && halfBooked.body?.awaitingDriverApproval === true,
    halfBooked.body);

  const reversed = await api('/shipments', {
    method: 'POST',
    body: JSON.stringify({
      shipperId: halfShipper,
      cargoName: 'Wrong Way',
      origin: 'Chennai',
      destination: 'Bengaluru',
      weightT: 1,
      capacityOfferId: half.body.single[0].offer.id,
    }),
  });
  check('A reversed route is refused with a reason', reversed.status === 422 && /other way/.test(JSON.stringify(reversed.body)),
    { status: reversed.status, body: reversed.body });

  const offLane = await api('/shipments', {
    method: 'POST',
    body: JSON.stringify({
      shipperId: halfShipper,
      cargoName: 'Nowhere Lane',
      origin: 'Hosur',
      destination: 'Bengaluru',
      weightT: 1,
      capacityOfferId: 'cap_fg058',
    }),
  });
  check('A truck booked for one leg cannot be forced onto an uncovered leg',
    offLane.status === 422, { status: offLane.status, body: offLane.body });

  section('5. Validation rejects bad input');
  const badWeight = await api('/shipments', {
    method: 'POST',
    body: JSON.stringify({ shipperId, cargoName: 'Bad', origin: 'Bengaluru', destination: 'Chennai', weightT: 0 }),
  });
  check('Zero weight is rejected with 400', badWeight.status === 400, badWeight.body);

  const unknownTruck = await api('/trucks/FG-999/depart', { method: 'POST', body: JSON.stringify({}) });
  check('Departing a non-existent truck returns 404', unknownTruck.status === 404, unknownTruck.body);

  const unknownIncident = await api('/incidents', {
    method: 'POST',
    body: JSON.stringify({ truckId: 'FG-999', type: 'TRUCK_BREAKDOWN', location: 'Hosur' }),
  });
  check('Incident for a non-existent truck returns 404', unknownIncident.status === 404, unknownIncident.body);

  const oversell = await api('/shipments', {
    method: 'POST',
    body: JSON.stringify({
      shipperId,
      cargoName: 'Too Heavy',
      origin: 'Bengaluru',
      destination: 'Chennai',
      weightT: 99,
      capacityOfferId: fg027.offer.id,
    }),
  });
  check('Weight above the demo limit is rejected', oversell.status === 400, oversell.body);

  const tooMuch = await api('/shipments', {
    method: 'POST',
    body: JSON.stringify({
      shipperId,
      cargoName: 'Too Heavy',
      origin: 'Bengaluru',
      destination: 'Chennai',
      weightT: 4.5,
      capacityOfferId: fg027.offer.id,
    }),
  });
  check('Reserving 4.5T on a 3.8T truck is rejected with 422', tooMuch.status === 422, tooMuch.body);

  const wrongRoute = await api('/shipments', {
    method: 'POST',
    body: JSON.stringify({
      shipperId,
      cargoName: 'Wrong Route',
      origin: 'Mysuru',
      destination: 'Chennai',
      weightT: 1,
      capacityOfferId: fg027.offer.id,
    }),
  });
  check('Mismatched pickup city is rejected with 422', wrongRoute.status === 422, wrongRoute.body);

  section('6. Business reserves capacity, then the driver approves it');
  const created = await api('/shipments', {
    method: 'POST',
    body: JSON.stringify({
      shipperId,
      cargoName: 'ABC Electronics',
      origin: 'Bengaluru',
      destination: 'Chennai',
      weightT: 1,
      actorId: demoLogin.body.user.id,
      capacityOfferId: fg027.offer.id,
    }),
  });
  check('POST /shipments returns 201', created.status === 201, created.body);
  const shipmentId = created.body.shipment?.id as string;
  check('Reserving leaves the shipment CAPACITY_RESERVED, not CONFIRMED',
    created.body.shipment?.status === 'CAPACITY_RESERVED', created.body.shipment);
  check('The response says it is waiting on the driver',
    created.body.awaitingDriverApproval === true && created.body.confirmed === false, created.body);
  check('Shipment is on FG-027', created.body.shipment?.truckId === 'FG-027');
  check('Shipment price is 850 INR for 1T', created.body.shipment?.price === 850, created.body.shipment);

  await sleep(300);
  const afterReserve = await api('/trucks/FG-027');
  check('FG-027 spare capacity dropped 3.8T → 2.8T', afterReserve.body.truck.availableT === 2.8, afterReserve.body.truck);
  check('FG-027 is now ASSIGNED', afterReserve.body.truck.status === 'ASSIGNED', afterReserve.body.truck);
  check('FG-027 capacity offer shows 2.8T', afterReserve.body.capacityOffer?.availableT === 2.8, afterReserve.body.capacityOffer);

  check('Control Tower received shipment.created', tower.types().includes('shipment.created'), tower.types());
  check('Control Tower received truck.updated', tower.types().includes('truck.updated'), tower.types());
  check('Control Tower received capacity.updated', tower.types().includes('capacity.updated'), tower.types());
  check('Control Tower saw the reserved shipment',
    tower.lastOfType('shipment.updated')?.id === shipmentId, tower.lastOfType('shipment.updated'));

  // The approval gate: the driver has to say yes before anything is confirmed.
  const offers = await api(`/driver/offers?driverId=${driverId}`);
  check('The driver queue lists the reserved shipment as pending',
    offers.body.counts?.pending === 1 && offers.body.pending?.[0]?.shipment?.id === shipmentId, offers.body);
  check('The queue marks it awaiting the driver',
    offers.body.pending?.[0]?.awaitingDriver === true, offers.body.pending?.[0]);
  check('The driver is not told the load is already accepted',
    offers.body.counts?.accepted === 0, offers.body.counts);

  const departTooEarly = await api('/trucks/FG-027/depart', { method: 'POST', body: JSON.stringify({ driverId }) });
  check('The truck cannot depart before the driver accepts the load',
    departTooEarly.status === 409, departTooEarly.body);

  const accepted = await api(`/shipments/${shipmentId}/confirm`, { method: 'POST' });
  check('The driver accepting returns 200', accepted.status === 200, accepted.body);
  check('Accepting confirms the shipment', accepted.body.shipment?.status === 'CONFIRMED', accepted.body.shipment);
  check('The acceptance is attributed to the DRIVER', accepted.body.acceptedBy === 'DRIVER', accepted.body);

  // The accept side of the same promise as the decline notice: the requester is
  // told the load is locked in, rather than finding out from a silent table refresh.
  const acceptNote = (accepted.body.notifications as any[])?.[0];
  check('Accepting notifies the requester',
    acceptNote?.type === 'SHIPMENT_ACCEPTED' && acceptNote?.recipientId === shipperId,
    accepted.body.notifications);
  check('The acceptance notice names the driver and truck',
    acceptNote?.message?.includes('Ravi Kumar') && acceptNote?.message?.includes('FG-027'),
    acceptNote?.message);
  check('The acceptance notice says the load is confirmed and not up for grabs',
    /confirmed/i.test(acceptNote?.message ?? '') && /no longer competing/i.test(acceptNote?.message ?? ''),
    acceptNote?.message);
  check('Accepting is not reported as a delivery',
    acceptNote?.status === 'PENDING', acceptNote?.status);

  const acceptTwice = await api(`/shipments/${shipmentId}/confirm`, { method: 'POST' });
  check('Accepting twice is idempotent and does not re-notify',
    acceptTwice.status === 200 && (acceptTwice.body.notifications ?? []).length === 0,
    acceptTwice.body);
  const noticesForShipment = (await api('/notifications')).body.notifications
    .filter((n: any) => n.recipientId === shipperId && n.message.includes(shipmentId));
  check('The requester has exactly one acceptance notice for this load',
    noticesForShipment.filter((n: any) => n.type === 'SHIPMENT_ACCEPTED').length === 1,
    noticesForShipment.map((n: any) => n.type));

  await sleep(300);
  const offersAfter = await api(`/driver/offers?driverId=${driverId}`);
  check('The queue moves the shipment from pending to accepted',
    offersAfter.body.counts?.pending === 0 && offersAfter.body.counts?.accepted === 1, offersAfter.body.counts);

  section('6b. A driver can decline, and the tonnage goes back');
  const declined = await api('/shipments', {
    method: 'POST',
    body: JSON.stringify({
      shipperId,
      cargoName: 'ABC Electronics (second load)',
      origin: 'Bengaluru',
      destination: 'Chennai',
      weightT: 0.5,
      actorId: demoLogin.body.user.id,
      capacityOfferId: fg027.offer.id,
    }),
  });
  const declinedId = declined.body.shipment?.id as string;
  check('A second 0.5T load also waits for approval',
    declined.body.shipment?.status === 'CAPACITY_RESERVED', declined.body.shipment);

  const spareBeforeDecline = (await api('/trucks/FG-027')).body.truck.availableT;
  const declinedRes = await api(`/shipments/${declinedId}/decline`, {
    method: 'POST',
    body: JSON.stringify({ reason: 'Already full near Hosur', actorId: driverId }),
  });
  check('Declining returns 200', declinedRes.status === 200, declinedRes.body);
  check('A declined shipment returns to DRAFT', declinedRes.body.shipment?.status === 'DRAFT', declinedRes.body.shipment);
  check('A declined shipment is no longer on a truck', declinedRes.body.shipment?.truckId === null, declinedRes.body.shipment);
  const spareAfterDecline = (await api('/trucks/FG-027')).body.truck.availableT;
  check('Declining gives the tonnage back', spareAfterDecline === spareBeforeDecline + 0.5,
    { spareBeforeDecline, spareAfterDecline });

  // A decline is the one outcome a shipper cannot see happening, so the requester
  // has to be told. Without this the load just quietly went back to DRAFT.
  const declineNotifications = declinedRes.body.notifications as any[];
  check('Declining notifies the person who requested the load',
    Array.isArray(declineNotifications) &&
      declineNotifications.some((n) => n.type === 'SHIPMENT_DECLINED' && n.recipientId === shipperId),
    declineNotifications);
  const shipperNotice = declineNotifications.find((n) => n.type === 'SHIPMENT_DECLINED');
  check('The notice names the driver, not just the truck',
    shipperNotice?.message?.includes('Ravi Kumar') && shipperNotice?.message?.includes('FG-027'),
    shipperNotice?.message);
  check('The notice repeats the reason the driver gave',
    shipperNotice?.message?.includes('Already full near Hosur'), shipperNotice?.message);
  check('The notice says nothing is reserved and how to recover',
    /nothing is reserved/i.test(shipperNotice?.message ?? '') && /rebook/i.test(shipperNotice?.message ?? ''),
    shipperNotice?.message);
  check('The notice spells out the load and route that were affected',
    shipperNotice?.message?.includes(declinedId) &&
      shipperNotice?.message?.includes('0.5T') &&
      shipperNotice?.message?.includes('Bengaluru → Chennai'),
    shipperNotice?.message);
  check('The operator is told the tonnage is back on the truck',
    declineNotifications.some((n) => n.type === 'CAPACITY_DECLINED' && n.message.includes('FG-027')),
    declineNotifications.filter((n) => n.type === 'CAPACITY_DECLINED').map((n) => n.message));
  check('A notification is never reported as delivered',
    declineNotifications.every((n) => n.status === 'PENDING'), declineNotifications.map((n) => n.status));
  check('The decline notice is readable from the notifications feed',
    (await api('/notifications')).body.notifications.some((n: any) => n.id === shipperNotice?.id),
    'notification should be listed');
  check('A declined load notifies nobody for a shipment they did not request',
    !declineNotifications.some((n) => n.recipientId !== shipperId && n.recipientId !== 'org_fleetgrid_logistics'),
    declineNotifications.map((n) => n.recipientId));

  const declineTwice = await api(`/shipments/${declinedId}/decline`, { method: 'POST', body: JSON.stringify({}) });
  check('Declining twice is rejected with 409', declineTwice.status === 409, declineTwice.body);
  const confirmDraft = await api(`/shipments/${declinedId}/confirm`, { method: 'POST' });
  check('A DRAFT shipment cannot be confirmed — the gate cannot be skipped',
    confirmDraft.status === 409, confirmDraft.body);

  const declinedTimeline = await api(`/shipments/${declinedId}/timeline`);
  check('The decline is recorded as an event',
    declinedTimeline.body.events.some((e: any) => e.eventType === 'shipment.capacity_released'),
    declinedTimeline.body.events?.map((e: any) => e.eventType));
  check('The release event is attributed to the DRIVER',
    declinedTimeline.body.events.find((e: any) => e.eventType === 'shipment.capacity_released')?.actorType === 'DRIVER',
    declinedTimeline.body.events?.find((e: any) => e.eventType === 'shipment.capacity_released'));

  section('7. Driver starts the journey');
  const depart = await api('/trucks/FG-027/depart', { method: 'POST', body: JSON.stringify({ driverId }) });
  check('POST /trucks/FG-027/depart succeeds', depart.status === 200, depart.body);
  check('FG-027 is IN_TRANSIT', depart.body.truckStatus === 'IN_TRANSIT', depart.body);
  check('Shipment is IN_TRANSIT', depart.body.shipments?.some((s: any) => s.id === shipmentId && s.status === 'IN_TRANSIT'), depart.body.shipments);

  await sleep(300);
  const afterDepart = await api('/state');
  const ctShipment = afterDepart.body.shipments.find((s: any) => s.id === shipmentId);
  check('Server state: shipment IN_TRANSIT', ctShipment?.status === 'IN_TRANSIT', ctShipment);
  const ctTruck = afterDepart.body.trucks.find((t: any) => t.id === 'FG-027');
  check('Server state: FG-027 IN_TRANSIT', ctTruck?.status === 'IN_TRANSIT', ctTruck);
  check('Control Tower saw truck.updated → IN_TRANSIT',
    tower.lastOfType('truck.updated')?.id === 'FG-027' && tower.lastOfType('truck.updated')?.status === 'IN_TRANSIT',
    tower.lastOfType('truck.updated'));

  section('8. Driver reports a Hosur breakdown');
  const earlyIncident = await api('/incidents', {
    method: 'POST',
    body: JSON.stringify({ truckId: 'FG-041', type: 'TRUCK_BREAKDOWN', location: 'Hosur' }),
  });
  check('Incident on a non-departed truck is rejected with 409', earlyIncident.status === 409, earlyIncident.body);

  const incident = await api('/incidents', {
    method: 'POST',
    body: JSON.stringify({
      truckId: 'FG-027',
      type: 'TRUCK_BREAKDOWN',
      location: 'Hosur',
      description: 'Engine failure / truck unable to continue',
      actorId: driverId,
    }),
  });
  check('POST /incidents returns 201', incident.status === 201, incident.body);
  const incidentId = incident.body.incident?.id as string;
  check('Incident is OPEN', incident.body.incident?.status === 'OPEN', incident.body.incident);
  check('Incident location resolved to Hosur', incident.body.incident?.location === 'Hosur');
  check('Incident severity defaulted to HIGH', incident.body.incident?.severity === 'HIGH');
  check('Affected shipment is AT_RISK', incident.body.affectedShipments?.[0]?.status === 'AT_RISK', incident.body.affectedShipments);
  check('Truck is INCIDENT', incident.body.truck?.status === 'INCIDENT', incident.body.truck);

  await sleep(300);
  check('Control Tower received incident.created', tower.types().includes('incident.created'), tower.types());
  const towerIncident = tower.lastOfType('incident.created');
  check('Control Tower incident names FG-027 / Truck breakdown / Hosur',
    towerIncident?.truckId === 'FG-027' && towerIncident?.location === 'Hosur' && towerIncident?.type === 'TRUCK_BREAKDOWN',
    towerIncident);
  check('Business client also received the incident', business.types().includes('incident.created'), business.types());

  const postIncidentState = await api('/state');
  const atRisk = postIncidentState.body.shipments.find((s: any) => s.id === shipmentId);
  check('Server state: shipment AT_RISK', atRisk?.status === 'AT_RISK', atRisk);

  section('9. Recovery: deterministic options + approval gate');
  const options = await api(`/incidents/${incidentId}/recovery-options`);
  // The wider fleet means more recovery choices than the original two.
  check('Every candidate that can take the cargo is offered',
    options.body.options.filter((o: any) => o.compatible).length === 5, options.body.options);
  check('Off-lane trucks are rejected for recovery with a stated reason',
    options.body.options.filter((o: any) => !o.compatible).every((o: any) => o.reason.startsWith('Rejected')),
    options.body.options.filter((o: any) => !o.compatible).map((o: any) => o.reason));

  const fg041 = options.body.options.find((o: any) => o.truckId === 'FG-041');
  const fg052 = options.body.options.find((o: any) => o.truckId === 'FG-052');
  check('FG-041 candidate: 3.1T spare, 8.2 km, 17 min',
    fg041?.compatible && fg041?.availableT === 3.1 && fg041?.distanceKm === 8.2 && fg041?.etaMinutes === 17, fg041);
  check('FG-052 candidate: 5.0T spare, 15.8 km, 26 min',
    fg052?.compatible && fg052?.availableT === 5 && fg052?.distanceKm === 15.8 && fg052?.etaMinutes === 26, fg052);
  check('FG-027 is not offered as its own recovery truck',
    !options.body.options.some((o: any) => o.truckId === 'FG-027'));

  const plan = await api('/recovery-plans', { method: 'POST', body: JSON.stringify({ incidentId }) });
  check('POST /recovery-plans returns 201', plan.status === 201, plan.body);
  const planId = plan.body.plan?.id as string;
  check('Plan is PENDING_APPROVAL', plan.body.plan?.status === 'PENDING_APPROVAL', plan.body.plan);
  check('Plan selected FG-041 (fastest compatible)', plan.body.plan?.selectedTruckId === 'FG-041', plan.body.plan);

  const bypass = await api(`/recovery-plans/${planId}/execute`, { method: 'POST', body: JSON.stringify({}) });
  check('Execution before approval is blocked with 409', bypass.status === 409, bypass.body);
  const stillPending = await api(`/recovery-plans/${planId}`);
  check('Shipment still AT_RISK after blocked execution',
    (await api('/state')).body.shipments.find((s: any) => s.id === shipmentId)?.status === 'AT_RISK');
  check('Plan still PENDING_APPROVAL after blocked execution', stillPending.body.plan?.status === 'PENDING_APPROVAL');

  const approved = await api(`/recovery-plans/${planId}/approve`, {
    method: 'POST',
    body: JSON.stringify({ approvedBy: 'operator_demo' }),
  });
  check('Approve moves plan to APPROVED', approved.body.plan?.status === 'APPROVED', approved.body);

  const executed = await api(`/recovery-plans/${planId}/execute`, {
    method: 'POST',
    body: JSON.stringify({ executedBy: 'operator_demo' }),
  });
  check('Execute succeeds', executed.status === 200, executed.body);
  check('Plan is COMPLETED', executed.body.plan?.status === 'COMPLETED', executed.body.plan);
  check('Shipment moved onto FG-041', executed.body.reassignments?.[0]?.toTruckId === 'FG-041', executed.body.reassignments);
  check('Verification readback shows shipment IN_TRANSIT',
    executed.body.verification?.shipmentStatus === 'IN_TRANSIT', executed.body.verification);
  check('Verification readback shows FG-041 has 2.1T spare',
    executed.body.verification?.toTruckAvailableT === 2.1, executed.body.verification);

  const repeat = await api(`/recovery-plans/${planId}/execute`, { method: 'POST', body: JSON.stringify({}) });
  check('Re-executing a completed plan is idempotent', repeat.status === 200 && repeat.body.alreadyExecuted === true, repeat.body);

  const finalState = await api('/state');
  const finalTruck027 = finalState.body.trucks.find((t: any) => t.id === 'FG-027');
  const finalTruck041 = finalState.body.trucks.find((t: any) => t.id === 'FG-041');
    check('FG-027 recovered its 1T → 3.8T spare and returned to service',
      finalTruck027?.availableT === 3.8 && finalTruck027?.status === 'AVAILABLE', finalTruck027);
    const finalDriver027 = finalState.body.drivers.find((d: any) => d.assignedTruckId === 'FG-027');
    check('FG-027 driver released back to AVAILABLE',
      finalDriver027?.status === 'AVAILABLE', finalDriver027);
  check('FG-041 spent 1.0T → 2.1T spare', finalTruck041?.availableT === 2.1, finalTruck041);
  check('Incident resolved', finalState.body.incidents.find((i: any) => i.id === incidentId)?.status === 'RESOLVED');

  section('10. Timeline + proof honesty');
  const timeline = await api(`/shipments/${shipmentId}/timeline`);
  const eventTypes = timeline.body.events.map((e: any) => e.eventType);
  check('Timeline records shipment.created', eventTypes.includes('shipment.created'), eventTypes);
  check('Timeline records shipment.capacity_reserved', eventTypes.includes('shipment.capacity_reserved'));
  check('Timeline records shipment.confirmed', eventTypes.includes('shipment.confirmed'));
  const confirmEvent = timeline.body.events.find((e: any) => e.eventType === 'shipment.confirmed');
  check('The confirmation is attributed to the DRIVER who accepted it',
    confirmEvent?.actorType === 'DRIVER', confirmEvent);
  check('Timeline records shipment.departed', eventTypes.includes('shipment.departed'));
  check('Timeline records incident.created', eventTypes.includes('incident.created'));
  check('Timeline records cargo.handoff', eventTypes.includes('cargo.handoff'), eventTypes);
  check('Every event is hashed', timeline.body.events.every((e: any) => typeof e.hash === 'string' && e.hash.length === 64));
  check('No event fakes a blockchain confirmation',
    timeline.body.events.every((e: any) => e.proofStatus !== 'CONFIRMED' && e.blockchainTx === null));

  const badEvent = await api('/events', { method: 'POST', body: JSON.stringify({ eventType: 'Bad Type!' }) });
  check('Invalid eventType is rejected with 400', badEvent.status === 400, badEvent.body);
  const goodEvent = await api('/events', {
    method: 'POST',
    body: JSON.stringify({ eventType: 'shipment.note', shipmentId, payload: { note: 'demo' } }),
  });
  check('Valid event is appended with a hash', goodEvent.status === 201 && goodEvent.body.event.hash.length === 64, goodEvent.body);

  section('11. Business confirms delivery');
  const businessEventsBeforeDelivery = business.events.length;

  // The recovered shipment is aboard FG-041, which recovery execution left ASSIGNED.
  const deliver = await api(`/shipments/${shipmentId}/confirm-delivery`, {
    method: 'POST',
    body: JSON.stringify({ actorId: demoLogin.body.user.id }),
  });
  check('POST /shipments/:id/confirm-delivery succeeds', deliver.status === 200, deliver.body);
  check('Shipment is DELIVERED', deliver.body.shipment?.status === 'DELIVERED', deliver.body.shipment);
  check('Shipment stayed on the recovered truck FG-041', deliver.body.shipment?.truckId === 'FG-041', deliver.body.shipment);
  check('FG-041 is not forced to DELIVERED from ASSIGNED', deliver.body.truck?.status === 'ASSIGNED' && deliver.body.truckCompleted === false, deliver.body.truck);
  check('The response explains why the truck did not complete',
    String(deliver.body.truckNote ?? '').includes('no ASSIGNED → DELIVERED transition'), deliver.body.truckNote);

  const deliveredTimeline = await api(`/shipments/${shipmentId}/timeline`);
  const deliveredTypes = deliveredTimeline.body.events.map((e: any) => e.eventType);
  check('Timeline records shipment.delivered', deliveredTypes.includes('shipment.delivered'), deliveredTypes);
  const deliveredEvent = deliveredTimeline.body.events.find(
    (e: any) => e.eventType === 'shipment.delivered' && e.shipmentId === shipmentId,
  );
  check('The delivery event belongs to this shipment, not the seeded one', !!deliveredEvent, deliveredEvent);
  check('Delivery event is hashed', typeof deliveredEvent?.hash === 'string' && deliveredEvent.hash.length === 64);
  check('Delivery event is attributed to BUSINESS', deliveredEvent?.actorType === 'BUSINESS', deliveredEvent);
  check('Delivery event still fakes no blockchain proof',
    deliveredEvent?.proofStatus === 'NOT_ANCHORED' && deliveredEvent?.blockchainTx === null, deliveredEvent);

  const deliverAgain = await api(`/shipments/${shipmentId}/confirm-delivery`, { method: 'POST', body: JSON.stringify({}) });
  check('Re-confirming delivery is idempotent, not a 409', deliverAgain.status === 200, deliverAgain.body);
  const afterSecondDelivery = await api(`/shipments/${shipmentId}/timeline`);
  check('Idempotent re-confirm appended no duplicate event',
    afterSecondDelivery.body.events.filter((e: any) => e.eventType === 'shipment.delivered' && e.shipmentId === shipmentId).length === 1,
    afterSecondDelivery.body.events.filter((e: any) => e.eventType === 'shipment.delivered').map((e: any) => e.id));

  const draftShipment = await api('/shipments', {
    method: 'POST',
    body: JSON.stringify({ shipperId, cargoName: 'Never Departed', origin: 'Bengaluru', destination: 'Chennai', weightT: 0.5 }),
  });
  check('A DRAFT shipment was created for the guard check', draftShipment.status === 201, draftShipment.body);
  const earlyDelivery = await api(`/shipments/${draftShipment.body.shipment.id}/confirm-delivery`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  check('Confirming delivery on a shipment that never departed is a 409', earlyDelivery.status === 409, earlyDelivery.body);
  check('The 409 names the illegal transition',
    earlyDelivery.body.error?.code === 'CONFLICT' && String(earlyDelivery.body.error?.message).includes('DRAFT'),
    earlyDelivery.body.error);

  // A truck that departed normally is IN_TRANSIT, and the machine does allow
  // IN_TRANSIT → DELIVERED, so the truck must complete once its last cargo lands.
  const capacity052 = await api('/capacity?origin=Bengaluru&destination=Chennai&weightT=1');
  const offer052 = capacity052.body.matches.find((m: any) => m.truck.id === 'FG-052');
  const directShipment = await api('/shipments', {
    method: 'POST',
    body: JSON.stringify({
      shipperId, cargoName: 'Direct Load', origin: 'Bengaluru', destination: 'Chennai', weightT: 1,
      capacityOfferId: offer052.offer.id, actorId: demoLogin.body.user.id,
    }),
  });
  const directShipmentId = directShipment.body.shipment?.id as string;
  check('A second shipment was booked on FG-052', directShipment.status === 201 && directShipment.body.shipment?.truckId === 'FG-052', directShipment.body.shipment);
  check('That booking also waits for the FG-052 driver to accept',
    directShipment.body.shipment?.status === 'CAPACITY_RESERVED', directShipment.body.shipment);
  // The gate applies to every departure, not just the demo truck: the FG-052 driver
  // has to accept this load before the truck is allowed to roll.
  const departBlocked = await api('/trucks/FG-052/depart', { method: 'POST', body: JSON.stringify({}) });
  check('FG-052 cannot depart while the load is unaccepted', departBlocked.status === 409, departBlocked.body);
  const accept052 = await api(`/shipments/${directShipmentId}/confirm`, { method: 'POST' });
  check('The FG-052 driver accepts and it is CONFIRMED', accept052.body.shipment?.status === 'CONFIRMED', accept052.body.shipment);
  const depart052 = await api('/trucks/FG-052/depart', { method: 'POST', body: JSON.stringify({}) });
  check('FG-052 departs and reaches IN_TRANSIT', depart052.body.truckStatus === 'IN_TRANSIT', depart052.body);

  const deliverDirect = await api(`/shipments/${directShipmentId}/confirm-delivery`, {
    method: 'POST',
    body: JSON.stringify({ actorId: demoLogin.body.user.id }),
  });
  check('The IN_TRANSIT shipment is DELIVERED', deliverDirect.body.shipment?.status === 'DELIVERED', deliverDirect.body.shipment);
  check('FG-052 completes once its last cargo is delivered',
    deliverDirect.body.truckCompleted === true && deliverDirect.body.truck?.status === 'DELIVERED', deliverDirect.body.truck);
  const timeline052 = await api(`/shipments/${directShipmentId}/timeline`);
  check('FG-052 records truck.delivered',
    timeline052.body.events.some((e: any) => e.eventType === 'truck.delivered' && e.truckId === 'FG-052'),
    timeline052.body.events.map((e: any) => e.eventType));

  await sleep(300);
  check('Business device received the delivery frame for this shipment',
    business.events.length > businessEventsBeforeDelivery
      && business.events.some(
        (e) => e.type === 'shipment.updated' && e.payload?.id === shipmentId && e.payload?.status === 'DELIVERED',
      ),
    business.events.filter((e) => e.type === 'shipment.updated').map((e) => `${e.payload?.id}:${e.payload?.status}`));

  section('12. Unwired integrations fail honestly');
  const paymentCreate = await api('/payments/create', {
    method: 'POST',
    body: JSON.stringify({ shipmentId, amount: 850, currency: 'INR' }),
  });
  check('POST /payments/create returns 501, not 404', paymentCreate.status === 501, paymentCreate.body);
  check('Payment 501 names the missing provider',
    paymentCreate.body.error?.code === 'NOT_IMPLEMENTED' && String(paymentCreate.body.error?.message).includes('Dodo'),
    paymentCreate.body.error);
  check('Payment 501 leaves the shipment unchanged', paymentCreate.body.error?.details?.shipmentStatus === 'unchanged');

  const badPayment = await api('/payments/create', { method: 'POST', body: JSON.stringify({ amount: 0, currency: 'INR' }) });
  check('Payments validate input before reporting 501', badPayment.status === 400, badPayment.body);

  const dodoHook = await api('/webhooks/dodo', {
    method: 'POST',
    body: JSON.stringify({ eventId: 'evt_dodo_1', type: 'payment.succeeded' }),
  });
  check('POST /webhooks/dodo returns 501', dodoHook.status === 501, dodoHook.body);
  check('Webhook 501 does not claim the event was accepted',
    dodoHook.body.error?.code === 'NOT_IMPLEMENTED', dodoHook.body.error);

  const noTarget = await api('/proof/anchor', { method: 'POST', body: JSON.stringify({}) });
  check('POST /proof/anchor with no target is a 400', noTarget.status === 400, noTarget.body);

  const anchorTarget = deliveredEvent?.id as string;
  const anchor = await api('/proof/anchor', { method: 'POST', body: JSON.stringify({ eventId: anchorTarget }) });
  check('POST /proof/anchor returns 501', anchor.status === 501, anchor.body);
  check('Anchor 501 reports the real hash', anchor.body.error?.details?.hash === deliveredEvent?.hash, anchor.body.error?.details);
  check('Anchor 501 keeps proofStatus NOT_ANCHORED', anchor.body.error?.details?.proofStatus === 'NOT_ANCHORED');
  check('Anchor 501 never invents a transaction hash', anchor.body.error?.details?.blockchainTx === null);

  const anchoredEvent = (await api('/events?limit=500')).body.events.find((e: any) => e.id === anchorTarget);
  check('Event was not mutated by the failed anchor',
    anchoredEvent?.proofStatus === 'NOT_ANCHORED' && anchoredEvent?.blockchainTx === null, anchoredEvent);

  section('13. Agent tool contract is published as JSON Schema');
  const tools = await api('/agent/tools');
  check('GET /agent/tools returns 200', tools.status === 200);
  const catalog: any[] = tools.body.tools ?? [];
  const contract = tools.body.contract;
  check('Contract declares 13 tools', contract?.tools?.length === 13, contract?.tools?.length);
  check('Contract has a JSON Schema $schema and $id',
    contract?.$schema === 'https://json-schema.org/draft/2020-12/schema' && typeof contract?.$id === 'string', {
      $schema: contract?.$schema, $id: contract?.$id,
    });

  const catalogNames = catalog.map((t) => t.name);
  const schemaNames = contract.tools.map((t: any) => t.name);
  check('Every catalog tool has a schema entry', catalogNames.every((n) => schemaNames.includes(n)), { catalogNames, schemaNames });
  check('No schema entry is missing from the catalog', schemaNames.every((n) => catalogNames.includes(n)), { catalogNames, schemaNames });
  check('Catalog order matches schema order', JSON.stringify(catalogNames) === JSON.stringify(schemaNames));
  check('Status agrees between catalog and schema',
    catalog.every((t) => contract.tools.find((s: any) => s.name === t.name)?.status === t.status));
  check('11 tools are READY and 2 are PLACEHOLDER',
    catalog.filter((t) => t.status === 'READY').length === 11 && catalog.filter((t) => t.status === 'PLACEHOLDER').length === 2,
    catalog.map((t) => `${t.name}:${t.status}`));

  check('Every tool declares an input schema', contract.tools.every((t: any) => t.input && t.input.type));
  check('Every READY tool declares an output schema',
    contract.tools.filter((t: any) => t.status === 'READY').every((t: any) => !!t.output));
  check('PLACEHOLDER tools declare a failure shape and no success output',
    contract.tools.filter((t: any) => t.status === 'PLACEHOLDER').every((t: any) => t.unavailable && !t.output));
  check('The payment placeholder names Dodo Payments',
    contract.tools.find((t: any) => t.name === 'create_payment_intent')?.unavailable?.description?.includes('Dodo'));
  check('The proof placeholder forbids a fabricated tx hash',
    contract.tools.find((t: any) => t.name === 'anchor_proof')?.unavailable?.description?.includes('no transaction hash'),
    contract.tools.find((t: any) => t.name === 'anchor_proof')?.unavailable?.description);

  const schemaText = JSON.stringify(contract);
  const refs = [...schemaText.matchAll(/#\/\$defs\/([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  const defs = Object.keys(contract.$defs ?? {});
  check('Every $ref in the contract resolves', refs.every((r) => defs.includes(r)), { unresolved: refs.filter((r) => !defs.includes(r)) });
  check('No schema entry leaks a secret-shaped field',
    !/(api[_-]?key|secret|password|private[_-]?key)/i.test(schemaText));

  section('14. Self-service registration chooses the right entities');
  const regBiz = await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      role: 'BUSINESS',
      name: 'Asha Rao',
      contact: 'asha@asha-textiles.in',
      organizationName: 'Asha Textiles',
    }),
  });
  check('Registering a business returns 201', regBiz.status === 201, regBiz.body);
  check('A business gets a SHIPPER organization', regBiz.body.organization?.type === 'SHIPPER', regBiz.body.organization);
  check('A business gets a BUSINESS user', regBiz.body.user?.role === 'BUSINESS', regBiz.body.user);
  check('A business gets no driver row', regBiz.body.driver === null, regBiz.body.driver);
  check('A business gets no truck', regBiz.body.truck === null, regBiz.body.truck);
  check('The organization slug keeps the whole name', regBiz.body.organization?.id === 'asha_textiles', regBiz.body.organization?.id);
  check('Registration does not pretend to be authentication',
    regBiz.body.mode === 'registered' && String(regBiz.body.warning).includes('not authentication'), regBiz.body.mode);

  const regDrv = await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      role: 'DRIVER',
      name: 'Ravi Kumar',
      contact: '+91 90000 11223',
      truck: { registrationNo: 'KA 55 ZZ 9999', capacityT: 6, origin: 'Bengaluru', destination: 'Chennai' },
    }),
  });
  check('Registering a driver returns 201', regDrv.status === 201, regDrv.body);
  check('A driver gets a FLEET_OPERATOR organization', regDrv.body.organization?.type === 'FLEET_OPERATOR', regDrv.body.organization);
  check('A driver gets a DRIVER user', regDrv.body.user?.role === 'DRIVER', regDrv.body.user);
  check('A driver gets a driver row', Boolean(regDrv.body.driver?.id), regDrv.body.driver);
  check('The new truck is linked to the driver', regDrv.body.driver?.assignedTruckId === regDrv.body.truck?.id,
    { driver: regDrv.body.driver?.assignedTruckId, truck: regDrv.body.truck?.id });
  check('The new truck starts with its full tonnage spare', regDrv.body.truck?.availableT === 6, regDrv.body.truck);
  check('The new driver is immediately usable', regDrv.body.driver?.status === 'AVAILABLE', regDrv.body.driver);

  const newTruckId = regDrv.body.truck?.id as string;
  const newDriverId = regDrv.body.driver?.id as string;
  const newOffer = (await api(`/capacity/${(await api('/capacity?includeAll=true')).body.matches
    .find((m: any) => m.truck.id === newTruckId)?.offer?.id}`)).body.offer;
  check('The new truck published a capacity offer', newOffer?.id?.length > 0, newOffer);

  const drvNoTruck = await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ role: 'DRIVER', name: 'Solo Driver', contact: '+91 90000 00000' }),
  });
  check('A driver can register without a truck', drvNoTruck.status === 201 && drvNoTruck.body.truck === null, drvNoTruck.body);
  const noTruckQueue = await api(`/driver/offers?driverId=${drvNoTruck.body.driver.id}`);
  check('A driver with no truck has an empty queue, not an error',
    noTruckQueue.status === 200 && noTruckQueue.body.truck === null && noTruckQueue.body.counts.pending === 0,
    noTruckQueue.body);

  const dupeOrg = await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ role: 'BUSINESS', name: 'Asha Rao', contact: 'asha2@asha-textiles.in', organizationName: 'Asha Textiles' }),
  });
  check('A duplicate organization name gets a unique id', dupeOrg.body.organization?.id === 'asha_textiles_2', dupeOrg.body.organization?.id);

  const badRole = await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ role: 'CONTROL_TOWER', name: 'Sneaky', contact: 'x@y.z' }),
  });
  check('Only BUSINESS or DRIVER can register', badRole.status === 400, badRole.body);
  const sameEnds = await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ role: 'DRIVER', name: 'Loop Truck', contact: 'x@y.z', truck: { registrationNo: 'KA 01 LO 0001', capacityT: 5, origin: 'Chennai', destination: 'Chennai' } }),
  });
  check('A truck whose origin equals its destination is rejected with 422', sameEnds.status === 422, sameEnds.body);
  const badTruck = await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ role: 'DRIVER', name: 'No Plate', contact: 'x@y.z', truck: { registrationNo: '', capacityT: 5, origin: 'Bengaluru', destination: 'Chennai' } }),
  });
  check('A driver truck with no registration number is rejected with 400', badTruck.status === 400, badTruck.body);

  section('15. Surplus capacity suggests the nearest other trucks');
  const near = await api(`/capacity/nearby?truckId=${newTruckId}&origin=Bengaluru&destination=Chennai&weightT=1`);
  check('GET /capacity/nearby returns 200', near.status === 200, near.body);
  check('It reports the selected truck and its spare tonnage',
    near.body.selectedTruck?.id === newTruckId && near.body.selectedTruckSpareT === 6, near.body.selectedTruckSpareT);
  check('It never suggests the truck already selected',
    near.body.suggestions.every((s: any) => s.truck.id !== newTruckId),
    near.body.suggestions.map((s: any) => s.truck.id));
  check('Distances are real numbers', near.body.suggestions.every((s: any) => typeof s.distanceFromSelectedKm === 'number'),
    near.body.suggestions.map((s: any) => s.distanceFromSelectedKm));
  const dists = near.body.suggestions.map((s: any) => s.distanceFromSelectedKm);
  check('Suggestions are ordered nearest first',
    dists.every((d: number, i: number) => i === 0 || d >= dists[i - 1]), dists);
  check('It says the distance is not a routing result',
    String(near.body.note).includes('not a routing provider'), near.body.note);

  // Surplus tonnage: take most of the new truck, then confirm the alternatives are real.
  const newShipment = await api('/shipments', {
    method: 'POST',
    body: JSON.stringify({
      shipperId: regBiz.body.organization.id,
      cargoName: 'Ceramic tiles',
      origin: 'Bengaluru',
      destination: 'Chennai',
      weightT: 5,
      capacityOfferId: newOffer.id,
    }),
  });
  check('A 5T load fits the new 6T truck', newShipment.status === 201, newShipment.body);
  const nearAfter = await api(`/capacity/nearby?truckId=${newTruckId}&weightT=1`);
  check('After a big load, 1T of spare remains on the chosen truck',
    nearAfter.body.selectedTruckSpareT === 1, nearAfter.body.selectedTruckSpareT);
  check('Alternatives that can also carry the load are flagged',
    nearAfter.body.suggestions.some((s: any) => s.canAlsoCarry === true),
    nearAfter.body.suggestions.map((s: any) => ({ id: s.truck.id, spare: s.truck.availableT, can: s.canAlsoCarry })));
  check('The new driver has the load waiting for approval',
    (await api(`/driver/offers?driverId=${newDriverId}`)).body.counts.pending === 1,
    (await api(`/driver/offers?driverId=${newDriverId}`)).body.counts);

  section('16. Reset restores the exact demo state');
  await api('/demo/reset', { method: 'POST' });
  const afterReset = await api('/state');
  const t027 = afterReset.body.trucks.find((t: any) => t.id === 'FG-027');
  check('Reset: FG-027 back to 3.8T / AVAILABLE', t027?.availableT === 3.8 && t027?.status === 'AVAILABLE', t027);
  check('Reset: no live incidents', afterReset.body.incidents.filter((i: any) => i.status === 'OPEN').length === 0);
  check('Reset: only the four seeded historical shipments remain', afterReset.body.shipments.length === 4, afterReset.body.shipments.length);
  check('Reset: no recovery plans', afterReset.body.recoveryPlans.length === 0);
  check('Reset broadcast reached Control Tower', tower.types().includes('demo.reset'), tower.types());
  check('Reset removes the accounts created during this run',
    !(await api('/state')).body.organizations.some((o: any) => o.id === 'asha_textiles'),
    'registered org should not survive a reset');

  await tower.close();
  await business.close();

  console.log(`\n${'='.repeat(56)}`);
  console.log(`  passed: ${passed}   failed: ${failed}`);
  console.log('='.repeat(56));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nTest run crashed:', err);
  process.exit(1);
});
