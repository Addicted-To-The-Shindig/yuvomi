/**
 * Module: Task pools (D#2254)
 * Purpose: REST API for pools of loose ideas from which tasks are drawn at
 *          random on a schedule - pools, ideas and the manual draw.
 * Dependencies: express, server/db.js, services/task-pools.js
 *
 * NOT A MODULE OF ITS OWN. A pool creates tasks and belongs to the tasks
 * module: its permissions and its token scope (`tasks`, see scopes.js) apply
 * here.
 *
 * SHARED OR PERSONAL is a property of the pool (`assigned_to`): NULL means
 * shared - the drawn task belongs to nobody and whoever comes first takes it.
 * With a person, exactly that person gets the task.
 *
 * THE HOUSEHOLD MAY LOOK, ONLY THE CREATOR, THE ASSIGNED PERSON AND AN ADMIN
 * MAY CHANGE. The drawn tasks are visible to everyone; the pool behind them
 * should be too.
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import { str, bool, collectErrors, MAX_SHORT } from '../middleware/validate.js';
import { isAdminRequest } from '../middleware/require-admin.js';
import { isHouseholdMember, nonMemberMessage } from '../services/household-members.js';
import { todayKey } from '../utils/timezone.js';
import {
  ALL_WEEKDAYS, MAX_ITEMS_PER_POOL, MAX_POOLS, drawFromPool, eligibleItems, maskToWeekdays, visibleItems,
  weekdaysToMask,
} from '../services/task-pools.js';

const log = createLogger('TaskPools');

/** The same cap as the point value of a task (routes/tasks.js). */
const MAX_POINTS = 10000;

const REMIND_SCOPES = ['all', 'creator'];

const router = express.Router();

const actingUser = (req) => req.authUserId || req.session?.userId || null;

function mayEdit(pool, req) {
  const me = actingUser(req);
  return isAdminRequest(req) || pool.created_by === me || (pool.assigned_to != null && pool.assigned_to === me);
}

function fail500(res, err) {
  log.error('', err);
  res.status(500).json({ error: 'Internal server error.', code: 500 });
}

/**
 * A pool with its ideas, the name of its person and, per idea, whether it could
 * be drawn right now. Read-only: a GET never changes data.
 */
function loadPool(poolId, req) {
  const d = db.get();
  const pool = d.prepare(`
    SELECT p.*, u.display_name AS assigned_name
      FROM task_pools p LEFT JOIN users u ON u.id = p.assigned_to
     WHERE p.id = ?
  `).get(poolId);
  if (!pool) return null;
  const available = new Set(eligibleItems(d, pool, todayKey(d)).map((i) => i.id));
  pool.items = visibleItems(d, pool).map((i) => ({ ...i, available: available.has(i.id) }));
  pool.enabled = !!pool.enabled;
  pool.weekdays = maskToWeekdays(pool.weekdays);
  pool.retire_done = !!pool.retire_done;
  pool.skip_if_open = !!pool.skip_if_open;
  pool.no_due_date = !!pool.no_due_date;
  pool.can_edit = mayEdit(pool, req);
  return pool;
}

function listPools(req) {
  return db.get().prepare('SELECT id FROM task_pools ORDER BY id').all().map((r) => loadPool(r.id, req));
}

/** Whole number in [min, max]; not given: `fallback`. */
function intField(value, field, min, max, fallback) {
  if (value === undefined || value === null || value === '') return { value: fallback, error: null };
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    return { value: null, error: `${field} must be a whole number between ${min} and ${max}.` };
  }
  return { value: n, error: null };
}

/** A flag that stays as it is when not given and must be a real boolean otherwise. */
function flag(value, field, current) {
  if (value === undefined) return { value: current, error: null };
  const checked = bool(value, field);
  return checked.error ? checked : { value: checked.value ? 1 : 0, error: null };
}

/**
 * `assigned_to`: undefined stays, null/'' means shared, otherwise a household
 * member. The person a pool already has stays valid even if they have left the
 * household since - saving the pool must not fail on something it did not change.
 * Not `newNonMembers()`: that one lets an id through that does not exist at all,
 * and here the column is a foreign key.
 */
function assignee(value, current) {
  if (value === undefined) return { value: current, error: null };
  if (value === null || value === '') return { value: null, error: null };
  const n = Number(value);
  if (n !== current && (!Number.isInteger(n) || n < 1 || !isHouseholdMember(n))) {
    return { value: null, error: nonMemberMessage([value]) };
  }
  return { value: n, error: null };
}

/**
 * `category`: a key of task_categories. The category a pool already has stays
 * valid even if it has been deleted since (the draw falls back to 'misc'), for
 * the same reason as the assigned person: saving must not fail on something it
 * did not change.
 */
function categoryKey(value, current) {
  if (value === undefined) return { value: current, error: null };
  if (typeof value !== 'string' || !value) return { value: null, error: 'category must be a task category.' };
  if (value !== current && !db.get().prepare('SELECT 1 FROM task_categories WHERE key = ?').get(value)) {
    return { value: null, error: 'category must be an existing task category.' };
  }
  return { value, error: null };
}

/** `remind_time`: HH:MM in household time; null or '' means no time and no reminder. */
function timeOfDay(value, current) {
  if (value === undefined) return { value: current, error: null };
  if (value === null || value === '') return { value: null, error: null };
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    return { value: null, error: 'remind_time must be a time like 09:30.' };
  }
  return { value, error: null };
}

/** `remind_scope`: who the reminder of a shared pool reaches. */
function remindScope(value, current) {
  if (value === undefined) return { value: current, error: null };
  if (!REMIND_SCOPES.includes(value)) return { value: null, error: `remind_scope must be one of: ${REMIND_SCOPES.join(', ')}.` };
  return { value, error: null };
}

/**
 * `weekdays`: list of weekdays 1 (Monday) to 7 (Sunday), at least one.
 * Not given: `current` (the mask as stored) stays.
 */
function weekdayMask(value, current) {
  if (value === undefined) return { value: current, error: null };
  const mask = weekdaysToMask(value);
  if (mask === null) return { value: null, error: 'weekdays must list at least one day from 1 (Monday) to 7 (Sunday).' };
  return { value: mask, error: null };
}

/**
 * GET /api/v1/task-pools
 * Response: { data: Pool[] } - each pool with `items` (each with `available`) and `can_edit`.
 */
router.get('/', (req, res) => {
  try {
    res.json({ data: listPools(req) });
  } catch (err) { fail500(res, err); }
});

/**
 * POST /api/v1/task-pools
 * Body: { name, assigned_to?, draw_count?, cooldown_days?, interval_days?, weekdays?, category?, points?,
 *         remind_time?, remind_scope?, retire_done?, skip_if_open?, no_due_date?, enabled?, items?: string[] }
 * Response: { data: Pool }
 */
router.post('/', (req, res) => {
  try {
    const b = req.body || {};
    const vName = str(b.name, 'Name', { max: MAX_SHORT });
    const vWho = assignee(b.assigned_to, null);
    const vCount = intField(b.draw_count, 'draw_count', 1, 5, 1);
    const vDays = intField(b.cooldown_days, 'cooldown_days', 0, 365, 30);
    const vEvery = intField(b.interval_days, 'interval_days', 1, 365, 1);
    const vWeek = weekdayMask(b.weekdays, ALL_WEEKDAYS);
    const vCategory = categoryKey(b.category, 'misc');
    const vPoints = intField(b.points, 'points', 0, MAX_POINTS, 0);
    const vTime = timeOfDay(b.remind_time, null);
    const vScope = remindScope(b.remind_scope, 'all');
    const vRetire = flag(b.retire_done, 'retire_done', 0);
    const vSkip = flag(b.skip_if_open, 'skip_if_open', 0);
    const vNoDue = flag(b.no_due_date, 'no_due_date', 0);
    const vEnabled = flag(b.enabled, 'enabled', 1);
    const errors = collectErrors([vName, vWho, vCount, vDays, vEvery, vWeek, vCategory, vPoints, vTime, vScope,
      vRetire, vSkip, vNoDue, vEnabled]);
    const items = [];
    if (b.items !== undefined) {
      if (!Array.isArray(b.items)) errors.push('items must be an array.');
      else if (b.items.length > MAX_ITEMS_PER_POOL) errors.push(`At most ${MAX_ITEMS_PER_POOL} items per pool.`);
      else {
        for (const raw of b.items) {
          const v = str(raw, 'Item', { max: MAX_SHORT, required: false });
          if (v.error) errors.push(v.error); else if (v.value) items.push(v.value);
        }
      }
    }
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const d = db.get();
    if (d.prepare('SELECT COUNT(*) AS n FROM task_pools').get().n >= MAX_POOLS) {
      return res.status(400).json({
        error: `At most ${MAX_POOLS} pools can be created.`, code: 400,
        reason: 'task_pools_limit_reached', params: { limit: MAX_POOLS },
      });
    }

    const poolId = d.transaction(() => {
      const r = d.prepare(`
        INSERT INTO task_pools (name, assigned_to, created_by, draw_count, cooldown_days, interval_days, weekdays,
                                category, points, remind_time, retire_done, skip_if_open, no_due_date, remind_scope, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(vName.value, vWho.value, actingUser(req), vCount.value, vDays.value,
        vEvery.value, vWeek.value, vCategory.value, vPoints.value, vTime.value, vRetire.value, vSkip.value,
        vNoDue.value, vScope.value, vEnabled.value);
      const ins = d.prepare('INSERT INTO task_pool_items (pool_id, title) VALUES (?, ?)');
      for (const title of items) ins.run(r.lastInsertRowid, title);
      return Number(r.lastInsertRowid);
    })();
    res.status(201).json({ data: loadPool(poolId, req) });
  } catch (err) { fail500(res, err); }
});

function findEditable(req, res) {
  const pool = db.get().prepare('SELECT * FROM task_pools WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!pool) {
    res.status(404).json({ error: 'Pool not found.', code: 404, reason: 'task_pools_pool_not_found' });
    return null;
  }
  if (!mayEdit(pool, req)) {
    res.status(403).json({ error: 'You cannot modify this entry.', code: 403 });
    return null;
  }
  return pool;
}

/**
 * PUT /api/v1/task-pools/:id
 * Body: any field of POST except `items`; what is missing stays.
 * Response: { data: Pool }
 */
router.put('/:id', (req, res) => {
  try {
    const pool = findEditable(req, res);
    if (!pool) return;
    const b = req.body || {};
    const vName = b.name !== undefined ? str(b.name, 'Name', { max: MAX_SHORT }) : { value: pool.name, error: null };
    const vWho = assignee(b.assigned_to, pool.assigned_to);
    const vCount = intField(b.draw_count, 'draw_count', 1, 5, pool.draw_count);
    const vDays = intField(b.cooldown_days, 'cooldown_days', 0, 365, pool.cooldown_days);
    const vEvery = intField(b.interval_days, 'interval_days', 1, 365, pool.interval_days);
    const vWeek = weekdayMask(b.weekdays, pool.weekdays);
    const vCategory = categoryKey(b.category, pool.category);
    const vPoints = intField(b.points, 'points', 0, MAX_POINTS, pool.points);
    const vTime = timeOfDay(b.remind_time, pool.remind_time);
    const vScope = remindScope(b.remind_scope, pool.remind_scope);
    const vRetire = flag(b.retire_done, 'retire_done', pool.retire_done);
    const vSkip = flag(b.skip_if_open, 'skip_if_open', pool.skip_if_open);
    const vNoDue = flag(b.no_due_date, 'no_due_date', pool.no_due_date);
    const vEnabled = flag(b.enabled, 'enabled', pool.enabled);
    const errors = collectErrors([vName, vWho, vCount, vDays, vEvery, vWeek, vCategory, vPoints, vTime, vScope,
      vRetire, vSkip, vNoDue, vEnabled]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    db.get().prepare(`
      UPDATE task_pools
         SET name = ?, assigned_to = ?, draw_count = ?, cooldown_days = ?, interval_days = ?, weekdays = ?,
             category = ?, points = ?, remind_time = ?, retire_done = ?, skip_if_open = ?, no_due_date = ?,
             remind_scope = ?, enabled = ?
       WHERE id = ?
    `).run(vName.value, vWho.value, vCount.value, vDays.value, vEvery.value, vWeek.value,
      vCategory.value, vPoints.value, vTime.value, vRetire.value, vSkip.value, vNoDue.value, vScope.value,
      vEnabled.value, pool.id);
    res.json({ data: loadPool(pool.id, req) });
  } catch (err) { fail500(res, err); }
});

/**
 * DELETE /api/v1/task-pools/:id
 * Tasks already drawn stay - they are ordinary tasks.
 */
router.delete('/:id', (req, res) => {
  try {
    const pool = findEditable(req, res);
    if (!pool) return;
    db.get().prepare('DELETE FROM task_pools WHERE id = ?').run(pool.id);
    res.status(204).end();
  } catch (err) { fail500(res, err); }
});

/**
 * POST /api/v1/task-pools/:id/items
 * Body: { title }
 * Response: { data: Pool }
 */
router.post('/:id/items', (req, res) => {
  try {
    const pool = findEditable(req, res);
    if (!pool) return;
    const v = str(req.body?.title, 'Title', { max: MAX_SHORT });
    if (v.error) return res.status(400).json({ error: v.error, code: 400 });
    const d = db.get();
    if (d.prepare('SELECT COUNT(*) AS n FROM task_pool_items WHERE pool_id = ?').get(pool.id).n >= MAX_ITEMS_PER_POOL) {
      return res.status(400).json({
        error: `At most ${MAX_ITEMS_PER_POOL} items per pool.`, code: 400,
        reason: 'task_pools_items_limit_reached', params: { limit: MAX_ITEMS_PER_POOL },
      });
    }
    d.prepare('INSERT INTO task_pool_items (pool_id, title) VALUES (?, ?)').run(pool.id, v.value);
    res.status(201).json({ data: loadPool(pool.id, req) });
  } catch (err) { fail500(res, err); }
});

/**
 * PUT /api/v1/task-pools/:id/items/:itemId
 * Body: { title }
 * Renames an idea. It stays the SAME idea: its cooldown and the link to the task
 * of its last draw are untouched. Deleting it and adding another would turn a
 * corrected typo into a new idea that may be drawn again while the old task is
 * still open.
 * Response: { data: Pool }
 */
router.put('/:id/items/:itemId', (req, res) => {
  try {
    const pool = findEditable(req, res);
    if (!pool) return;
    const v = str(req.body?.title, 'Title', { max: MAX_SHORT });
    if (v.error) return res.status(400).json({ error: v.error, code: 400 });
    const r = db.get().prepare('UPDATE task_pool_items SET title = ? WHERE id = ? AND pool_id = ?')
      .run(v.value, parseInt(req.params.itemId, 10), pool.id);
    if (!r.changes) {
      return res.status(404).json({ error: 'Item not found.', code: 404 });
    }
    res.json({ data: loadPool(pool.id, req) });
  } catch (err) { fail500(res, err); }
});

/**
 * DELETE /api/v1/task-pools/:id/items/:itemId
 * Response: { data: Pool }
 */
router.delete('/:id/items/:itemId', (req, res) => {
  try {
    const pool = findEditable(req, res);
    if (!pool) return;
    const r = db.get().prepare('DELETE FROM task_pool_items WHERE id = ? AND pool_id = ?')
      .run(parseInt(req.params.itemId, 10), pool.id);
    if (!r.changes) {
      return res.status(404).json({ error: 'Item not found.', code: 404 });
    }
    res.json({ data: loadPool(pool.id, req) });
  } catch (err) { fail500(res, err); }
});

/**
 * POST /api/v1/task-pools/:id/draw
 * Draws right away, outside the schedule. Counts as the draw of the day.
 * Response: { data: { tasks: {id, title}[], pool: Pool } }
 */
router.post('/:id/draw', (req, res) => {
  try {
    const pool = findEditable(req, res);
    if (!pool) return;
    const created = drawFromPool(db.get(), pool, { today: todayKey(db.get()) });
    if (!created.length) {
      return res.status(409).json({
        error: 'Nothing to draw: every item is cooling down or still open.', code: 409,
        reason: 'task_pools_nothing_to_draw',
      });
    }
    res.json({ data: { tasks: created.map(({ id, title }) => ({ id, title })), pool: loadPool(pool.id, req) } });
  } catch (err) { fail500(res, err); }
});

export default router;
