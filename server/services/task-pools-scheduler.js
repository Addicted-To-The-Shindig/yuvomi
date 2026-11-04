/**
 * Module: Task pool run (D#2254)
 * Purpose: Draws for every due task pool - shortly after startup and then
 *          hourly.
 * Dependencies: server/db.js, services/task-pools.js, utils/timezone.js.
 *
 * HOURLY, NOT AT A TIME OF DAY. A draw is a daily draw: whoever switches the
 * server on in the morning should get their ideas right away, and an outage
 * around a fixed time must not cost a day. `last_drawn_on` keeps the run to one
 * draw per pool and day.
 */

import { isRestoreRunning } from '../utils/restore-state.js';
import { createLogger } from '../logger.js';
import * as db from '../db.js';
import { todayKey } from '../utils/timezone.js';
import { drawDuePools } from './task-pools.js';

const log = createLogger('TaskPools');

export function tick() {
  if (isRestoreRunning()) return;
  try {
    const result = drawDuePools(db.get(), {
      today: todayKey(db.get()),
      onError: (pool, err) => log.error(`Task pool ${pool.id} failed:`, err),
    });
    if (result.drawn) log.info(`Task pools: ${result.drawn} task(s) drawn from ${result.pools} pool(s).`);
  } catch (err) {
    log.error('Task pool run failed:', err);
  }
}

export function startTaskPoolScheduler() {
  setTimeout(tick, 20_000).unref();
  setInterval(tick, 60 * 60 * 1000).unref();
}
