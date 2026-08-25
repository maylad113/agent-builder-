import { Router, Request, Response } from 'express';
import { requireAuth, requireRole, asyncHandler } from '../auth';
import { rateLimit, RATE_LIMITS } from '../security';
import {
  createWorker, listWorkers, getWorker, transitionWorkerStatus,
  enqueueTask, getTask, runDispatcherTick, reapStaleTasks
} from './workforce';
import { enqueueOutreach, getSalesContact, listContactHistory } from './contacts';
import { getConversation, listConversations, listEscalationQueue, listTurns, closeConversation } from './conversations';
import { startScheduler, stopScheduler, schedulerIsRunning } from './scheduler';
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
  const status = /not found/i.test(msg) ? 404
    : /cooldown active/i.test(msg) ? 409
    : /invalid|required|transition|not eligible|dismissed/i.test(msg) ? 400
    : 500;
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

// Scheduler control (Task 35) — PLATFORM_OWNER-only. The controlled tick loop
// (configurable interval, no overlap, graceful start/stop) driving the
// existing dispatcher. No public/customer surface.
salesRouter.post('/scheduler/start', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  const intervalMs = Number(req.body?.intervalMs) || undefined;
  startScheduler({ intervalMs });
  res.json({ running: true });
}));

salesRouter.post('/scheduler/stop', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (_req: Request, res: Response) => {
  stopScheduler();
  res.json({ running: false });
}));

salesRouter.get('/scheduler/status', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (_req: Request, res: Response) => {
  res.json({ running: schedulerIsRunning() });
}));

// ---------------------------------------------------------------------------
// Task 37: sales contact assignment + outreach ledger (PLATFORM_OWNER-only).
// The channel is derived server-side from the WORKER row — a client-supplied
// `channel` in the body is ignored. Eligibility is derived from the prospect row.
// ---------------------------------------------------------------------------

salesRouter.post('/prospects/:id/assign', rateLimit({ ...RATE_LIMITS.generate, prefix: 'sales-assign' }), requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  try {
    const prospectId = String(req.params.id || '');
    const workerId = String(req.body?.workerId || '');
    if (!prospectId || prospectId.length > 200) return res.status(400).json({ error: 'A valid prospect id is required.' });
    if (!workerId || workerId.length > 200) return res.status(400).json({ error: 'A valid workerId is required.' });
    const result = await enqueueOutreach(prospectId, workerId);
    res.status(result.created ? 201 : 200).json({ contact: result.contact, task: result.task, created: result.created });
  } catch (e: any) {
    replyError(res, e);
  }
}));

salesRouter.get('/contacts/:id', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  const contact = await getSalesContact(String(req.params.id));
  if (!contact) return res.status(404).json({ error: 'Not found.' });
  res.json(contact);
}));

salesRouter.get('/contacts/:id/history', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id || '');
  if (!id || id.length > 200) return res.status(400).json({ error: 'A valid contact id is required.' });
  const { contact, attempts } = await listContactHistory(id);
  if (!contact) return res.status(404).json({ error: 'Not found.' });
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  res.json({ contact, attempts: attempts.slice(-limit) });
}));

// ---------------------------------------------------------------------------
// Task 42: sales conversations + human escalation (PLATFORM_OWNER-only).
// Read-only conversation views + the human resolution route. Escalation is
// initiated by server-side logic; routes never set conversation ids, provider
// ids, or bypass the state machine.
// ---------------------------------------------------------------------------

salesRouter.get('/conversations', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  res.json(await listConversations(limit));
}));

salesRouter.get('/conversations/escalations', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  res.json(await listEscalationQueue(limit));
}));

salesRouter.get('/conversations/:id', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id || '');
  if (!id || id.length > 200) return res.status(400).json({ error: 'A valid conversation id is required.' });
  const conversation = await getConversation(id);
  if (!conversation) return res.status(404).json({ error: 'Not found.' });
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
  const turns = await listTurns(id, limit);
  res.json({ conversation, turns });
}));

salesRouter.post('/conversations/:id/resolve', requireAuth, requireRole('PLATFORM_OWNER'), asyncHandler(async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || '');
    if (!id || id.length > 200) return res.status(400).json({ error: 'A valid conversation id is required.' });
    res.json(await closeConversation(id));
  } catch (e: any) {
    replyError(res, e);
  }
}));
