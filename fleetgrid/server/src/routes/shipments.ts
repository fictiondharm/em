import { Router } from 'express';
import { z } from 'zod';
import {
  confirmDelivery,
  confirmShipment,
  createShipment,
  declineShipment,
  getShipment,
  listShipments,
  shipmentTimeline,
  MAX_SHIPMENT_WEIGHT_T,
} from '../services/shipments.js';
import { asyncHandler } from '../middleware/errors.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import { requiredParam } from '../middleware/params.js';

export const shipmentsRouter: Router = Router();

const createShipmentSchema = z.object({
  shipperId: z.string().min(2),
  cargoName: z.string().min(2).max(120),
  reference: z.string().max(64).nullish(),
  origin: z.string().min(2),
  destination: z.string().min(2),
  weightT: z.number().positive().max(MAX_SHIPMENT_WEIGHT_T),
  deadlineAt: z.string().datetime().nullish(),
  capacityOfferId: z.string().min(2).nullish(),
  actorId: z.string().min(2).nullish(),
});

/**
 * POST /shipments
 *
 * With `capacityOfferId`, one atomic call creates the shipment and reserves the
 * capacity (DRAFT → CAPACITY_RESERVED), decrementing the truck's spare tonnage.
 * It stops there on purpose: the driver has not agreed to carry the load yet, so
 * `confirmed` comes back false and `awaitingDriverApproval` is true. The driver
 * accepts with `POST /shipments/:id/confirm`.
 * Without `capacityOfferId`, a plain DRAFT shipment is created.
 */
shipmentsRouter.post(
  '/shipments',
  validateBody(createShipmentSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createShipmentSchema>;
    const result = await createShipment({
      shipperId: body.shipperId,
      cargoName: body.cargoName,
      reference: body.reference ?? null,
      origin: body.origin,
      destination: body.destination,
      weightT: body.weightT,
      deadlineAt: body.deadlineAt ?? null,
      capacityOfferId: body.capacityOfferId ?? null,
      actorType: 'BUSINESS',
      actorId: body.actorId ?? null,
    });
    res.status(201).json({
      ok: true,
      shipment: result.shipment,
      reserved: result.reserved,
      confirmed: result.confirmed,
      awaitingDriverApproval: result.awaitingDriverApproval,
    });
  }),
);

const listQuerySchema = z.object({
  status: z.string().optional(),
  truckId: z.string().optional(),
});

shipmentsRouter.get(
  '/shipments',
  validateQuery(listQuerySchema),
  asyncHandler(async (_req, res) => {
    const query = res.locals.query as z.infer<typeof listQuerySchema>;
    const shipments = await listShipments(query);
    res.json({ shipments, count: shipments.length });
  }),
);

shipmentsRouter.get(
  '/shipments/:id',
  asyncHandler(async (req, res) => {
    res.json({ shipment: await getShipment(requiredParam(req, 'id')) });
  }),
);

/**
 * POST /shipments/:id/confirm — the driver's accept. CAPACITY_RESERVED → CONFIRMED.
 *
 * This is the approval gate: a reserved shipment stays pending until the driver
 * calls this, so a business can never unilaterally confirm a load onto a truck.
 */
shipmentsRouter.post(
  '/shipments/:id/confirm',
  asyncHandler(async (req, res) => {
    const result = await confirmShipment(requiredParam(req, 'id'), { actorType: 'DRIVER' });
    // `notifications` tells the caller the requester was notified, so the response
    // does not claim a notification it did not create.
    res.json({ ok: true, shipment: result.shipment, acceptedBy: 'DRIVER', notifications: result.notifications });
  }),
);

const declineSchema = z.object({
  reason: z.string().max(240).nullish(),
  actorId: z.string().min(2).nullish(),
});

/**
 * POST /shipments/:id/decline — the driver says no.
 *
 * Releases the reserved tonnage back to the truck and its offer, and returns the
 * shipment to DRAFT (Master PRD §7 defines no CANCELLED state). The business can
 * then re-book onto another truck.
 */
shipmentsRouter.post(
  '/shipments/:id/decline',
  validateBody(declineSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof declineSchema>;
    const result = await declineShipment(requiredParam(req, 'id'), {
      reason: body.reason ?? null,
      actorType: 'DRIVER',
      actorId: body.actorId ?? null,
    });
      res.json({
        ok: true,
        declined: true,
        shipment: result.shipment,
        releasedTruck: result.truck,
        releasedOffer: result.offer,
        // The requester and the operator are told the load was declined, so a decline
        // is never a silent rollback on the shipper's screen.
        notifications: result.notifications,
      });
  }),
);

/** GET /shipments/:id/timeline — append-only event history for one shipment. */
shipmentsRouter.get(
  '/shipments/:id/timeline',
  asyncHandler(async (req, res) => {
    res.json(await shipmentTimeline(requiredParam(req, 'id')));
  }),
);

const confirmDeliverySchema = z.object({
  actorId: z.string().min(2).nullish(),
});

/**
 * POST /shipments/:id/confirm-delivery — IN_TRANSIT → DELIVERED.
 *
 * The business confirms receipt. The state machine is enforced in the service, so
 * confirming a shipment that never departed returns 409 rather than a silent write.
 */
shipmentsRouter.post(
  '/shipments/:id/confirm-delivery',
  validateBody(confirmDeliverySchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof confirmDeliverySchema>;
    const result = await confirmDelivery(requiredParam(req, 'id'), {
      actorType: 'BUSINESS',
      actorId: body.actorId ?? null,
    });
    res.json({
      ok: true,
      shipment: result.shipment,
      truck: result.truck,
      truckCompleted: result.truckCompleted,
      ...(result.truckNote ? { truckNote: result.truckNote } : {}),
    });
  }),
);
