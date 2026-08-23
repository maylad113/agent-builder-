import { Router, Request, Response } from 'express';
import { requireAuth, requireRole, asyncHandler } from '../auth';
import { rateLimit, RATE_LIMITS } from '../security';
import {
  createWorker, listWorkers, getWorker, transitionWorkerStatus,
  enqueueTask, getTask, runDispatcherTick, reapStaleTasks
} from './workforce';
import { SalesWorkerRole, SalesChannelType } from '../../types';

/**
 * Sales workforce admin routes (Phase A / Task 34). PLATFORM_OWNER-only.
 * Workers are platform-level execution infrastructure — no customer tenant
 * data, no public execution endpoints, no channel integrations. The
 * dispatcher tick is operator-triggerable for testing/recovery; production
 * scheduling arrives with the Phase B scheduler.
 */
export const salesRouter = Router();

const VALID_ROLES: SalesWorkerRole[] = ['DISCOVERY_RESEARCH', 'PHONE_SALES', 'INSTAGRAM_SALES'];
const VALID_CHANNELS: SalesChannelType[] = ['noop', 'phone', 'instagram_dm'];

function replyError(res: Response, e: any): void {
  const msg = e?.message || 'Request failed.';
  const status = /not found/i.test(msg) ? 404 : /invalid|required|transition/i.test(msg) ? 400 : 500;
  res.status(status).json({ error: msg });
}

salesRouter.get('/workers', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (_req: Request, res: Response) => {
  res.json(await listWorkers());
}));

salesRouter.post('/workers', rateLimit({ ...RATE_LIMITS.generate, prefix: 'sales-worker' }), requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  try {
    const { role, objective, channel, schedule, limits, strategyVersionId } = req.body || {};
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}.` });
    if (!VALID_CHANNELS.includes(channel)) return res.status(400).json({ error: `channel must be one of: ${VALID_CHANNELS.join(', ')}.` });
    const worker = await createWorker({ role, objective, channel, schedule, limits, strategyVersionId });
    res.status(201).json(worker);
  } catch (e: any) {
    replyError(res, e);
  }
}));

salesRouter.post('/workers/:id/status', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  try {
    const worker = await transitionWorkerStatus(String(req.params.id), String(req.body?.status) as any);
    res.json(worker);
  } catch (e: any) {
    replyError(res, e);
  }
}));

salesRouter.post('/workers/:id/tasks', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  try {
    const { type, payload, idempotencyKey, availableAt } = req.body || {};
    const task = await enqueueTask({ workerId: String(req.params.id), type, payload, idempotencyKey, availableAt });
    res.status(201).json(task);
  } catch (e: any) {
    replyError(res, e);
  }
}));

salesRouter.get('/tasks/:id', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  const task = await getTask(String(req.params.id));
  if (!task) return res.status(404).json({ error: 'Not found.' });
  res.json(task);
}));

// Operator-triggerable dispatcher tick + stale reaper (testing/recovery). The
// Phase B scheduler will drive the tick; here it is an explicit admin action.
salesRouter.post('/dispatch/tick', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (_req: Request, res: Response) => {
  res.json(await runDispatcherTick());
}));

salesRouter.post('/dispatch/reap-stale', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (_req: Request, res: Response) => {
  res.json({ recovered: await reapStaleTasks() });
}));
