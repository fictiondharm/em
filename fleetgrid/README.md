# FleetGrid

Multi-device logistics network demo: one React application, three modes, one authoritative backend.

A shipper books spare capacity, a driver runs the journey and reports a breakdown from a phone, and the
Control Tower analyzes the incident, gets operator approval, and executes a recovery that moves the cargo
to another truck. Every device converges on the same server state within one WebSocket round trip.

---

## Quick start

```bash
npm run install:all     # installs server + web dependencies
npm run dev             # starts the API (4000) and the web app (5173)
```

Open <http://localhost:5173> and pick a mode.

To run the real three-device demo, open the **Network** URL that Vite prints (for example
`http://192.168.1.20:5173`) on three laptops or phones on the same Wi-Fi, and pick a different mode on
each. The web app derives the backend origin from the page hostname, so no configuration is needed when
all devices are on one network. To point at a backend on another machine, set `VITE_API_URL` before
starting the web app (see `.env.example`).

### Demo flow

0. **Sign up** — from the role screen choose *Create an account*, then pick **Business** or **Driver**. A driver
   can attach a truck in the same step, which is what makes them able to receive offers immediately.
1. **Business** — set the lane and weight. The live count tells you how many drivers can take it, and
   **Send to all eligible drivers** broadcasts it: every eligible driver is asked at once, nothing is
   reserved yet, and the shipment sits in `AWAITING_DRIVER`. The ask list is frozen at that moment.
   - *Reserve capacity & request driver* is the other path: pick a named truck such as **FG-027** and one
     server call reserves the tonnage atomically, leaving the shipment at `CAPACITY_RESERVED`.
   - A panel lists the other trucks nearest the one you picked, with their spare tonnage.
   - Search a **half route** like `Bengaluru → Hosur` and the results include trucks *passing through*, not just
     trucks booked for that leg.
   - Search a load **bigger than any truck** (e.g. `10.0` tonnes) and you get a concrete split plan across
     several trucks instead of an empty result.
2. **Driver** — the tab now lists **all nine drivers**; pick one to act as them.
   - On a broadcast, their open requests show how many other drivers hold the same one. **Accept** takes it
     (`AWAITING_DRIVER → CONFIRMED`); **Decline** passes, and the load stays open for everyone else until
     the last one passes. *Who else* opens the board for that request.
   - On a direct reservation, the load appears under *Loads waiting for you*. **Accept** runs
     `CAPACITY_RESERVED → CONFIRMED`; **Decline** gives the tonnage back and returns the shipment to `DRAFT`.
   - A decline is shown as an amber **declined** badge with a plain explanation, never as a success — the
     row flash is toned by the event that caused it. Until the driver accepts, the truck **cannot depart** —
     the server rejects it. Then start the journey.
3. **Incident** — the driver reports a breakdown. The truck goes `INCIDENT` and the shipment `AT_RISK`.
4. **Control Tower** — analyze the incident, review the deterministic options, approve, then execute. The
   cargo is reassigned, the disabled truck returns to service, and the panel keeps a verified readback of
   the resulting server state.

`npm run reset --prefix server` restores the deterministic seed at any time (server must be running). It also
removes any accounts created during the run.

### The driver approval gate

A business reserving capacity does **not** confirm a shipment. This is not a new state — Master PRD §7 already
defines `CAPACITY_RESERVED → CONFIRMED` as its own step, and §6 has the driver start the journey after the
shipper reserves. The PRD's own API contract lists `POST /capacity/:id/reserve` separately from
`POST /shipments`, which is the same split.

The gate is enforced in three places, so it cannot be bypassed:

| Attempt | Result |
| --- | --- |
| `POST /shipments` with `capacityOfferId` | reserves, stays `CAPACITY_RESERVED` |
| `POST /trucks/:id/depart` with an unaccepted load | `409` with the blocking shipment ids |
| `POST /shipments/:id/confirm` on a `DRAFT` shipment | `409` — the reservation step cannot be skipped |

`GET /driver/offers` is the queue the driver screen reads. It is a read model over existing rows, filtered on
exactly the `CAPACITY_RESERVED` condition that `/confirm` and `/decline` act on, so the screen and the state
machine cannot disagree.

Declining has no `CANCELLED` state to fall back on, so it returns the shipment to `DRAFT` with the capacity
released — the shipment still exists and is still editable, it simply no longer holds tonnage.

### Accept and decline both notify the requester

A decline is the one outcome a requester cannot see happening: their screen quietly returns to `DRAFT` and
nothing says why. Both sides of the gate now create notifications addressed to the requesting organization.

| Action | Notification | Recipient |
| --- | --- | --- |
| `POST /shipments/:id/decline` | `SHIPMENT_DECLINED` | the shipper who requested the load |
| `POST /shipments/:id/decline` | `CAPACITY_DECLINED` | the operator, since tonnage is back on the truck |
| `POST /shipments/:id/confirm` | `SHIPMENT_ACCEPTED` | the shipper who requested the load |

The shipper notice names the driver and truck, the shipment id, cargo, weight and route, repeats the driver's
reason verbatim, and says what to do next. The operator notice reports the freed tonnage. `GET /notifications`
lists them, and each is broadcast as `notification.created`.

Two properties are enforced rather than assumed:

- **Idempotent.** Re-confirming a shipment returns the same row and creates no second notification, so a double
  tap on three devices does not produce three identical emails.
- **Organization-scoped.** `recipientId` holds a shipper org id for the requester notice and an operator org id
  for the freed-capacity note, so the client filters on its own organization. A driver never sees a shipper's
  news and a shipper never sees the operator's.

Delivery stays `PENDING`. There is no delivery infrastructure in this phase, so nothing claims to have sent
anything — the notification is stored and pushed in-app only.

On the client, `notification.created` becomes a toast (`web/src/components/NotificationToasts.tsx`) mounted once
at the app root, so a decline reaches the requester whichever screen they are on. Tone follows the row-flash
vocabulary in `lib/flash.ts`: accept is green, decline is amber, incidents and recovery are red. A decline never
renders as a success. Business also keeps a persistent Alerts panel fed from the snapshot, so notices sent while
that tab was closed are still there on return.

### The driver roster

`GET /drivers` returns the whole crew joined to their truck and current work: lane, spare tonnage against
capacity, active load count, and any load waiting on that driver's approval, with counts for totals. The
Control Tower renders it as a Drivers panel next to Trucks.

### Broadcasting one load to every driver

The reservation flow above pins a load to one named truck. A broadcast does not: the shipper offers the
load to **every driver who can actually take it**, and the first one to accept takes it.

| Endpoint | What it does |
| --- | --- |
| `POST /load-requests` | Opens a request in `AWAITING_DRIVER`, asking every eligible driver |
| `GET /load-requests/eligible` | Preview: who can take it, and why each other driver cannot |
| `GET /load-requests/:id/board` | Who was asked, who answered, who won |
| `POST /load-requests/:id/accept` | First accept takes the load; a later one gets `409` naming the winner |
| `POST /load-requests/:id/decline` | Pass. The load stays open for everyone else |
| `GET /driver/requests?driverId=` | One driver's view: open, won, lost, and how many others hold each |

Four decisions make this behave the way a dispatcher would expect:

- **Nothing is reserved at open time.** No truck is bound and no tonnage is held, so broadcasting a load
  costs the shipper the guarantee of a named vehicle. The moment somebody accepts, exactly one truck is
  charged exactly the agreed weight.
- **The ask list is frozen.** Eligibility is decided once, when the request opens. A driver who was passed
  by is never quietly added later, so the board cannot lie about who was offered the load.
- **First accept wins, under a lock.** Five drivers accepting at the same moment produce one `200` and
  four `409`s. The losers are told who won rather than left guessing.
- **A decline is not a cancellation.** One driver passing leaves the request open for the rest; only the
  final decline closes it, back to `DRAFT` with nothing reserved and a recorded reason.

A driver who never answered and loses the race is reported as `LOST`, not `PENDING` — otherwise the tab
would keep offering an accept button that can no longer work.

### All nine drivers, in one tab

The Driver tab lists the whole crew and lets you act as any of them, because the interesting question about
a broadcast is not "what did this driver see" but "who else had the same offer, and who got there first".
Selecting a driver shows their open requests with the count of others holding each, what they won, and
what went to somebody else. *Who else* opens the full board for one request.

The switcher is a demo affordance, not authentication: it does not check who is signed in. Real deployment
needs the driver's own identity to scope `/driver/requests`, and that is the one thing this flow does not
prove.

**Notifications are addressed per user, not per organization.** One org holds the whole fleet, so an
org-level notice would wake all nine drivers for a single load. The client matches a notification against
both the signed-in organization and the signed-in user, which is why a driver is told about a request they
were part of and hears nothing when they are not.

---

## Architecture

```
fleetgrid/
  server/                 authoritative backend (Express + ws + Zod)
    src/store/            JSON file collections, atomic writes, mutation mutex
    src/services/         domain logic and state machines
    src/routes/           REST API + endpoint index
    src/seed/            deterministic demo dataset
    test/store.test.ts   JSON store unit tests, incl. the concurrent-write regression
    test/flow.test.ts    end-to-end suite (277 checks, incl. two WebSocket clients)
  web/                    React + Vite + Tailwind single-page app
    src/store/            snapshot context, refetch-on-event, mode persistence
    src/views/            ControlTower, Business, Driver, Register, RoleSelect
    src/components/       incident/recovery desk, event feed, map, tables
  scripts/                dev runner + reset helper
```

**The server is the only source of truth.** The browser holds no domain state: it fetches `GET /state`
and refetches after any relevant WebSocket event, on reconnect, and on tab focus. The one thing it
stores locally is the selected mode (`localStorage["fleetgrid.mode"]`).

### Realtime

Native `ws` endpoint at `/realtime`. Events: `connected`, `demo.reset`, `truck.updated`,
`driver.updated`, `shipment.created`, `shipment.updated`, `load_request.opened`, `load_request.accepted`,
`load_request.declined`, `load_request.closed`, `capacity.updated`, `incident.created`,
`incident.updated`, `recovery.updated`, `payment.updated`, `notification.created`, `event.appended`.

Clients treat events as a signal to refetch, never as the new state. That keeps a reconnect or a missed
frame from leaving a device stale.

### Persistence

Server-side JSON files under `server/data/`, written atomically (temp file + rename). Two separate locks,
because they solve different problems:

- **Per-collection mutation chain** guards the whole read-modify-write cycle in
  `create`/`update`/`delete`/`replaceAll`. Serialising only the file write is not enough: five parallel
  creates would each read the same base array and the last would win. This silently dropped four of the
  five driver notifications on a broadcast, and `test/store.test.ts` now covers it directly.
- **Domain mutex** (`runExclusive`) guards the business rules — tonnage, accept races, and state-machine
  transitions — so two bookings cannot oversell the same truck.

No database, no container, no migration step — the seed rebuilds itself when the directory is empty.

---

## State machines

Enforced server-side in `server/src/types.ts`; an illegal transition is a `409`, never a silent write.

- **Truck** `AVAILABLE → ASSIGNED → LOADING → IN_TRANSIT → DELIVERED`, with `DELAYED`, `INCIDENT`, and
  `RECOVERY` branches. Completing a recovery returns the disabled truck to `AVAILABLE` so the demo is
  repeatable without a reset. A truck whose last cargo is delivered also completes.
- **Shipment** `DRAFT → AWAITING_DRIVER → CONFIRMED → IN_TRANSIT → DELIVERED`, plus `AT_RISK` and
  `RECOVERY`. `AWAITING_DRIVER` is the broadcast state: live on the board, no truck bound, nothing
  reserved. It returns to `DRAFT` if every asked driver passes, and can go back to `AWAITING_DRIVER` from
  `DRAFT` when a request is re-offered. The direct reservation path `DRAFT → CAPACITY_RESERVED →
  CONFIRMED` still exists and pins the load to a named truck. `DELIVERED` is reached only by the business
  confirming receipt via `POST /shipments/:id/confirm-delivery` — the driver dropping the cargo is not
  proof of delivery, and the client cannot assert it locally. The call is idempotent, so a double tap on
  two devices is safe.
- **Incident** `OPEN → ANALYZING → PLAN_READY → RESOLVED`, plus `ESCALATED`.
- **Recovery plan** `PENDING_APPROVAL → APPROVED → EXECUTING → COMPLETED`, plus `REJECTED`.

> **Known gap.** Recovery execution leaves the *receiving* truck `ASSIGNED`, and there is no
> `ASSIGNED → DELIVERED` edge in the machine. So confirming delivery on a recovered load delivers the
> shipment but cannot also complete the truck; the response says why in `truckNote` rather than
> inventing the transition.

### Recovery, honestly

Option generation is **deterministic** — distance, ETA, tonnage compatibility, and cost are computed from
server state, and the same inputs always produce the same ranked options. The LLM reasoning layer is
phase 2; the UI says so rather than faking it.

The approval gate cannot be bypassed: executing a plan that is not `APPROVED` returns `409`, and
re-executing a completed plan is idempotent.

Deliberately **not** faked in this phase: payment capture, notification delivery (rows are stored as
`PENDING` and never marked delivered), and blockchain proof anchoring. Both layers fail the same way —
the agent tools *and* the REST routes (`POST /payments/create`, `POST /webhooks/dodo`,
`POST /proof/anchor`) return `501 NOT_IMPLEMENTED` with a reason. The routes validate input first, so a
malformed request is a `400` rather than a misleading `501`, and `POST /proof/anchor` reports the real
event hash with `blockchainTx: null` instead of inventing a transaction.

### Agent tool contract

`GET /agent/tools` returns the readable catalog plus a formal JSON Schema (draft 2020-12) under
`contract`: per-tool input, output, and failure shapes, `$defs` for every entity, and `PLACEHOLDER`
tools that declare a failure shape and no success output. A test asserts the schema and the catalog
never drift on names, order, or status, and that every `$ref` resolves.

---

## Seeded data

Two organizations (ABC Distributors as shipper, FleetGrid Logistics as operator), nine drivers, nine
trucks across four lanes, and four delivered historical shipments.

| Truck  | Lane                    | Capacity | Seeded spare | Driver            |
| ------ | ----------------------- | -------- | ------------ | ----------------- |
| FG-027 | Bengaluru → Chennai     | 5.0T     | 3.8T         | Ravi Kumar        |
| FG-041 | Bengaluru → Chennai     | 5.0T     | 3.1T         | Imran Sheikh      |
| FG-052 | Bengaluru → Chennai     | 8.0T     | 5.0T         | Suresh Naidu      |
| FG-061 | Bengaluru → Chennai     | 12.0T    | 9.4T         | Anita Fernandes   |
| FG-073 | Bengaluru → Chennai     | 6.0T     | 2.2T         | Vikram Reddy      |
| FG-091 | Bengaluru → Chennai     | 3.0T     | 1.1T         | Meena Subramanian |
| FG-058 | Bengaluru → Hosur      | 10.0T    | 7.6T         | Harish Gowda      |
| FG-065 | Hosur → Chennai         | 9.0T     | 6.1T         | Divya Pillai      |
| FG-084 | Krishnagiri → Chennai   | 7.0T     | 4.4T         | Ganesh Murthy     |

> No truck on the main lane holds 10T spare, so the split-load path stays reachable from the UI.

> **Deviation from the Master PRD.** Master PRD §17 lists FG-027 as 10T with 8.8T spare. The direct task
> brief specified 5.0T capacity and 3.8T spare so the driver screen shows those exact figures, and the
> seed follows the brief. This is called out in `server/src/seed/seed.ts`.

### Half-route matching

The corridor is `Bengaluru → Krishnagiri → Hosur → Nellore → Chennai`. A shipper can pick **any** stop as
the drop-off, and a truck is a match when its own run *contains* the requested segment:

- Request `Bengaluru → Hosur` and FG-058 matches **exactly**, while FG-052 and FG-061 match as
  **passing through** — they are on their way to Chennai and cover the Hosur drop.
- A `Hosur → Chennai` request matches FG-065 exactly and the main-lane trucks as passing through.
- A reversed request (`Chennai → Bengaluru`) is refused with a stated reason rather than silently
  matched, and off-lane trucks are never offered.

Search and booking use the same rule, so a truck the UI offers can always actually be reserved.

### Split loads

`GET /capacity/options?origin=&destination=&weightT=` answers the question a plain capacity search
cannot: *what can actually be done with this load?* A 10T request against a fleet holding 9.4T, 5T and
3.8T used to return nothing, which reads as a broken product. It now returns one of:

- `single` — a truck that takes the whole load,
- `split` — a concrete plan across several trucks (`legs`, `coveredT`, `uncoveredT`, `totalPrice`),
  built largest-truck-first so it uses as few trucks as possible,
- `impossible` — a plain-language reason, with no options invented.

Booking a split creates **one shipment per leg**. Each leg is reserved atomically and **each driver
approves their own leg** — splitting is not a way around the approval gate. If a later leg fails, the
screen says how many legs were booked rather than pretending the whole thing worked.

> **Deviation from the Master PRD.** Master PRD §17 lists FG-027 as 10T with 8.8T spare. The direct task
> brief specified 5.0T capacity and 3.8T spare so the driver screen shows those exact figures, and the
> seed follows the brief. This is called out in `server/src/seed/seed.ts`.

---

## Scripts

| Command                                | Does                                              |
| -------------------------------------- | ------------------------------------------------- |
| `npm run install:all`                  | Install both packages                             |
| `npm run dev`                          | Run API + web together (Ctrl+C stops both)        |
| `npm run dev:server` / `npm run dev:web` | Run one side only                               |
| `npm run typecheck`                    | Typecheck both packages                           |
| `npm test`                             | Backend end-to-end suite                          |
| `npm run build --prefix server`        | Compile the server to `server/dist`               |
| `npm run build --prefix web`           | Production web build into `web/dist`              |
| `npm run reset --prefix server`        | Restore the demo seed (server must be running)    |

### Testing

`npm test` runs two suites. `test/store.test.ts` (17 checks) unit-tests the JSON store directly, including
the concurrent-write regression. `test/flow.test.ts` (277 checks) boots the real server on a spare port and
exercises the golden flow over HTTP and two independent WebSocket clients: seed integrity, capacity search,
oversell rejection, atomic reservation, departure, incident creation, recovery options, the approval gate
(including a bypass attempt that must fail), execution, idempotent re-execution, timeline, delivery
confirmation, the honesty of the unwired integration routes, the published tool contract, registration, the
driver approval gate, a broadcast taken by exactly one of five simultaneous accepts, and reset. No mocking
of business rules.

---

## Configuration

Copy `.env.example` to `.env`. Every value has a working default, so an empty file behaves identically.
Server: `PORT`, `HOST`, `DATA_DIR`, `CORS_ORIGIN`, `WS_HEARTBEAT_MS`, `AUTO_SEED`.
Web: `VITE_API_URL`.

## Known limits

- Single-process server with file storage. Fine for the demo; a real deployment wants Postgres plus a
  shared pub/sub so multiple instances broadcast the same events.
- No authentication. `POST /auth/demo-login` selects a seeded role and `POST /auth/register`
  creates an account, but neither has a password, token, or session. Both are demo scope.
- Cost, ETA, and distance numbers are demo estimates, labelled as such in the UI.
- The corridor is one stylised lane. `CORRIDOR_ORDER` in `server/src/lib/geo.ts` is a hand-declared
  list, not a real road network, so a city not on that list only ever matches an exact
  origin/destination pair. Half-route matching is one direction only — there is no reverse-lane logic.
- Split loads are planned by a greedy largest-truck-first fill. That minimises truck count but is not
  a cost optimiser, and it does not consider pickup times, driver hours, or how many legs a truck can
  already have.
- A split creates separate shipments, so the shipper sees N rows for one physical order. There is no
  parent "consolidated load" entity, because the Master PRD does not define one.
