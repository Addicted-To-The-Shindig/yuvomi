/**
 * Module: Task pools (D#2254)
 * Purpose: A list of loose ideas from which the server draws at random on a
 *          schedule. A draw creates an ORDINARY task - due today, with points,
 *          an optional time and reminder - that behaves like any other task.
 * Dependencies: a synchronous SQLite handle passed in by the caller;
 *          utils/timezone.js for "today" and the household zone;
 *          household-members.js for reminder recipients.
 *
 * DRAWING IS A PURE FUNCTION AND THE RANDOMNESS IS A PARAMETER. `pickItems`
 * takes `pick` like `buildRandomMealAssignments` in the meal planner, so a test
 * fixes the draw instead of guessing it.
 *
 * WHICH IDEAS MAY BE DRAWN: none that is still resting after its last draw, and
 * none whose last task is still open. The cooldown starts with the draw, not
 * with completion; otherwise an ignored idea would never go away, and a
 * completed one would come back the next day.
 */

import { householdTimeZone, localToUTC } from '../utils/timezone.js';
import { householdMemberSql, isHouseholdMember } from './household-members.js';

/** Pools per household and ideas per pool; the caps keep the list readable. */
export const MAX_POOLS = 20;
export const MAX_ITEMS_PER_POOL = 200;

/** Every day of the week, Monday to Sunday, bit 0 to 6. */
export const ALL_WEEKDAYS = 127;

/**
 * The bit of a calendar day (YYYY-MM-DD) in the weekday mask: Monday is bit 0,
 * Sunday bit 6. Computed from the parts instead of `new Date('YYYY-MM-DD')`:
 * that value would be UTC, but a weekday belongs to the calendar day, not to a
 * time zone.
 */
export function weekdayBit(dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const sunday0 = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return 1 << ((sunday0 + 6) % 7);
}

/** Weekdays 1 (Monday) to 7 (Sunday) to a mask - or null for an invalid value. */
export function weekdaysToMask(days) {
  if (!Array.isArray(days) || !days.length) return null;
  let mask = 0;
  for (const day of days) {
    if (!Number.isInteger(day) || day < 1 || day > 7) return null;
    mask |= 1 << (day - 1);
  }
  return mask;
}

/** The mask as a sorted list of weekdays 1 (Monday) to 7 (Sunday). */
export function maskToWeekdays(mask) {
  return [1, 2, 3, 4, 5, 6, 7].filter((day) => mask & (1 << (day - 1)));
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from, to) {
  const at = (key) => {
    const [y, m, d] = String(key).split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((at(to) - at(from)) / 86_400_000);
}

/**
 * Is this pool due today? Enabled, today is a chosen weekday, and at least
 * `interval_days` days have passed since the last draw.
 *
 * THE INTERVAL COUNTS FROM THE LAST DRAW, NOT FROM A FIXED START. A server that
 * was off for three days draws once on startup and counts on from there; a
 * fixed grid would need an anchor date that exists nowhere, and would catch up
 * on missed days. If the due day falls on an unchosen weekday, the pool is due
 * on the next chosen one.
 */
export function isPoolDue(pool, today) {
  if (!pool.enabled) return false;
  if (!(pool.weekdays & weekdayBit(today))) return false;
  return !pool.last_drawn_on || daysBetween(pool.last_drawn_on, today) >= pool.interval_days;
}

/**
 * Draws up to `count` distinct items, without replacement.
 * @param {object[]} items
 * @param {number} count
 * @param {() => number} [pick] returns [0, 1) like Math.random
 * @returns {object[]}
 */
export function pickItems(items, count, pick = Math.random) {
  const pool = [...items];
  const out = [];
  while (pool.length && out.length < count) {
    const r = Math.max(0, Math.min(0.999999, Number(pick()) || 0));
    out.push(pool.splice(Math.floor(r * pool.length), 1)[0]);
  }
  return out;
}

// An idea whose last task is done. Archived tasks do not count: whoever put a
// task away did not do it, and the idea may come back. Without a task the
// expression is NULL, not false - wrap it in COALESCE wherever it is negated.
const DONE_TASK_SQL = "t.status = 'done' AND t.archived_at IS NULL";

/**
 * Removes the ideas whose last task is done from a pool with `retire_done`.
 *
 * LAZY INSTEAD OF HOOKED INTO THE TASK STATUS CHANGE: that change runs in the
 * tasks route, and a hook there would make the tasks depend on pools. It runs
 * where a pool is drawn from and in the hourly run. Reading a pool never
 * deletes anything; `visibleItems` hides the retired ideas until then.
 *
 * A DELETED task does not count as done either: its link is cleared, so the
 * idea is free again.
 *
 * @param {object} d better-sqlite3 connection
 * @param {{id: number, retire_done: number}} pool
 * @returns {number} number of removed ideas
 */
export function retireDoneItems(d, pool) {
  if (!pool.retire_done) return 0;
  return d.prepare(`
    DELETE FROM task_pool_items
     WHERE pool_id = ?
       AND task_id IN (SELECT t.id FROM tasks t WHERE ${DONE_TASK_SQL})
  `).run(pool.id).changes;
}

/**
 * The ideas of a pool as the list shows them: in order, without those a
 * `retire_done` pool is about to remove.
 * @param {object} d better-sqlite3 connection
 * @param {{id: number, retire_done: number}} pool
 * @returns {{id: number, title: string, last_drawn_on: string|null, task_id: number|null}[]}
 */
export function visibleItems(d, pool) {
  return d.prepare(`
    SELECT i.id, i.title, i.last_drawn_on, i.task_id
      FROM task_pool_items i
      LEFT JOIN tasks t ON t.id = i.task_id
     WHERE i.pool_id = @pool
       AND NOT (@retire = 1 AND COALESCE(${DONE_TASK_SQL}, 0))
     ORDER BY i.id
  `).all({ pool: pool.id, retire: pool.retire_done ? 1 : 0 });
}

/**
 * The time of day of a draw as a reminder instant: household time to naive UTC,
 * the way `reminders.remind_at` is read throughout the code base.
 */
export function remindAtFor(d, today, time) {
  return localToUTC(`${today}T${time}:00`, householdTimeZone(d)).replace(/\.\d{3}Z$/, '').replace(/Z$/, '');
}

/**
 * Who is reminded of the drawn task: for a personal pool the one person. For a
 * shared pool the pool's choice (`remind_scope`): everyone in the household -
 * the task belongs to nobody, so anyone may see and take it - or only the
 * member who created the pool.
 *
 * IF THE CREATOR IS GONE (account removed, `created_by` is then NULL, or no
 * longer a member), THE POOL REMINDS EVERYONE. Silently reminding nobody would
 * make a reminder vanish without a trace, and "everyone" is what a shared pool
 * does without the choice anyway.
 */
export function reminderRecipients(d, pool) {
  if (pool.assigned_to) return [pool.assigned_to];
  const members = d.prepare(`SELECT u.id FROM users u WHERE ${householdMemberSql('u')} ORDER BY u.id`).all().map((r) => r.id);
  if (pool.remind_scope === 'creator' && members.includes(pool.created_by)) return [pool.created_by];
  return members;
}

/** The category every task falls back to, like FALLBACK_CATEGORY in routes/tasks.js. */
const FALLBACK_CATEGORY = 'misc';

/**
 * The category of a drawn task: the pool's, if it still exists. A category can be
 * deleted while a pool still names it (only tasks hold one back), and a task in a
 * category that is gone would show up under a bare key.
 */
function drawnCategory(d, pool) {
  const known = d.prepare('SELECT 1 FROM task_categories WHERE key = ?').get(pool.category);
  return known ? pool.category : FALLBACK_CATEGORY;
}

/**
 * Is a task from this pool still open? The last task of each idea is the one the
 * idea points at; an archived task does not count, it was put away.
 *
 * @param {object} d better-sqlite3 connection
 * @param {{id: number}} pool
 * @returns {boolean}
 */
export function hasOpenTask(d, pool) {
  return Boolean(d.prepare(`
    SELECT 1
      FROM task_pool_items i
      JOIN tasks t ON t.id = i.task_id
     WHERE i.pool_id = ? AND t.status != 'done' AND t.archived_at IS NULL
     LIMIT 1
  `).get(pool.id));
}

/**
 * The idea of a draw as a task: category, points, time of day and reminder come
 * from the pool. With `no_due_date` the task has no due date and no due time - a
 * time without a day means nothing - but the reminder still fires at that time.
 * No reminder rows when nobody would get one (a shared pool without members).
 */
function createDrawnTask(d, pool, item, today) {
  const result = d.prepare(`
    INSERT INTO tasks (title, category, priority, status, due_date, due_time, assigned_to, created_by, points, visibility)
    VALUES (?, ?, 'none', 'open', ?, ?, ?, ?, ?, 'all')
  `).run(item.title, drawnCategory(d, pool), pool.no_due_date ? null : today, pool.no_due_date ? null : pool.remind_time,
    pool.assigned_to, pool.assigned_to ?? pool.created_by, pool.points);
  const taskId = Number(result.lastInsertRowid);
  if (pool.assigned_to) {
    d.prepare('INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(taskId, pool.assigned_to);
  }
  if (pool.remind_time) {
    const remindAt = remindAtFor(d, today, pool.remind_time);
    const ins = d.prepare("INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES ('task', ?, ?, ?)");
    for (const userId of reminderRecipients(d, pool)) ins.run(taskId, remindAt, userId);
  }
  return taskId;
}

/**
 * The ideas that may be drawn right now.
 * @param {object} d better-sqlite3 connection
 * @param {{id: number, cooldown_days: number}} pool
 * @param {string} today YYYY-MM-DD in household time
 * @returns {object[]}
 */
export function eligibleItems(d, pool, today) {
  return d.prepare(`
    SELECT i.*
      FROM task_pool_items i
      LEFT JOIN tasks t ON t.id = i.task_id
     WHERE i.pool_id = @pool
       AND (i.last_drawn_on IS NULL
            OR date(i.last_drawn_on, '+' || @days || ' days') <= @today)
       AND (t.id IS NULL OR t.status = 'done' OR t.archived_at IS NOT NULL)
     ORDER BY i.id
  `).all({ pool: pool.id, days: pool.cooldown_days, today });
}

/**
 * Draws from a pool and creates the tasks. Counts as the draw of the day if
 * anything was drawn - a manual draw too, so the run does not draw again the
 * same day. Draws nothing for a personal pool whose person is no longer a
 * household member.
 *
 * @param {object} d better-sqlite3 connection
 * @param {object} pool row of task_pools
 * @param {{ today: string, pick?: () => number }} options
 * @returns {{ id: number, title: string, item_id: number }[]} the created tasks
 */
export function drawFromPool(d, pool, { today, pick = Math.random }) {
  return d.transaction(() => {
    retireDoneItems(d, pool);
    // A personal pool of someone who is no longer a household member is dormant:
    // a task may not be assigned to them any more, and nobody wants reminders
    // for a former member. It wakes up if the pool is given to someone else.
    if (pool.assigned_to && !isHouseholdMember(pool.assigned_to, { db: d })) return [];
    const chosen = pickItems(eligibleItems(d, pool, today), pool.draw_count, pick);
    const created = [];
    for (const item of chosen) {
      const taskId = createDrawnTask(d, pool, item, today);
      d.prepare('UPDATE task_pool_items SET last_drawn_on = ?, task_id = ? WHERE id = ?')
        .run(today, taskId, item.id);
      created.push({ id: taskId, title: item.title, item_id: item.id });
    }
    if (created.length) d.prepare('UPDATE task_pools SET last_drawn_on = ? WHERE id = ?').run(today, pool.id);
    return created;
  })();
}

/**
 * The scheduler run: every pool that is due today (`isPoolDue`) draws once.
 * Every `retire_done` pool is also tidied up, due or not, so finished ideas do
 * not pile up in the table.
 *
 * AN EMPTY DRAW DOES NOT COUNT AS THE DRAW OF THE DAY. If everything is
 * cooling down, the next run tries again - the cooldown ends at midnight, and a
 * newly added idea should not wait until tomorrow. The same goes for a pool that
 * waits for its open task (`skip_if_open`): whoever finishes it in the afternoon
 * gets the next idea within the hour - but never two on one day, because
 * `isPoolDue` asks for a day since the last draw.
 *
 * @param {object} d better-sqlite3 connection
 * @param {{ today: string, pick?: () => number, onError?: (pool: object, err: Error) => void }} options
 * @returns {{ drawn: number, pools: number }}
 */
export function drawDuePools(d, { today, pick = Math.random, onError } = {}) {
  const pools = d.prepare('SELECT * FROM task_pools ORDER BY id').all();
  let drawn = 0;
  let touched = 0;
  for (const pool of pools) {
    try {
      retireDoneItems(d, pool);
      if (!isPoolDue(pool, today)) continue;
      // The scheduled run leaves a pool alone while one of its tasks is open; the
      // manual draw does not ask, whoever presses it wants another one.
      if (pool.skip_if_open && hasOpenTask(d, pool)) continue;
      const created = drawFromPool(d, pool, { today, pick });
      if (created.length) { drawn += created.length; touched += 1; }
    } catch (err) {
      if (onError) onError(pool, err); else throw err;
    }
  }
  return { drawn, pools: touched };
}
