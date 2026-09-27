import { Router } from 'express';
import { z } from 'zod';
import {
  acceptLoadRequest,
  declineLoadRequest,
  eligibleDriversFor,
  loadRequestBoard,
  openLoadRequest,
} from '../services/loadRequests.js';
import { asyncHandler } from '../middleware/errors.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import { requiredParam } from '../middleware/params.js';
import { MAX_SHIPMENT_WEIGHT_T } from '../services/shipments.js';

export const loadRequestsRouter: Router = Router();

const openRequestSchema = z.object({
  shipperId: z.string().min(2),
  cargoName: z.string().min(2).max(120),
  reference: z.string().max(64).nullish(),
  origin: z.string().min(2),
  destination: z.string().min(2),
  weightT: z.number().positive().max(MAX_SHIPMENT_WEIGHT_T),
  deadlineAt: z.string().datetime().nullish(),
  actorId: z.string().min(2).nullish(),
});

const driverActionSchema = z.object({
  driverId: z.string().min(2),
  reason: z.string().max(240).nullish(),
  actorId: z.string().min(2).nullish(),
});

const eligibilityQuerySchema = z.object({
  origin: z.string().min(2),
  destination: z.string().min(2),
  weightT: z.coerce.number().positive(),
});

/**
 * POST /load-requests - open one request to every driver who can take it.
 *
 * The counterpart to `POST /shipments` with a `capacityOfferId`. That one books a
 * specific truck; this one states a lane and a weight and lets the fleet compete. No
 * truck is bound and no tonnage is held until a driver accepts, so the honest response
 * is how many drivers were asked, not a fake reservation.
 *
 * Refuses to open a request nobody can see: a board with zero drivers is not an open
 * request, it is a dead end for the shipper.
 */
loadRequestsRouter.post(
  '/load-requests',
  validateBody(openRequestSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof openRequestSchema>;
    const result = await openLoadRequest({
      shipperId: body.shipperId,
      cargoName: body.cargoName,
      reference: body.reference ?? null,
      origin: body.origin,
      destination: body.destination,
      weightT: body.weightT,
      deadlineAt: body.deadlineAt ?? null,
      actorType: 'BUSINESS',
      actorId: body.actorId ?? null,
    });
    res.status(201).json({
      ok: true,
      shipment: result.shipment,
      board: result.board,
      askedCount: result.board.counts.asked,
      notifications: result.notifications,
    });
  }),
);

/**
 * GET /load-requests/eligible - who could take this, and who cannot and why.
 *
 * Read-only preview of the same rules `POST /load-requests` applies, so the shipper can
 * see the field before committing to a request rather than discovering it after.
 */
loadRequestsRouter.get(
  '/load-requests/eligible',
  validateQuery(eligibilityQuerySchema),
  asyncHandler(async (_req, res) => {
    const query = res.locals.query as z.infer<typeof eligibilityQuerySchema>;
    const { eligible, rejected } = await eligibleDriversFor(query);
    res.json({
      ok: true,
      eligible,
      rejected,
      counts: { eligible: eligible.length, rejected: rejected.length },
      note: 'Eligibility uses the same corridor, tonnage and duty rules that accept enforces.',
    });
  }),
);

/**
 * GET /load-requests/:id/board - who got this request and who has answered.
 *
 * The "who all got it" view. Read from the ask list frozen at open time, so it still
 * tells the truth after the load is taken or closed.
 */
loadRequestsRouter.get(
  '/load-requests/:id/board',
  asyncHandler(async (req, res) => {
    const board = await loadRequestBoard(requiredParam(req, 'id'));
    res.json({ ok: true, ...board });
  }),
);

/**
 * POST /load-requests/:id/accept - first accept takes the load.
 *
 * A 409 here is a normal outcome, not an error to hide: it means another driver got
 * there first, and the body names them. The board comes back so the losing tab can
 * replace the action with a result immediately.
 */
loadRequestsRouter.post(
  '/load-requests/:id/accept',
  validateBody(driverActionSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof driverActionSchema>;
    const result = await acceptLoadRequest(requiredParam(req, 'id'), {
      driverId: body.driverId,
      actorId: body.actorId ?? null,
    });
    res.json({
      ok: true,
      // The driver's own id, so the tab that just won can confirm it is the one on the
      // board instead of trusting a literal.
      acceptedBy: body.driverId,
      shipment: result.shipment,
      board: result.board,
      notifications: result.notifications,
    });
  }),
);

/**
 * POST /load-requests/:id/decline - pass, and let the rest of the fleet decide.
 *
 * `stillOpen` is the field that matters: a decline is not a cancellation, so the load
 * survives unless the driver saying no was the last one holding it.
 */
loadRequestsRouter.post(
  '/load-requests/:id/decline',
  validateBody(driverActionSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof driverActionSchema>;
    const result = await declineLoadRequest(requiredParam(req, 'id'), {
      driverId: body.driverId,
      reason: body.reason ?? null,
      actorId: body.actorId ?? null,
    });
    res.json({
      ok: true,
      declinedBy: body.driverId,
      shipment: result.shipment,
      board: result.board,
      stillOpen: result.stillOpen,
      notifications: result.notifications,
    });
  }),
);
