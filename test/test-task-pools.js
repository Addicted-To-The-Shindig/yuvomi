/**
 * Test: Task pools (D#2254)
 * Purpose: The assurances the feature rests on:
 *          1. a draw is pure randomness with a replaceable `pick`, without replacement,
 *          2. an idea that is cooling down or has an open task is not drawn,
 *          3. a draw creates an ordinary task - shared without a person,
 *             personal with exactly that one,
 *          4. the run draws a pool at most once a day, only on the chosen
 *             weekdays, every N days, and an empty draw does not use up the day,
 *          5. points, time of day and reminder reach the task, in household time,
 *          6. a finished idea leaves a `retire_done` pool - and reading never deletes,
 *          7. renaming an idea keeps it the same idea - a fixed typo is not drawn twice,
 *          8. a pool does not pile up: with `skip_if_open` the scheduled run waits for the open task,
 *             and `no_due_date` / `category` shape the drawn task,
 *          9. the route: create, only the entitled may change, caps, manual draw.
 * Run: npm run test:task-pools
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: router } = await import('../server/routes/task-pools.js');
const {
  ALL_WEEKDAYS, daysBetween, drawDuePools, drawFromPool, eligibleItems, isPoolDue, maskToWeekdays, pickItems,
  hasOpenTask, remindAtFor, reminderRecipients, retireDoneItems, visibleItems, weekdayBit, weekdaysToMask, MAX_ITEMS_PER_POOL, MAX_POOLS,
} =
  await import('../server/services/task-pools.js');
const { parseIdeas, planIdeaChanges } = await import('../public/utils/task-pool-ideas.js');
const db = dbmod.get();

const user = (name, role = 'member') => db.prepare(
  "INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, 'x', ?)",
).run(name, name, role).lastInsertRowid;
const ALICE = user('alice');
const BOB = user('bob');
const ADMIN = user('root', 'admin');

let actor = { id: ALICE, role: 'member' };
const as = (id, role = 'member') => { actor = { id, role }; };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/', router);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204 */ }
  return { status: res.status, body: json };
}

function reset() {
  db.prepare('DELETE FROM task_pools').run();
  db.prepare('DELETE FROM reminders').run();
  db.prepare('DELETE FROM task_assignments').run();
  db.prepare('DELETE FROM tasks').run();
}

function makePool(fields = {}, titles = ['a', 'b', 'c']) {
  const row = {
    name: 'Impulse', assigned_to: null, created_by: ALICE, draw_count: 1, cooldown_days: 30,
    interval_days: 1, weekdays: ALL_WEEKDAYS, category: 'misc', points: 0, remind_time: null, retire_done: 0,
    skip_if_open: 0, no_due_date: 0, remind_scope: 'all', enabled: 1, ...fields,
  };
  const id = db.prepare(`
    INSERT INTO task_pools (name, assigned_to, created_by, draw_count, cooldown_days, interval_days, weekdays,
                            category, points, remind_time, retire_done, skip_if_open, no_due_date, remind_scope, enabled)
    VALUES (@name, @assigned_to, @created_by, @draw_count, @cooldown_days, @interval_days, @weekdays,
            @category, @points, @remind_time, @retire_done, @skip_if_open, @no_due_date, @remind_scope, @enabled)
  `).run(row).lastInsertRowid;
  for (const title of titles) db.prepare('INSERT INTO task_pool_items (pool_id, title) VALUES (?, ?)').run(id, title);
  return db.prepare('SELECT * FROM task_pools WHERE id = ?').get(id);
}

const MONDAY = '2026-11-02';
const SATURDAY = '2026-11-07';

// --------------------------------------------------------
// 1. Draw
// --------------------------------------------------------

test('pickItems zieht ohne Zuruecklegen und folgt dem uebergebenen Zufall', () => {
  const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepEqual(pickItems(items, 1, () => 0).map((i) => i.id), [1]);
  assert.deepEqual(pickItems(items, 1, () => 0.999).map((i) => i.id), [3]);
  assert.deepEqual(pickItems(items, 3, () => 0).map((i) => i.id), [1, 2, 3]);
  assert.equal(new Set(pickItems(items, 3, Math.random).map((i) => i.id)).size, 3);
  assert.equal(pickItems(items, 9, Math.random).length, 3, 'mehr als da ist, gibt es nicht');
  assert.deepEqual(pickItems([], 2), []);
  assert.equal(items.length, 3, 'die Eingabe bleibt unveraendert');
});

test('ein Wert ausserhalb von [0, 1) wird geklemmt statt aus dem Feld zu zeigen', () => {
  const items = [{ id: 1 }, { id: 2 }];
  assert.equal(pickItems(items, 1, () => 5)[0].id, 2);
  assert.equal(pickItems(items, 1, () => -1)[0].id, 1);
  assert.equal(pickItems(items, 1, () => NaN)[0].id, 1);
});

test('weekdayBit: Montag ist Bit 0, Sonntag Bit 6', () => {
  assert.equal(weekdayBit(MONDAY), 1);
  assert.equal(weekdayBit('2026-11-03'), 2);
  assert.equal(weekdayBit(SATURDAY), 32);
  assert.equal(weekdayBit('2026-11-08'), 64);
});

test('Wochentage <-> Maske: nur 1 bis 7, mindestens einer, Rundreise', () => {
  assert.equal(weekdaysToMask([1, 2, 3, 4, 5]), 31);
  assert.equal(weekdaysToMask([1, 2, 3, 4, 5, 6, 7]), ALL_WEEKDAYS);
  assert.deepEqual(maskToWeekdays(31), [1, 2, 3, 4, 5]);
  assert.deepEqual(maskToWeekdays(weekdaysToMask([7, 3])), [3, 7]);
  for (const bad of [[], [0], [8], [1.5], ['1'], null, undefined, 'x']) assert.equal(weekdaysToMask(bad), null, JSON.stringify(bad));
});

test('daysBetween zaehlt ganze Kalendertage, auch ueber die Zeitumstellung', () => {
  assert.equal(daysBetween('2026-11-02', '2026-11-02'), 0);
  assert.equal(daysBetween('2026-11-02', '2026-11-05'), 3);
  assert.equal(daysBetween('2026-03-28', '2026-03-30'), 2);
  assert.equal(daysBetween('2026-10-24', '2026-10-26'), 2);
});

// --------------------------------------------------------
// 2. Cooldown and open task
// --------------------------------------------------------

test('Abklingzeit: ein gezogener Eintrag kommt erst nach den Tagen zurueck', () => {
  reset();
  const pool = makePool({ cooldown_days: 3 }, ['x']);
  assert.equal(drawFromPool(db, pool, { today: '2026-11-02', pick: () => 0 }).length, 1);
  db.prepare("UPDATE tasks SET status = 'done'").run();
  assert.equal(eligibleItems(db, pool, '2026-11-04').length, 0, 'Tag 2: noch in der Abklingzeit');
  assert.equal(eligibleItems(db, pool, '2026-11-05').length, 1, 'Tag 3: wieder im Pool');
});

test('Abklingzeit 0: am Folgetag wieder ziehbar, sofern die Aufgabe nicht mehr offen ist', () => {
  reset();
  const pool = makePool({ cooldown_days: 0 }, ['x']);
  drawFromPool(db, pool, { today: '2026-11-02' });
  assert.equal(eligibleItems(db, pool, '2026-11-03').length, 0, 'die Aufgabe ist noch offen');
  db.prepare("UPDATE tasks SET status = 'done'").run();
  assert.equal(eligibleItems(db, pool, '2026-11-03').length, 1);
});

test('eine offene, archivierte oder geloeschte Aufgabe haelt den Eintrag verschieden zurueck', () => {
  reset();
  const pool = makePool({ cooldown_days: 0 }, ['x']);
  drawFromPool(db, pool, { today: '2026-11-02' });
  const later = '2026-12-31';
  assert.equal(eligibleItems(db, pool, later).length, 0, 'offen blockiert, egal wie lange her');
  db.prepare("UPDATE tasks SET status = 'in_progress'").run();
  assert.equal(eligibleItems(db, pool, later).length, 0);
  db.prepare("UPDATE tasks SET status = 'open', archived_at = '2026-11-03T00:00:00Z'").run();
  assert.equal(eligibleItems(db, pool, later).length, 1, 'archiviert gibt frei');
  db.prepare('UPDATE tasks SET archived_at = NULL').run();
  assert.equal(eligibleItems(db, pool, later).length, 0);
  db.prepare('DELETE FROM tasks').run();
  assert.equal(eligibleItems(db, pool, later).length, 1, 'geloescht gibt frei (ON DELETE SET NULL)');
});

// --------------------------------------------------------
// 3. The task
// --------------------------------------------------------

test('ein geteilter Pool legt eine Aufgabe ohne Person an', () => {
  reset();
  const pool = makePool({}, ['Familie anrufen']);
  const [made] = drawFromPool(db, pool, { today: MONDAY });
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(made.id);
  assert.equal(task.title, 'Familie anrufen');
  assert.equal(task.due_date, MONDAY);
  assert.equal(task.status, 'open');
  assert.equal(task.assigned_to, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_assignments').get().n, 0);
});

test('ein persoenlicher Pool weist genau diese Person zu', () => {
  reset();
  const pool = makePool({ assigned_to: BOB }, ['Aufraeumen']);
  const [made] = drawFromPool(db, pool, { today: MONDAY });
  assert.equal(db.prepare('SELECT assigned_to FROM tasks WHERE id = ?').get(made.id).assigned_to, BOB);
  assert.deepEqual(
    db.prepare('SELECT user_id FROM task_assignments WHERE task_id = ?').all(made.id).map((r) => r.user_id),
    [BOB],
  );
});

test('draw_count zieht mehrere verschiedene Eintraege', () => {
  reset();
  const pool = makePool({ draw_count: 2 }, ['a', 'b', 'c']);
  const made = drawFromPool(db, pool, { today: MONDAY });
  assert.equal(made.length, 2);
  assert.equal(new Set(made.map((m) => m.title)).size, 2);
});

// --------------------------------------------------------
// 4. Run
// --------------------------------------------------------

test('der Lauf zieht einen Pool hoechstens einmal je Tag', () => {
  reset();
  makePool({}, ['a', 'b', 'c']);
  assert.deepEqual(drawDuePools(db, { today: MONDAY }), { drawn: 1, pools: 1 });
  assert.deepEqual(drawDuePools(db, { today: MONDAY }), { drawn: 0, pools: 0 }, 'zweiter Lauf am selben Tag');
  assert.equal(drawDuePools(db, { today: '2026-11-03' }).drawn, 1, 'am naechsten Tag wieder');
});

test('Wochentage: an einem nicht gewaehlten Tag zieht der Pool nicht, am naechsten gewaehlten schon', () => {
  reset();
  makePool({ weekdays: 31 }, ['a', 'b']);
  assert.equal(drawDuePools(db, { today: SATURDAY }).drawn, 0);
  assert.equal(drawDuePools(db, { today: '2026-11-08' }).drawn, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
  assert.equal(drawDuePools(db, { today: '2026-11-09' }).drawn, 1);
});

test('Intervall: alle N Tage, gezaehlt vom letzten Zug', () => {
  reset();
  makePool({ interval_days: 3, cooldown_days: 0 }, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(drawDuePools(db, { today: '2026-11-02' }).drawn, 1, 'der erste Zug ist sofort faellig');
  db.prepare("UPDATE tasks SET status = 'done'").run();
  assert.equal(drawDuePools(db, { today: '2026-11-03' }).drawn, 0);
  assert.equal(drawDuePools(db, { today: '2026-11-04' }).drawn, 0);
  assert.equal(drawDuePools(db, { today: '2026-11-05' }).drawn, 1, 'am dritten Tag');
  db.prepare("UPDATE tasks SET status = 'done'").run();
  // The server was off: it draws once and counts on from there.
  assert.equal(drawDuePools(db, { today: '2026-11-15' }).drawn, 1);
  assert.equal(drawDuePools(db, { today: '2026-11-16' }).drawn, 0);
});

test('Intervall und Wochentage zusammen: der faellige Tag rutscht auf den naechsten gewaehlten', () => {
  reset();
  // Monday and Thursday, every 2 days: Monday draws, Wednesday is due but blocked, Thursday draws.
  makePool({ interval_days: 2, weekdays: weekdaysToMask([1, 4]), cooldown_days: 0 }, ['a', 'b', 'c']);
  assert.equal(drawDuePools(db, { today: MONDAY }).drawn, 1);
  db.prepare("UPDATE tasks SET status = 'done'").run();
  assert.equal(drawDuePools(db, { today: '2026-11-04' }).drawn, 0, 'Mittwoch');
  assert.equal(drawDuePools(db, { today: '2026-11-05' }).drawn, 1, 'Donnerstag');
});

test('isPoolDue: ausgeschaltet ist nie dran', () => {
  const pool = { enabled: 1, weekdays: ALL_WEEKDAYS, interval_days: 1, last_drawn_on: null };
  assert.equal(isPoolDue(pool, MONDAY), true);
  assert.equal(isPoolDue({ ...pool, enabled: 0 }, MONDAY), false);
  assert.equal(isPoolDue({ ...pool, last_drawn_on: MONDAY }, MONDAY), false);
});

test('ein ausgeschalteter Pool zieht nicht', () => {
  reset();
  makePool({ enabled: 0 }, ['a']);
  assert.equal(drawDuePools(db, { today: MONDAY }).drawn, 0);
});

test('ein leerer Zug verbraucht den Tag nicht', () => {
  reset();
  const pool = makePool({}, []);
  assert.equal(drawDuePools(db, { today: MONDAY }).drawn, 0);
  assert.equal(db.prepare('SELECT last_drawn_on FROM task_pools WHERE id = ?').get(pool.id).last_drawn_on, null);
  db.prepare("INSERT INTO task_pool_items (pool_id, title) VALUES (?, 'neu')").run(pool.id);
  assert.equal(drawDuePools(db, { today: MONDAY }).drawn, 1, 'ein spaeter ergaenzter Eintrag wird noch heute gezogen');
});

test('ein Fehler in einem Pool haelt die anderen nicht auf', () => {
  reset();
  const bad = makePool({}, ['a']);
  makePool({}, ['b']);
  db.exec(`CREATE TRIGGER boom BEFORE INSERT ON tasks WHEN NEW.title = 'a' BEGIN SELECT RAISE(ABORT, 'boom'); END`);
  const seen = [];
  const result = drawDuePools(db, { today: MONDAY, onError: (p) => seen.push(p.id) });
  db.exec('DROP TRIGGER boom');
  assert.deepEqual(seen, [bad.id]);
  assert.equal(result.drawn, 1);
});

// --------------------------------------------------------
// 5. Route
// --------------------------------------------------------

test('anlegen mit Eintraegen, Standardwerte, und eine Person nur aus dem Haushalt', async () => {
  reset();
  as(ALICE);
  const ok = await call('POST', '/', { name: 'Impuls', items: ['a', ' b ', ''] });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.draw_count, 1);
  assert.equal(ok.body.data.cooldown_days, 30);
  assert.equal(ok.body.data.assigned_to, null);
  assert.equal(ok.body.data.interval_days, 1);
  assert.deepEqual(ok.body.data.weekdays, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(ok.body.data.enabled, true);
  assert.deepEqual(ok.body.data.items.map((i) => i.title), ['a', 'b']);
  assert.equal(ok.body.data.can_edit, true);

  assert.equal((await call('POST', '/', { name: '' })).status, 400);
  assert.equal((await call('POST', '/', { name: 'x', draw_count: 9 })).status, 400);
  assert.equal((await call('POST', '/', { name: 'x', cooldown_days: -1 })).status, 400);
  for (const bad of [{ interval_days: 0 }, { interval_days: 366 }, { interval_days: 1.5 }, { weekdays: [] }, { weekdays: [8] }, { weekdays: 'mo' }]) {
    assert.equal((await call('POST', '/', { name: 'x', ...bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call('POST', '/', { name: 'x', assigned_to: 99999 })).status, 400);
  assert.equal((await call('POST', '/', { name: 'x', assigned_to: BOB })).status, 201);
});

test('aendern: Urheber, zugewiesene Person und Admin - sonst 403', async () => {
  reset();
  as(ALICE);
  const { body } = await call('POST', '/', { name: 'Meins', assigned_to: BOB });
  const id = body.data.id;
  as(BOB);
  assert.equal((await call('PUT', `/${id}`, { name: 'Bobs' })).status, 200);
  as(ADMIN, 'admin');
  assert.equal((await call('PUT', `/${id}`, { enabled: false })).body.data.enabled, false);
  const stranger = user('carol');
  as(stranger);
  assert.equal((await call('PUT', `/${id}`, { name: 'x' })).status, 403);
  assert.equal((await call('DELETE', `/${id}`)).status, 403);
  assert.equal((await call('POST', `/${id}/items`, { title: 'x' })).status, 403);
  assert.equal((await call('GET', '/')).body.data[0].can_edit, false, 'ansehen darf jeder, aendern nicht');
});

test('ein PUT ohne Feld laesst es stehen, null macht den Pool wieder geteilt', async () => {
  reset();
  as(ALICE);
  const { body } = await call('POST', '/', { name: 'P', assigned_to: BOB, draw_count: 3, interval_days: 4, weekdays: [1, 3] });
  const id = body.data.id;
  const kept = await call('PUT', `/${id}`, { name: 'Q' });
  assert.equal(kept.body.data.assigned_to, BOB);
  assert.equal(kept.body.data.draw_count, 3);
  assert.deepEqual(kept.body.data.weekdays, [1, 3]);
  assert.equal(kept.body.data.interval_days, 4);
  const changed = await call('PUT', `/${id}`, { interval_days: 2, weekdays: [6, 7], enabled: false });
  assert.equal(changed.body.data.interval_days, 2);
  assert.deepEqual(changed.body.data.weekdays, [6, 7]);
  assert.equal(changed.body.data.enabled, false);
  assert.equal((await call('PUT', `/${id}`, { weekdays: [] })).status, 400);
  assert.equal((await call('PUT', `/${id}`, { enabled: true })).body.data.enabled, true);
  assert.equal((await call('PUT', `/${id}`, { assigned_to: null })).body.data.assigned_to, null);
});

test('Eintraege anlegen und loeschen, 404 fuer fremde Ids, Deckel', async () => {
  reset();
  as(ALICE);
  const { body } = await call('POST', '/', { name: 'P' });
  const id = body.data.id;
  const added = await call('POST', `/${id}/items`, { title: 'neu' });
  assert.equal(added.status, 201);
  assert.equal((await call('POST', `/${id}/items`, { title: '' })).status, 400);
  const itemId = added.body.data.items[0].id;
  assert.equal((await call('DELETE', `/${id}/items/99999`)).status, 404);
  assert.equal((await call('DELETE', `/${id}/items/${itemId}`)).body.data.items.length, 0);
  assert.equal((await call('GET', '/')).status, 200);
  assert.equal((await call('PUT', '/99999', { name: 'x' })).status, 404);

  const ins = db.prepare('INSERT INTO task_pool_items (pool_id, title) VALUES (?, ?)');
  for (let i = 0; i < MAX_ITEMS_PER_POOL; i += 1) ins.run(id, `i${i}`);
  const full = await call('POST', `/${id}/items`, { title: 'zu viel' });
  assert.equal(full.status, 400);
  assert.equal(full.body.reason, 'task_pools_items_limit_reached');

  reset();
  for (let i = 0; i < MAX_POOLS; i += 1) makePool({ name: `p${i}` }, []);
  const over = await call('POST', '/', { name: 'zu viel' });
  assert.equal(over.status, 400);
  assert.equal(over.body.reason, 'task_pools_limit_reached');
});

test('Zug von Hand: legt Aufgaben an, zaehlt als Zug des Tages, 409 wenn nichts da ist', async () => {
  reset();
  as(ALICE);
  const { body } = await call('POST', '/', { name: 'P', items: ['nur eins'] });
  const id = body.data.id;
  const drawn = await call('POST', `/${id}/draw`);
  assert.equal(drawn.status, 200);
  assert.deepEqual(drawn.body.data.tasks.map((t) => t.title), ['nur eins']);
  assert.equal(drawn.body.data.pool.items[0].available, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);
  assert.equal(drawDuePools(db, { today: db.prepare('SELECT last_drawn_on AS d FROM task_pools').get().d }).drawn, 0);
  const again = await call('POST', `/${id}/draw`);
  assert.equal(again.status, 409);
  assert.equal(again.body.reason, 'task_pools_nothing_to_draw');
});

test('einen Pool loeschen laesst die gezogenen Aufgaben stehen', async () => {
  reset();
  as(ALICE);
  const { body } = await call('POST', '/', { name: 'P', items: ['x'] });
  await call('POST', `/${body.data.id}/draw`);
  assert.equal((await call('DELETE', `/${body.data.id}`)).status, 204);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_pool_items').get().n, 0);
});

// --------------------------------------------------------
// 6. Points, time of day and reminder
// --------------------------------------------------------

test('die gezogene Aufgabe traegt die Punkte des Pools', () => {
  reset();
  const pool = makePool({ points: 15 }, ['x']);
  const [made] = drawFromPool(db, pool, { today: MONDAY });
  assert.equal(db.prepare('SELECT points FROM tasks WHERE id = ?').get(made.id).points, 15);
});

test('ohne Uhrzeit gibt es weder Faelligkeitszeit noch Erinnerung', () => {
  reset();
  const pool = makePool({}, ['x']);
  const [made] = drawFromPool(db, pool, { today: MONDAY });
  assert.equal(db.prepare('SELECT due_time FROM tasks WHERE id = ?').get(made.id).due_time, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reminders').get().n, 0);
});

test('mit Uhrzeit: Faelligkeitszeit und eine Erinnerung fuer die zugewiesene Person', () => {
  reset();
  const pool = makePool({ assigned_to: BOB, remind_time: '09:30' }, ['x']);
  const [made] = drawFromPool(db, pool, { today: MONDAY });
  assert.equal(db.prepare('SELECT due_time FROM tasks WHERE id = ?').get(made.id).due_time, '09:30');
  const rows = db.prepare("SELECT * FROM reminders WHERE entity_type = 'task'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity_id, made.id);
  assert.equal(rows[0].created_by, BOB);
  assert.equal(rows[0].dismissed, 0);
  assert.equal(rows[0].remind_at, remindAtFor(db, MONDAY, '09:30'));
  assert.match(rows[0].remind_at, /^2026-11-02T\d\d:30:00$/, 'naiv-UTC, ohne Z');
});

test('ein geteilter Pool erinnert jedes Haushaltsmitglied, je einmal', () => {
  reset();
  const pool = makePool({ remind_time: '08:00' }, ['x']);
  drawFromPool(db, pool, { today: MONDAY });
  const who = db.prepare('SELECT created_by FROM reminders ORDER BY created_by').all().map((r) => r.created_by);
  const members = db.prepare("SELECT id FROM users ORDER BY id").all().map((r) => r.id);
  assert.deepEqual(who, members);
});

test('remind_scope creator: ein geteilter Pool erinnert nur den Ersteller', () => {
  reset();
  const pool = makePool({ remind_time: '08:00', remind_scope: 'creator', created_by: BOB }, ['x']);
  drawFromPool(db, pool, { today: MONDAY });
  assert.deepEqual(db.prepare('SELECT created_by FROM reminders').all().map((r) => r.created_by), [BOB]);
});

test('remind_scope creator: fehlt der Ersteller, erinnert der Pool alle statt niemanden', () => {
  reset();
  const members = db.prepare('SELECT id FROM users ORDER BY id').all().map((r) => r.id);
  const gone = makePool({ remind_scope: 'creator', created_by: null }, ['x']);
  assert.deepEqual(reminderRecipients(db, gone), members);
  // A creator who is no longer a member (staff, guest) counts like a missing one.
  const staff = user('staff-guest');
  db.prepare("INSERT INTO housekeeping_workers (user_id) VALUES (?)").run(staff);
  const former = makePool({ remind_scope: 'creator', created_by: staff }, ['y']);
  assert.deepEqual(reminderRecipients(db, former), members.filter((id) => id !== staff));
});

test('ein persoenlicher Pool erinnert nur seine Person, auch mit remind_scope all', () => {
  reset();
  const pool = makePool({ assigned_to: ALICE, remind_scope: 'all', created_by: BOB }, ['x']);
  assert.deepEqual(reminderRecipients(db, pool), [ALICE]);
  const other = makePool({ assigned_to: ALICE, remind_scope: 'creator', created_by: BOB }, ['y']);
  assert.deepEqual(reminderRecipients(db, other), [ALICE]);
});

test('die Erinnerung folgt der Haushaltszone, nicht UTC', () => {
  reset();
  const setZone = (zone) => db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('household_timezone', ?)").run(zone);
  try {
    setZone('Asia/Tokyo');
    assert.equal(remindAtFor(db, MONDAY, '09:00'), '2026-11-02T00:00:00', '09:00 in Tokio ist 00:00 UTC');
    setZone('America/New_York');
    assert.equal(remindAtFor(db, MONDAY, '09:00'), '2026-11-02T14:00:00', 'Winterzeit (UTC-5) am 2.11.');
    assert.equal(remindAtFor(db, '2026-10-26', '09:00'), '2026-10-26T13:00:00', 'Sommerzeit (UTC-4) eine Woche davor');
  } finally {
    db.prepare("DELETE FROM sync_config WHERE key = 'household_timezone'").run();
  }
});

// --------------------------------------------------------
// 7. One-time ideas
// --------------------------------------------------------

test('retire_done: eine erledigte Idee verlaesst den Pool, eine offene bleibt', () => {
  reset();
  const pool = makePool({ retire_done: 1, draw_count: 2 }, ['a', 'b', 'c']);
  const made = drawFromPool(db, pool, { today: MONDAY, pick: () => 0 });
  assert.equal(made.length, 2);
  db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', made[0].id);
  assert.equal(retireDoneItems(db, pool), 1);
  const left = db.prepare('SELECT title FROM task_pool_items WHERE pool_id = ? ORDER BY id').all(pool.id).map((r) => r.title);
  assert.deepEqual(left, [made[1].title, 'c'].sort((x, y) => ['a', 'b', 'c'].indexOf(x) - ['a', 'b', 'c'].indexOf(y)));
});

test('retire_done: eine archivierte oder geloeschte Aufgabe gilt nicht als erledigt', () => {
  reset();
  const pool = makePool({ retire_done: 1, draw_count: 2 }, ['a', 'b']);
  const [first, second] = drawFromPool(db, pool, { today: MONDAY, pick: () => 0 });
  db.prepare("UPDATE tasks SET status = 'done', archived_at = '2026-11-03T00:00:00Z' WHERE id = ?").run(first.id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(second.id);
  assert.equal(retireDoneItems(db, pool), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_pool_items').get().n, 2);
});

test('ohne retire_done bleibt eine erledigte Idee im Pool und kommt nach der Abklingzeit zurueck', () => {
  reset();
  const pool = makePool({ retire_done: 0, cooldown_days: 2 }, ['a']);
  const [made] = drawFromPool(db, pool, { today: MONDAY });
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(made.id);
  assert.equal(retireDoneItems(db, pool), 0);
  assert.equal(eligibleItems(db, pool, '2026-11-04').length, 1);
});

test('der Lauf zieht nicht aus einer Idee, die gerade verabschiedet wurde', () => {
  reset();
  makePool({ retire_done: 1, cooldown_days: 0 }, ['only']);
  assert.equal(drawDuePools(db, { today: MONDAY }).drawn, 1);
  db.prepare("UPDATE tasks SET status = 'done'").run();
  assert.equal(drawDuePools(db, { today: '2026-11-03' }).drawn, 0, 'der Pool ist leer');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_pool_items').get().n, 0);
});

test('Route: Punkte, Uhrzeit und einmalig anlegen, aendern, pruefen', async () => {
  reset();
  as(ALICE);
  const made = await call('POST', '/', { name: 'P', points: 5, remind_time: '07:45', retire_done: true, items: ['x'] });
  assert.equal(made.status, 201);
  assert.equal(made.body.data.points, 5);
  assert.equal(made.body.data.remind_time, '07:45');
  assert.equal(made.body.data.retire_done, true);
  const id = made.body.data.id;
  for (const bad of [{ points: -1 }, { points: 10001 }, { points: 1.5 }, { remind_time: '25:00' }, { remind_time: '9:00' }, { remind_time: 'abc' }, { remind_time: 900 }]) {
    assert.equal((await call('PUT', `/${id}`, bad)).status, 400, JSON.stringify(bad));
  }
  const kept = await call('PUT', `/${id}`, { name: 'Q' });
  assert.equal(kept.body.data.points, 5, 'ein PUT ohne Feld laesst es stehen');
  assert.equal(kept.body.data.remind_time, '07:45');
  assert.equal(kept.body.data.retire_done, true);
  const cleared = await call('PUT', `/${id}`, { remind_time: null, retire_done: false, points: 0 });
  assert.equal(cleared.body.data.remind_time, null);
  assert.equal(cleared.body.data.retire_done, false);
  assert.equal(cleared.body.data.points, 0);
  assert.equal(made.body.data.remind_scope, 'all');
  for (const bad of ['everyone', '', null, 1]) {
    assert.equal((await call('PUT', `/${id}`, { remind_scope: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call('PUT', `/${id}`, { remind_scope: 'creator' })).body.data.remind_scope, 'creator');
  assert.equal((await call('PUT', `/${id}`, { name: 'R' })).body.data.remind_scope, 'creator', 'ein PUT ohne Feld laesst es stehen');
  assert.equal((await call('POST', '/', { name: 'S', remind_scope: 'creator' })).body.data.remind_scope, 'creator');
  assert.equal((await call('POST', '/', { name: 'T', remind_scope: 'x' })).status, 400);
  const defaults = await call('POST', '/', { name: 'D' });
  assert.equal(defaults.body.data.points, 0);
  assert.equal(defaults.body.data.remind_time, null);
  assert.equal(defaults.body.data.retire_done, false);
});

test('Route: a finished idea is hidden when a retire_done pool is read - but reading deletes nothing', async () => {
  reset();
  as(ALICE);
  const made = await call('POST', '/', { name: 'P', retire_done: true, items: ['a', 'b'] });
  const id = made.body.data.id;
  const drawn = await call('POST', `/${id}/draw`, undefined);
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(drawn.body.data.tasks[0].id);
  const first = await call('GET', '/');
  assert.equal(first.body.data[0].items.length, 1, 'the finished idea is not listed');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_pool_items').get().n, 2, 'a GET changes nothing');
  assert.equal((await call('GET', '/')).body.data[0].items.length, 1, 'and the same answer a second time');
  // The hourly run tidies up, due or not.
  drawDuePools(db, { today: MONDAY });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_pool_items').get().n, 1);
});

test('visibleItems hides retired ideas only in a retire_done pool', () => {
  reset();
  const keep = makePool({ retire_done: 0 }, ['a']);
  const retire = makePool({ retire_done: 1 }, ['b']);
  for (const pool of [keep, retire]) {
    const [made] = drawFromPool(db, pool, { today: MONDAY });
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(made.id);
  }
  assert.deepEqual(visibleItems(db, keep).map((i) => i.title), ['a']);
  assert.deepEqual(visibleItems(db, retire), []);
});

test('Route: flags must be real booleans', async () => {
  reset();
  as(ALICE);
  for (const bad of [{ enabled: 'false' }, { enabled: 0 }, { retire_done: 'yes' }, { retire_done: 1 }, { enabled: null }]) {
    assert.equal((await call('POST', '/', { name: 'x', ...bad })).status, 400, `POST ${JSON.stringify(bad)}`);
  }
  const { body } = await call('POST', '/', { name: 'ok', enabled: false, retire_done: true });
  assert.equal(body.data.enabled, false);
  assert.equal(body.data.retire_done, true);
  for (const bad of [{ enabled: 'true' }, { retire_done: 'no' }, { enabled: 1 }]) {
    assert.equal((await call('PUT', `/${body.data.id}`, bad)).status, 400, `PUT ${JSON.stringify(bad)}`);
  }
  assert.equal((await call('PUT', `/${body.data.id}`, { enabled: true })).body.data.enabled, true);
});

test('Migration 274 creates the final schema, a second run changes nothing, and the checks hold', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(':memory:');
  raw.exec('CREATE TABLE users (id INTEGER PRIMARY KEY); CREATE TABLE tasks (id INTEGER PRIMARY KEY);');
  const migration = dbmod.MIGRATIONS.find((m) => m.version === 274);
  assert.ok(migration, 'migration 274 exists');
  assert.equal(dbmod.MIGRATIONS.filter((m) => m.version > 273).length, 1, 'the feature is one migration');
  migration.up(raw);
  raw.exec("INSERT INTO task_pools (name) VALUES ('p')");
  const once = JSON.stringify(raw.prepare('SELECT * FROM task_pools').all());
  migration.up(raw);
  assert.equal(JSON.stringify(raw.prepare('SELECT * FROM task_pools').all()), once, 'a second run changes nothing');
  assert.deepEqual({ ...raw.prepare('SELECT * FROM task_pools').get(), created_at: null }, {
    id: 1, name: 'p', assigned_to: null, created_by: null, draw_count: 1, cooldown_days: 30, interval_days: 1,
    weekdays: 127, category: 'misc', points: 0, remind_time: null, remind_scope: 'all', retire_done: 0,
    skip_if_open: 0, no_due_date: 0, enabled: 1, last_drawn_on: null, created_at: null,
  }, 'the defaults');
  // The checks come with the columns. The one on `remind_time` is only a coarse net (GLOB cannot say
  // "00 to 23"); the exact check, hour 25 included, is the route's - see the route test.
  for (const bad of ['draw_count = 0', 'draw_count = 6', 'cooldown_days = -1', 'cooldown_days = 366', 'weekdays = 0',
    'weekdays = 128', 'interval_days = 0', 'interval_days = 366', 'points = -1', 'points = 10001',
    "remind_time = '9:00'", "remind_scope = 'nobody'", 'retire_done = 2', 'skip_if_open = 2', 'no_due_date = 2',
    'enabled = 2']) {
    assert.throws(() => raw.exec(`UPDATE task_pools SET ${bad} WHERE id = 1`), bad);
  }
  raw.exec("UPDATE task_pools SET remind_time = '09:30', remind_scope = 'creator' WHERE id = 1");
});

test('the real database carries the schema of migration 274', () => {
  const cols = db.prepare('PRAGMA table_info(task_pools)').all().map((c) => c.name);
  assert.deepEqual(cols, [
    'id', 'name', 'assigned_to', 'created_by', 'draw_count', 'cooldown_days', 'interval_days', 'weekdays',
    'category', 'points', 'remind_time', 'remind_scope', 'retire_done', 'skip_if_open', 'no_due_date', 'enabled',
    'last_drawn_on', 'created_at',
  ]);
  assert.throws(() => db.prepare("INSERT INTO task_pools (name, remind_time) VALUES ('x', '9:00')").run(), 'the format of the time is checked');
});

// --------------------------------------------------------
// 8. People who leave the household
// --------------------------------------------------------

test('a personal pool of someone who is no longer a household member does not draw', () => {
  reset();
  const gone = user('former-member');
  const pool = makePool({ assigned_to: gone, remind_time: '08:00' }, ['x']);
  db.prepare("UPDATE users SET deactivated_at = datetime('now') WHERE id = ?").run(gone);
  assert.deepEqual(drawFromPool(db, pool, { today: MONDAY }), []);
  assert.equal(drawDuePools(db, { today: MONDAY }).drawn, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reminders').get().n, 0);
  assert.equal(db.prepare('SELECT last_drawn_on FROM task_pools WHERE id = ?').get(pool.id).last_drawn_on, null,
    'a dormant pool does not use up the day');
  // Given to someone else, it wakes up.
  db.prepare('UPDATE task_pools SET assigned_to = ? WHERE id = ?').run(BOB, pool.id);
  assert.equal(drawDuePools(db, { today: MONDAY }).drawn, 1);
});

test('Route: a pool keeps its person after they left, but nobody new may be a non-member', async () => {
  reset();
  as(ALICE);
  const gone = user('former-member-2');
  const made = await call('POST', '/', { name: 'P', assigned_to: gone, items: ['x'] });
  assert.equal(made.status, 201);
  db.prepare("UPDATE users SET deactivated_at = datetime('now') WHERE id = ?").run(gone);
  const id = made.body.data.id;
  const same = await call('PUT', `/${id}`, { name: 'Q', assigned_to: gone });
  assert.equal(same.status, 200, 'saving without changing the person works');
  assert.equal(same.body.data.assigned_to, gone);
  const other = user('former-member-3');
  db.prepare("UPDATE users SET deactivated_at = datetime('now') WHERE id = ?").run(other);
  const refused = await call('PUT', `/${id}`, { assigned_to: other });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /not a household member/);
  assert.equal((await call('PUT', `/${id}`, { assigned_to: 999999 })).status, 400, 'an unknown id is refused, not a 500');
  assert.equal((await call('PUT', `/${id}`, { assigned_to: null })).body.data.assigned_to, null);
});

test('a personal pool ends with the account that owns it - a shared pool they created does not', async () => {
  reset();
  const { PRIVATE_USER_COLUMNS } = await import('../server/services/user-removal.js');
  assert.ok(PRIVATE_USER_COLUMNS.has('task_pools.assigned_to'), 'a personal pool is the account\'s own list');
  assert.ok(!PRIVATE_USER_COLUMNS.has('task_pools.created_by'), 'whoever created a shared pool leaves a trace');
});

// --------------------------------------------------------
// 9. Renaming an idea
// --------------------------------------------------------

test('PUT item: a renamed idea keeps its cooldown and its open task - a fixed typo is not drawn twice', async () => {
  reset();
  as(ALICE);
  const made = await call('POST', '/', { name: 'P', cooldown_days: 30, items: ['Call famly'] });
  const id = made.body.data.id;
  const drawn = await call('POST', `/${id}/draw`);
  const itemId = drawn.body.data.pool.items[0].id;
  assert.equal(drawn.body.data.pool.items[0].available, false);

  const renamed = await call('PUT', `/${id}/items/${itemId}`, { title: 'Call family' });
  assert.equal(renamed.status, 200);
  assert.deepEqual(renamed.body.data.items.map((i) => [i.id, i.title, i.available]), [[itemId, 'Call family', false]],
    'the same idea, same id, still not available');
  const row = db.prepare('SELECT * FROM task_pool_items WHERE id = ?').get(itemId);
  assert.ok(row.task_id, 'the link to the task of the last draw is kept');
  assert.ok(row.last_drawn_on, 'the cooldown is kept');

  // The scenario that was broken: deleting and re-adding gave the idea a clean slate.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);
  assert.equal((await call('POST', `/${id}/draw`)).status, 409, 'nothing to draw while the task is open');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1, 'still one task');
});

test('PUT item: the old way - delete and add - is what made a typo drawable twice (documents why renaming exists)', () => {
  reset();
  const pool = makePool({ cooldown_days: 30 }, ['Call famly']);
  drawFromPool(db, pool, { today: MONDAY });
  db.prepare("DELETE FROM task_pool_items WHERE title = 'Call famly'").run();
  db.prepare("INSERT INTO task_pool_items (pool_id, title) VALUES (?, 'Call family')").run(pool.id);
  assert.equal(eligibleItems(db, pool, '2026-11-03').length, 1, 'a new row has no task and no cooldown');
});

test('PUT item: validation, 404 and who may rename', async () => {
  reset();
  as(ALICE);
  const made = await call('POST', '/', { name: 'P', items: ['a', 'b'] });
  const id = made.body.data.id;
  const [a, b] = made.body.data.items.map((i) => i.id);
  assert.equal((await call('PUT', `/${id}/items/${a}`, { title: '' })).status, 400);
  assert.equal((await call('PUT', `/${id}/items/${a}`, {})).status, 400);
  assert.equal((await call('PUT', `/${id}/items/${a}`, { title: 'x'.repeat(101) })).status, 400);
  assert.equal((await call('PUT', `/${id}/items/999999`, { title: 'x' })).status, 404);
  assert.equal((await call('PUT', '/999999/items/1', { title: 'x' })).status, 404);
  const other = await call('POST', '/', { name: 'Q', items: ['z'] });
  assert.equal((await call('PUT', `/${id}/items/${other.body.data.items[0].id}`, { title: 'x' })).status, 404,
    'an idea of another pool is not reachable through this one');
  assert.equal((await call('PUT', `/${id}/items/${b}`, { title: '  trimmed  ' })).body.data.items[1].title, 'trimmed');
  const stranger = user('carol-rename');
  as(stranger);
  assert.equal((await call('PUT', `/${id}/items/${a}`, { title: 'x' })).status, 403);
});

test('parseIdeas: one idea per line, trimmed, without empty lines and duplicates', () => {
  assert.deepEqual(parseIdeas(' a \n\nb\r\na\n   \nc'), ['a', 'b', 'c']);
  assert.deepEqual(parseIdeas(''), []);
  assert.deepEqual(parseIdeas(null), []);
});

const ideas = (...titles) => titles.map((title, i) => ({ id: i + 1, title }));

test('planIdeaChanges: no change, only additions, only removals', () => {
  assert.deepEqual(planIdeaChanges(ideas('a', 'b'), ['a', 'b']), { renames: [], removals: [], additions: [] });
  assert.deepEqual(planIdeaChanges(ideas('a'), ['a', 'b', 'c']), { renames: [], removals: [], additions: ['b', 'c'] });
  assert.deepEqual(planIdeaChanges(ideas('a', 'b', 'c'), ['a', 'c']), { renames: [], removals: [2], additions: [] });
  assert.deepEqual(planIdeaChanges(ideas('a', 'b'), []), { renames: [], removals: [1, 2], additions: [] });
  assert.deepEqual(planIdeaChanges([], ['a']), { renames: [], removals: [], additions: ['a'] });
});

test('planIdeaChanges: an edited line is a rename - at the start, in the middle and at the end', () => {
  assert.deepEqual(planIdeaChanges(ideas('a', 'b', 'c'), ['X', 'b', 'c']), { renames: [{ id: 1, title: 'X' }], removals: [], additions: [] });
  assert.deepEqual(planIdeaChanges(ideas('a', 'b', 'c'), ['a', 'X', 'c']), { renames: [{ id: 2, title: 'X' }], removals: [], additions: [] });
  assert.deepEqual(planIdeaChanges(ideas('a', 'b', 'c'), ['a', 'b', 'X']), { renames: [{ id: 3, title: 'X' }], removals: [], additions: [] });
  assert.deepEqual(planIdeaChanges(ideas('Call famly'), ['Call family']), { renames: [{ id: 1, title: 'Call family' }], removals: [], additions: [] });
});

test('planIdeaChanges: several edits, and an edit next to an added or a deleted line', () => {
  assert.deepEqual(planIdeaChanges(ideas('a', 'b', 'c'), ['X', 'b', 'Y']),
    { renames: [{ id: 1, title: 'X' }, { id: 3, title: 'Y' }], removals: [], additions: [] });
  // Edit in place and a line added at the end: the edit pairs by position, the new line stays an addition.
  assert.deepEqual(planIdeaChanges(ideas('a', 'b', 'c'), ['a', 'X', 'c', 'd']),
    { renames: [{ id: 2, title: 'X' }], removals: [], additions: ['d'] });
  // Edit in place and another line deleted.
  assert.deepEqual(planIdeaChanges(ideas('a', 'b', 'c'), ['Y', 'c']),
    { renames: [{ id: 1, title: 'Y' }], removals: [2], additions: [] });
  // Positions shifted by a deletion: nothing sits where X stands, so the leftovers are paired in
  // order. Which of 'a' and 'c' became X cannot be told (both are equally far away); the first
  // one is taken, and the other goes - either way the result is exactly the wanted lines.
  assert.deepEqual(planIdeaChanges(ideas('a', 'b', 'c'), ['b', 'X']),
    { renames: [{ id: 1, title: 'X' }], removals: [3], additions: [] });
});

test('planIdeaChanges: every stored idea ends up exactly once - kept, renamed or removed', () => {
  let seed = 7;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const pool = ['a', 'b', 'c', 'd', 'e', 'f'];
  for (let round = 0; round < 300; round += 1) {
    const stored = ideas(...pool.slice(0, 1 + rand(6)));
    const wanted = parseIdeas(Array.from({ length: rand(7) }, () => (rand(3) ? pool[rand(8)] ?? `new${rand(4)}` : `new${rand(4)}`)).join('\n'));
    const { renames, removals, additions } = planIdeaChanges(stored, wanted);
    const touched = [...renames.map((r) => r.id), ...removals];
    assert.equal(new Set(touched).size, touched.length, 'no idea is both renamed and removed, or twice');
    // Applying the plan to the stored titles gives the wanted lines (as a set).
    const result = new Set(stored.filter((i) => !touched.includes(i.id)).map((i) => i.title));
    renames.forEach((r) => result.add(r.title));
    additions.forEach((title) => result.add(title));
    assert.deepEqual([...result].sort(), [...wanted].sort(), JSON.stringify({ stored: stored.map((i) => i.title), wanted }));
  }
});

// --------------------------------------------------------
// 10. Not piling up, no due date, category
// --------------------------------------------------------

test('skip_if_open: the scheduled run waits while a task from the pool is open', () => {
  reset();
  makePool({ skip_if_open: 1, cooldown_days: 0 }, ['a', 'b', 'c']);
  assert.equal(drawDuePools(db, { today: MONDAY }).drawn, 1);
  // Ignored: the next day nothing is drawn although the pool is due.
  assert.equal(drawDuePools(db, { today: '2026-11-03' }).drawn, 0);
  assert.equal(drawDuePools(db, { today: '2026-11-04' }).drawn, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1, 'no pile-up');
  // Done: the pool draws again at the next run.
  db.prepare("UPDATE tasks SET status = 'done'").run();
  assert.equal(drawDuePools(db, { today: '2026-11-04' }).drawn, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 2);
});

test('skip_if_open: an archived or deleted task does not hold the pool back, and without it the pool piles up', () => {
  reset();
  const pool = makePool({ skip_if_open: 1, cooldown_days: 0 }, ['a', 'b']);
  const [made] = drawFromPool(db, pool, { today: MONDAY });
  assert.equal(hasOpenTask(db, pool), true);
  db.prepare("UPDATE tasks SET archived_at = '2026-11-03T00:00:00Z' WHERE id = ?").run(made.id);
  assert.equal(hasOpenTask(db, pool), false, 'archived: put away');
  db.prepare("UPDATE tasks SET archived_at = NULL WHERE id = ?").run(made.id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(made.id);
  assert.equal(hasOpenTask(db, pool), false, 'deleted');

  reset();
  makePool({ skip_if_open: 0, cooldown_days: 0 }, ['a', 'b', 'c', 'd']);
  for (const day of ['2026-11-02', '2026-11-03', '2026-11-04']) drawDuePools(db, { today: day });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'open'").get().n, 3, 'the default piles up, as before');
});

test('skip_if_open: the manual draw does not ask - whoever presses it wants another one', () => {
  reset();
  const pool = makePool({ skip_if_open: 1, cooldown_days: 0 }, ['a', 'b']);
  drawFromPool(db, pool, { today: MONDAY });
  assert.equal(drawFromPool(db, pool, { today: MONDAY }).length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 2);
});

test('skip_if_open: never two draws on one day, even after the open task is finished', () => {
  reset();
  makePool({ skip_if_open: 1, cooldown_days: 0 }, ['a', 'b', 'c']);
  assert.equal(drawDuePools(db, { today: MONDAY }).drawn, 1);
  db.prepare("UPDATE tasks SET status = 'done'").run();
  assert.equal(drawDuePools(db, { today: MONDAY }).drawn, 0, 'finished in the afternoon: tomorrow, not now');
  assert.equal(drawDuePools(db, { today: '2026-11-03' }).drawn, 1);
});

test('no_due_date: the task has neither due date nor due time, the reminder still fires at the time', () => {
  reset();
  const pool = makePool({ no_due_date: 1, remind_time: '09:30' }, ['x']);
  const [made] = drawFromPool(db, pool, { today: MONDAY });
  const task = db.prepare('SELECT due_date, due_time FROM tasks WHERE id = ?').get(made.id);
  assert.deepEqual({ ...task }, { due_date: null, due_time: null });
  const reminders = db.prepare('SELECT remind_at FROM reminders').all();
  assert.ok(reminders.length > 0);
  assert.equal(reminders[0].remind_at, remindAtFor(db, MONDAY, '09:30'));
});

test('the drawn task lands in the pool\'s category - or in misc once that category is gone', () => {
  reset();
  db.prepare("INSERT OR IGNORE INTO task_categories (key, name, sort_order) VALUES ('mini-chores', 'Mini chores', 99)").run();
  try {
    const pool = makePool({ category: 'mini-chores' }, ['x', 'y']);
    const [first] = drawFromPool(db, pool, { today: MONDAY, pick: () => 0 });
    assert.equal(db.prepare('SELECT category FROM tasks WHERE id = ?').get(first.id).category, 'mini-chores');
    db.prepare("DELETE FROM task_categories WHERE key = 'mini-chores'").run();
    db.prepare("UPDATE tasks SET status = 'done'").run();
    const [second] = drawFromPool(db, { ...pool, cooldown_days: 0 }, { today: '2026-11-03', pick: () => 0 });
    assert.equal(db.prepare('SELECT category FROM tasks WHERE id = ?').get(second.id).category, 'misc', 'fell back');
  } finally {
    db.prepare("DELETE FROM task_categories WHERE key = 'mini-chores'").run();
  }
});

test('Route: category, skip_if_open and no_due_date - defaults, validation, and a PUT without the field leaves it', async () => {
  reset();
  as(ALICE);
  db.prepare("INSERT OR IGNORE INTO task_categories (key, name, sort_order) VALUES ('mini-chores', 'Mini chores', 99)").run();
  try {
    const defaults = await call('POST', '/', { name: 'D' });
    assert.equal(defaults.body.data.category, 'misc');
    assert.equal(defaults.body.data.skip_if_open, false);
    assert.equal(defaults.body.data.no_due_date, false);

    const made = await call('POST', '/', { name: 'P', category: 'mini-chores', skip_if_open: true, no_due_date: true });
    assert.equal(made.status, 201);
    assert.equal(made.body.data.category, 'mini-chores');
    assert.equal(made.body.data.skip_if_open, true);
    assert.equal(made.body.data.no_due_date, true);
    const id = made.body.data.id;

    for (const bad of [{ category: 'no-such-category' }, { category: '' }, { category: 5 }, { skip_if_open: 'yes' }, { no_due_date: 1 }]) {
      assert.equal((await call('PUT', `/${id}`, bad)).status, 400, JSON.stringify(bad));
    }
    const kept = await call('PUT', `/${id}`, { name: 'Q' });
    assert.equal(kept.body.data.category, 'mini-chores');
    assert.equal(kept.body.data.skip_if_open, true);
    assert.equal(kept.body.data.no_due_date, true);
    const cleared = await call('PUT', `/${id}`, { skip_if_open: false, no_due_date: false, category: 'misc' });
    assert.deepEqual([cleared.body.data.skip_if_open, cleared.body.data.no_due_date, cleared.body.data.category], [false, false, 'misc']);

    // A category that was deleted after the pool chose it stays valid on save.
    await call('PUT', `/${id}`, { category: 'mini-chores' });
    db.prepare("DELETE FROM task_categories WHERE key = 'mini-chores'").run();
    assert.equal((await call('PUT', `/${id}`, { name: 'Still saves', category: 'mini-chores' })).status, 200);
    assert.equal((await call('PUT', `/${id}`, { category: 'another-gone-one' })).status, 400);
  } finally {
    db.prepare("DELETE FROM task_categories WHERE key = 'mini-chores'").run();
  }
});
