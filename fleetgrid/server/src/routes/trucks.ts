import { Router } from 'express';
import { z } from 'zod';
import { db } from '../store/db.js';
import { createTruck, departTruck, getTruck, listTrucks } from '../services/trucks.js';
import { asyncHandler } from '../middleware/errors.js';
import { validateBody } from '../middleware/validate.js';
import { requiredParam } from '../middleware/params.js';

export const trucksRouter: Router = Router();

const createTruckSchema = z.object({
  id: z.string().min(2).max(32).optional(),
  organizationId: z.string().min(2),
  registrationNo: z.string().min(2),
  capacityT: z.number().positive(),
  availableT: z.number().positive().optional(),
  origin: z.string().min(2),
  destination: z.string().min(2),
  driverId: z.string().min(2).nullish(),
  departureAt: z.string().datetime().nullish(),
  lat: z.number().optional(),
  lng: z.number().optional(),
});

trucksRouter.get(
  '/trucks',
  asyncHandler(async (_req, res) => {
    res.json({ trucks: await listTrucks() });
  }),
);

/**
 * GET /drivers — the whole crew, not just whoever is signed in.
 *
 * The Driver screen is scoped to one driver on purpose, which left no way to see
 * the rest of the fleet. This joins each driver to their truck, their current lane,
 * and the load currently waiting on them, so a decline can be traced to a named
 * person and the roster reads like a real fleet rather than a single row.
 */
trucksRouter.get(
  '/drivers',
  asyncHandler(async (_req, res) => {
    const [drivers, trucks, users, shipments, offers] = await Promise.all([
      db.drivers.get(),
      db.trucks.get(),
      db.users.get(),
      db.shipments.get(),
      db.capacityOffers.get(),
    ]);

    const rows = drivers.map((d) => {
      const truck = d.assignedTruckId ? trucks.find((t) => t.id === d.assignedTruckId) ?? null : null;
      const user = users.find((u) => u.id === d.userId) ?? null;
      const offer = truck ? offers.find((o) => o.truckId === truck.id) ?? null : null;
      const live = shipments.filter(
        (s) => s.truckId === truck?.id && s.status !== 'DELIVERED' && s.status !== 'DRAFT',
      );
      const awaiting = live.filter((s) => s.status === 'CAPACITY_RESERVED');

      return {
        ...d,
        userName: user?.name ?? null,
        contact: user?.contact ?? d.phone,
        truckId: truck?.id ?? null,
        truckRegistrationNo: truck?.registrationNo ?? null,
        truckStatus: truck?.status ?? null,
        capacityT: truck?.capacityT ?? null,
        availableT: truck?.availableT ?? null,
        lane: truck ? `${truck.origin} → ${truck.destination}` : null,
        departureAt: truck?.departureAt ?? null,
        pricePerT: offer?.pricePerT ?? null,
        activeShipments: live.length,
        awaitingApproval: awaiting.length,
        awaitingShipmentIds: awaiting.map((s) => s.id),
      };
    });

    rows.sort((a, b) => (a.truckId ?? 'zzz').localeCompare(b.truckId ?? 'zzz'));
    res.json({
      drivers: rows,
      counts: {
        total: rows.length,
        onATruck: rows.filter((r) => r.truckId).length,
        awaitingApproval: rows.reduce((n, r) => n + r.awaitingApproval, 0),
      },
    });
  }),
);

trucksRouter.get(
  '/trucks/:id',
  asyncHandler(async (req, res) => {
    const truck = await getTruck(requiredParam(req, 'id'));
    const shipments = await db.shipments.find((s) => s.truckId === truck.id);
    const offer = (await db.capacityOffers.find((o) => o.truckId === truck.id))[0] ?? null;
    const driver = truck.driverId ? await db.drivers.findById(truck.driverId) : undefined;
    const incidents = await db.incidents.find((i) => i.truckId === truck.id);
    res.json({ truck, driver: driver ?? null, capacityOffer: offer, shipments, incidents });
  }),
);

trucksRouter.post(
  '/trucks',
  validateBody(createTruckSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json({ truck: await createTruck(req.body) });
  }),
);

const departSchema = z.object({
  driverId: z.string().min(2).nullish(),
});

/** POST /trucks/:id/depart — truck ASSIGNED → IN_TRANSIT, shipments → IN_TRANSIT. */
trucksRouter.post(
  '/trucks/:id/depart',
  validateBody(departSchema),
  asyncHandler(async (req, res) => {
    const { driverId } = req.body as { driverId?: string | null };
    const result = await departTruck(requiredParam(req, 'id'), driverId ?? null);
    res.json({
      ok: true,
      truck: result.truck,
      truckStatus: result.truck.status,
      shipments: result.shipments,
      shipmentIds: result.shipments.map((s) => s.id),
    });
  }),
);
