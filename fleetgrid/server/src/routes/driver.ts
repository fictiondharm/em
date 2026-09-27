import { Router } from 'express';
import { z } from 'zod';
import { driverOffers } from '../services/shipments.js';
import { driverRequests } from '../services/loadRequests.js';
import { asyncHandler } from '../middleware/errors.js';
import { validateQuery } from '../middleware/validate.js';

export const driverRouter: Router = Router();

const driverQuerySchema = z.object({
  driverId: z.string().min(2),
});

/**
 * GET /driver/offers - the approval queue.
 *
 * A read model over existing rows, not a new entity. `pending` is exactly the set of
 * shipments sitting in CAPACITY_RESERVED on the driver's own truck, which is the same
 * condition `POST /shipments/:id/confirm` and `/decline` accept, so what the driver
 * sees and what the state machine allows can never drift apart.
 */
driverRouter.get(
  '/driver/offers',
  validateQuery(driverQuerySchema),
  asyncHandler(async (_req, res) => {
    const query = res.locals.query as z.infer<typeof driverQuerySchema>;
    const result = await driverOffers(query.driverId);
    res.json({
      ...result,
      counts: { pending: result.pending.length, accepted: result.accepted.length },
      note:
        'Accepting runs CAPACITY_RESERVED -> CONFIRMED. Declining releases the tonnage and returns the shipment to DRAFT.',
    });
  }),
);

/**
 * GET /driver/requests - the broadcast board for one driver.
 *
 * Where `/driver/offers` is "loads reserved on my own truck", this is "loads the shipper
 * asked me to carry". One request can sit in front of many drivers at once, so each row
 * says how many others are still holding it, and anything lost to a faster driver comes
 * back under `lost` instead of vanishing.
 */
driverRouter.get(
  '/driver/requests',
  validateQuery(driverQuerySchema),
  asyncHandler(async (_req, res) => {
    const query = res.locals.query as z.infer<typeof driverQuerySchema>;
    const result = await driverRequests(query.driverId);
    res.json({
      ...result,
      counts: { open: result.open.length, won: result.won.length, lost: result.lost.length },
      note:
        'First accept wins: the load is bound to that truck and closed for everyone else. Declining only removes you from it.',
    });
  }),
);
