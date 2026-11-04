/**
 * Module: Task pools (D#2254)
 * Purpose: A list of loose ideas from which the server draws at random once a
 *          day. A draw creates an ORDINARY task that behaves like any other.
 * Dependencies: a synchronous SQLite handle passed in by the caller;
 *          household-members.js for the "is this person still a member" check.
 *
 * DRAWING IS A PURE FUNCTION AND THE RANDOMNESS IS A PARAMETER. `pickItems`
 * takes `pick` like `buildRandomMealAssignments` in the meal planner, so a test
 * fixes the draw instead of guessing it.
 *
 * WHICH IDEAS MAY BE DRAWN: none that is still resting after its last draw. The
 * rest period starts with the draw, not with completion; otherwise an ignored
 * idea would never go away, and a completed one would come back the next day.
 */

import { householdMemberSql, isHouseholdMember } from './household-members.js';

/** Pools per household and ideas per pool; the caps keep the list readable. */
export const MAX_POOLS = 20;
export const MAX_ITEMS_PER_POOL = 200;

/** The category every task falls back to, like FALLBACK_CATEGORY in routes/tasks.js. */
const CATEGORY = 'misc';

/**
 * Is this pool due today? Enabled, and not drawn yet today.
 * @param {{enabled: number, last_drawn_on: string|null}} pool
 * @param {string} today YYYY-MM-DD in household time
 */
export function isPoolDue(pool, today) {
  return Boolean(pool.enabled) && pool.last_drawn_on !== today;
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

/**
 * The ideas that may be drawn right now: never drawn, or drawn at least
 * `cooldown_days` ago.
 * @param {object} d better-sqlite3 connection
 * @param {{id: number, cooldown_days: number}} pool
 * @param {string} today YYYY-MM-DD in household time
 * @returns {object[]}
 */
export function eligibleItems(d, pool, today) {
  return d.prepare(`
    SELECT *
      FROM task_pool_items
     WHERE pool_id = @pool
       AND (last_drawn_on IS NULL
            OR date(last_drawn_on, '+' || @days || ' days') <= @today)
     ORDER BY id
  `).all({ pool: pool.id, days: pool.cooldown_days, today });
}

/**
 * Who is recorded as the author of a drawn task: the person it belongs to, else
 * the creator of the pool. A shared pool whose creator has left falls back to
 * the first household member - `tasks.created_by` must not be empty.
 */
function authorOf(d, pool) {
  if (pool.assigned_to) return pool.assigned_to;
  if (pool.created_by) return pool.created_by;
  return d.prepare(`SELECT u.id FROM users u WHERE ${householdMemberSql('u')} ORDER BY u.id LIMIT 1`).get()?.id ?? null;
}

/**
 * Draws from a pool and creates the tasks - without a due date, in the default
 * category. Counts as the draw of the day if anything was drawn, so the run does
 * not draw again the same day. Draws nothing for a personal pool whose person is
 * no longer a household member.
 *
 * @param {object} d better-sqlite3 connection
 * @param {object} pool row of task_pools
 * @param {{ today: string, pick?: () => number }} options
 * @returns {{ id: number, title: string, item_id: number }[]} the created tasks
 */
export function drawFromPool(d, pool, { today, pick = Math.random }) {
  return d.transaction(() => {
    // A personal pool of someone who is no longer a household member is dormant:
    // a task may not be assigned to them any more. It wakes up if the pool is
    // given to someone else.
    if (pool.assigned_to && !isHouseholdMember(pool.assigned_to, { db: d })) return [];
    const author = authorOf(d, pool);
    if (!author) return [];
    const chosen = pickItems(eligibleItems(d, pool, today), pool.draw_count, pick);
    const created = [];
    for (const item of chosen) {
      const result = d.prepare(`
        INSERT INTO tasks (title, category, priority, status, assigned_to, created_by, visibility)
        VALUES (?, ?, 'none', 'open', ?, ?, 'all')
      `).run(item.title, CATEGORY, pool.assigned_to, author);
      const taskId = Number(result.lastInsertRowid);
      if (pool.assigned_to) {
        d.prepare('INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(taskId, pool.assigned_to);
      }
      d.prepare('UPDATE task_pool_items SET last_drawn_on = ? WHERE id = ?').run(today, item.id);
      created.push({ id: taskId, title: item.title, item_id: item.id });
    }
    if (created.length) d.prepare('UPDATE task_pools SET last_drawn_on = ? WHERE id = ?').run(today, pool.id);
    return created;
  })();
}

/**
 * The scheduler run: every pool that is due today (`isPoolDue`) draws once.
 *
 * AN EMPTY DRAW DOES NOT COUNT AS THE DRAW OF THE DAY. If everything is
 * resting, the next run tries again - the rest period ends at midnight, and a
 * newly added idea should not wait until tomorrow.
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
      if (!isPoolDue(pool, today)) continue;
      const created = drawFromPool(d, pool, { today, pick });
      if (created.length) { drawn += created.length; touched += 1; }
    } catch (err) {
      if (onError) onError(pool, err); else throw err;
    }
  }
  return { drawn, pools: touched };
}
