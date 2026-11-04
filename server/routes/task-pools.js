/**
 * Module: Task pools (D#2254)
 * Purpose: REST API for pools of loose ideas from which a task is drawn at
 *          random once a day.
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
 *
 * THE IDEAS TRAVEL WITH THE POOL as a list of titles. A save sends the whole
 * list; ideas that are still in it keep their rest period, the others are
 * removed and new lines are added.
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import { str, bool, collectErrors, MAX_SHORT } from '../middleware/validate.js';
import { isAdminRequest } from '../middleware/require-admin.js';
import { isHouseholdMember, nonMemberMessage } from '../services/household-members.js';
import { todayKey } from '../utils/timezone.js';
import { MAX_ITEMS_PER_POOL, MAX_POOLS, eligibleItems } from '../services/task-pools.js';

const log = createLogger('TaskPools');

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
  pool.items = d.prepare('SELECT id, title, last_drawn_on FROM task_pool_items WHERE pool_id = ? ORDER BY id')
    .all(pool.id).map((i) => ({ ...i, available: available.has(i.id) }));
  pool.enabled = !!pool.enabled;
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
 * `items`: the titles of the ideas, trimmed, without empty lines or duplicates.
 * Not given: `null`, the ideas stay.
 */
function itemTitles(value) {
  if (value === undefined) return { value: null, error: null };
  if (!Array.isArray(value)) return { value: null, error: 'items must be an array.' };
  const titles = [];
  for (const raw of value) {
    const v = str(raw, 'Item', { max: MAX_SHORT, required: false });
    if (v.error) return { value: null, error: v.error };
    if (v.value && !titles.includes(v.value)) titles.push(v.value);
  }
  if (titles.length > MAX_ITEMS_PER_POOL) {
    return { value: null, error: `At most ${MAX_ITEMS_PER_POOL} items per pool.` };
  }
  return { value: titles, error: null };
}

/** Makes the ideas of a pool match `titles`; the ones that stay keep their rest period. */
function syncItems(d, poolId, titles) {
  const stored = d.prepare('SELECT id, title FROM task_pool_items WHERE pool_id = ?').all(poolId);
  const wanted = new Set(titles);
  const have = new Set(stored.map((i) => i.title));
  const del = d.prepare('DELETE FROM task_pool_items WHERE id = ?');
  for (const item of stored) if (!wanted.has(item.title)) del.run(item.id);
  const ins = d.prepare('INSERT INTO task_pool_items (pool_id, title) VALUES (?, ?)');
  for (const title of titles) if (!have.has(title)) ins.run(poolId, title);
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
 * Body: { name, assigned_to?, draw_count?, cooldown_days?, enabled?, items?: string[] }
 * Response: { data: Pool }
 */
router.post('/', (req, res) => {
  try {
    const b = req.body || {};
    const vName = str(b.name, 'Name', { max: MAX_SHORT });
    const vWho = assignee(b.assigned_to, null);
    const vCount = intField(b.draw_count, 'draw_count', 1, 5, 1);
    const vDays = intField(b.cooldown_days, 'cooldown_days', 0, 365, 30);
    const vEnabled = flag(b.enabled, 'enabled', 1);
    const vItems = itemTitles(b.items);
    const errors = collectErrors([vName, vWho, vCount, vDays, vEnabled, vItems]);
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
        INSERT INTO task_pools (name, assigned_to, created_by, draw_count, cooldown_days, enabled)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(vName.value, vWho.value, actingUser(req), vCount.value, vDays.value, vEnabled.value);
      syncItems(d, r.lastInsertRowid, vItems.value ?? []);
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
 * Body: any field of POST; what is missing stays. `items` replaces the whole list.
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
    const vEnabled = flag(b.enabled, 'enabled', pool.enabled);
    const vItems = itemTitles(b.items);
    const errors = collectErrors([vName, vWho, vCount, vDays, vEnabled, vItems]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const d = db.get();
    d.transaction(() => {
      d.prepare(`
        UPDATE task_pools
           SET name = ?, assigned_to = ?, draw_count = ?, cooldown_days = ?, enabled = ?
         WHERE id = ?
      `).run(vName.value, vWho.value, vCount.value, vDays.value, vEnabled.value, pool.id);
      if (vItems.value) syncItems(d, pool.id, vItems.value);
    })();
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

export default router;
