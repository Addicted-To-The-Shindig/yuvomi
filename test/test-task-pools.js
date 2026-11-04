/**
 * Test: Task pools (D#2254)
 * Purpose: The assurances the feature rests on:
 *          1. a draw is pure randomness with a replaceable `pick`, without replacement,
 *          2. an idea that is resting is not drawn,
 *          3. a draw creates an ordinary task - shared without a person,
 *             personal with exactly that one,
 *          4. the run draws a pool at most once a day, a paused pool never,
 *             and an empty draw does not use up the day,
 *          5. the route: create, only the entitled may change, ideas travel
 *             with the pool and keep their rest period, caps,
 *          6. people who leave the household,
 *          7. the migration.
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
  drawDuePools, drawFromPool, eligibleItems, isPoolDue, pickItems, MAX_ITEMS_PER_POOL, MAX_POOLS,
} = await import('../server/services/task-pools.js');
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
  db.prepare('DELETE FROM task_assignments').run();
  db.prepare('DELETE FROM tasks').run();
}

function makePool(fields = {}, titles = ['a', 'b', 'c']) {
  const row = {
    name: 'Impulse', assigned_to: null, created_by: ALICE, draw_count: 1, cooldown_days: 30, enabled: 1, ...fields,
  };
  const id = db.prepare(`
    INSERT INTO task_pools (name, assigned_to, created_by, draw_count, cooldown_days, enabled)
    VALUES (@name, @assigned_to, @created_by, @draw_count, @cooldown_days, @enabled)
  `).run(row).lastInsertRowid;
  for (const title of titles) db.prepare('INSERT INTO task_pool_items (pool_id, title) VALUES (?, ?)').run(id, title);
  return db.prepare('SELECT * FROM task_pools WHERE id = ?').get(id);
}

const MONDAY = '2026-11-02';

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

// --------------------------------------------------------
// 2. Rest period
// --------------------------------------------------------

test('Ruhezeit: ein gezogener Eintrag kommt erst nach den Tagen zurueck', () => {
  reset();
  const pool = makePool({ cooldown_days: 3 }, ['x']);
  assert.equal(drawFromPool(db, pool, { today: '2026-11-02', pick: () => 0 }).length, 1);
  assert.equal(eligibleItems(db, pool, '2026-11-04').length, 0, 'Tag 2: noch in der Ruhezeit');
  assert.equal(eligibleItems(db, pool, '2026-11-05').length, 1, 'Tag 3: wieder im Pool');
});

test('Ruhezeit 0: schon am Folgetag wieder ziehbar', () => {
  reset();
  const pool = makePool({ cooldown_days: 0 }, ['x']);
  drawFromPool(db, pool, { today: MONDAY });
  assert.equal(eligibleItems(db, pool, '2026-11-03').length, 1);
});

// --------------------------------------------------------
// 3. The drawn task
// --------------------------------------------------------

test('ein geteilter Pool legt eine Aufgabe ohne Person und ohne Faelligkeit an', () => {
  reset();
  const pool = makePool({}, ['Familie anrufen']);
  const [made] = drawFromPool(db, pool, { today: MONDAY });
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(made.id);
  assert.equal(task.title, 'Familie anrufen');
  assert.equal(task.status, 'open');
  assert.equal(task.category, 'misc');
  assert.equal(task.due_date, null);
  assert.equal(task.assigned_to, null);
  assert.equal(task.created_by, ALICE, 'the creator of the pool');
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

test('ein geteilter Pool ohne Ersteller zieht trotzdem: ein Haushaltsmitglied steht als Urheber', () => {
  reset();
  const pool = makePool({ created_by: null }, ['x']);
  const [made] = drawFromPool(db, pool, { today: MONDAY });
  assert.ok(db.prepare('SELECT created_by FROM tasks WHERE id = ?').get(made.id).created_by);
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

test('isPoolDue: ausgeschaltet ist nie dran', () => {
  assert.equal(isPoolDue({ enabled: 1, last_drawn_on: null }, MONDAY), true);
  assert.equal(isPoolDue({ enabled: 1, last_drawn_on: MONDAY }, MONDAY), false);
  assert.equal(isPoolDue({ enabled: 0, last_drawn_on: null }, MONDAY), false);
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
  const ok = await call('POST', '/', { name: 'Impuls', items: ['a', ' b ', '', 'a'] });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.draw_count, 1);
  assert.equal(ok.body.data.cooldown_days, 30);
  assert.equal(ok.body.data.assigned_to, null);
  assert.equal(ok.body.data.enabled, true);
  assert.deepEqual(ok.body.data.items.map((i) => i.title), ['a', 'b'], 'trimmed, without empty lines and duplicates');
  assert.equal(ok.body.data.can_edit, true);

  assert.equal((await call('POST', '/', { name: '' })).status, 400);
  assert.equal((await call('POST', '/', { name: 'x', draw_count: 9 })).status, 400);
  assert.equal((await call('POST', '/', { name: 'x', cooldown_days: -1 })).status, 400);
  assert.equal((await call('POST', '/', { name: 'x', enabled: 'yes' })).status, 400, 'a flag must be a real boolean');
  assert.equal((await call('POST', '/', { name: 'x', items: 'a' })).status, 400);
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
  assert.equal((await call('GET', '/')).body.data[0].can_edit, false, 'ansehen darf jeder, aendern nicht');
});

test('ein PUT ohne Feld laesst es stehen, null macht den Pool wieder geteilt', async () => {
  reset();
  as(ALICE);
  const { body } = await call('POST', '/', { name: 'P', assigned_to: BOB, draw_count: 3, items: ['a', 'b'] });
  const id = body.data.id;
  const kept = await call('PUT', `/${id}`, { name: 'Q' });
  assert.equal(kept.body.data.assigned_to, BOB);
  assert.equal(kept.body.data.draw_count, 3);
  assert.deepEqual(kept.body.data.items.map((i) => i.title), ['a', 'b'], 'ohne items bleiben die Ideen');
  assert.equal((await call('PUT', `/${id}`, { enabled: false })).body.data.enabled, false);
  assert.equal((await call('PUT', `/${id}`, { enabled: true })).body.data.enabled, true);
  assert.equal((await call('PUT', `/${id}`, { assigned_to: null })).body.data.assigned_to, null);
  assert.equal((await call('PUT', `/${id}`, { draw_count: 0 })).status, 400);
});

test('die Ideen reisen mit dem Pool: wer bleibt, behaelt seine Ruhezeit', async () => {
  reset();
  as(ALICE);
  const { body } = await call('POST', '/', { name: 'P', items: ['a', 'b', 'c'] });
  const id = body.data.id;
  const [a] = body.data.items;
  db.prepare('UPDATE task_pool_items SET last_drawn_on = ? WHERE id = ?').run(MONDAY, a.id);

  const saved = await call('PUT', `/${id}`, { items: ['a', 'c', 'd'] });
  assert.deepEqual(saved.body.data.items.map((i) => i.title), ['a', 'c', 'd'], 'b is gone, d is new');
  const kept = saved.body.data.items.find((i) => i.title === 'a');
  assert.equal(kept.id, a.id, 'the same idea');
  assert.equal(kept.last_drawn_on, MONDAY, 'it keeps its rest period');
  assert.equal(saved.body.data.items.find((i) => i.title === 'd').last_drawn_on, null);

  assert.deepEqual((await call('PUT', `/${id}`, { items: [] })).body.data.items, [], 'an empty list empties the pool');
  assert.equal((await call('PUT', `/${id}`, { items: 'x' })).status, 400);
});

test('der Zug sieht den Stand nach dem Speichern: gestrichene Idee wird nicht mehr gezogen', async () => {
  reset();
  as(ALICE);
  const { body } = await call('POST', '/', { name: 'P', items: ['alt', 'neu'] });
  await call('PUT', `/${body.data.id}`, { items: ['neu'] });
  const made = drawDuePools(db, { today: MONDAY, pick: () => 0 });
  assert.equal(made.drawn, 1);
  assert.equal(db.prepare('SELECT title FROM tasks').get().title, 'neu');
});

test('Deckel: Ideen je Pool und Pools je Haushalt', async () => {
  reset();
  as(ALICE);
  const tooMany = Array.from({ length: MAX_ITEMS_PER_POOL + 1 }, (_, i) => `i${i}`);
  assert.equal((await call('POST', '/', { name: 'x', items: tooMany })).status, 400);
  assert.equal((await call('POST', '/', { name: 'x', items: tooMany.slice(1) })).status, 201);
  reset();
  for (let i = 0; i < MAX_POOLS; i += 1) makePool({ name: `p${i}` }, []);
  const refused = await call('POST', '/', { name: 'zu viel' });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.reason, 'task_pools_limit_reached');
  assert.deepEqual(refused.body.params, { limit: MAX_POOLS });
});

test('einen Pool loeschen laesst die gezogenen Aufgaben stehen', async () => {
  reset();
  as(ALICE);
  const { body } = await call('POST', '/', { name: 'P', items: ['x'] });
  drawDuePools(db, { today: MONDAY });
  assert.equal((await call('DELETE', `/${body.data.id}`)).status, 204);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_pool_items').get().n, 0, 'the ideas go with the pool');
  const gone = await call('DELETE', `/${body.data.id}`);
  assert.equal(gone.status, 404);
  assert.equal(gone.body.reason, 'task_pools_pool_not_found');
});

// --------------------------------------------------------
// 6. People who leave the household
// --------------------------------------------------------

test('ein persoenlicher Pool einer Person, die nicht mehr im Haushalt ist, zieht nicht', () => {
  reset();
  const gone = user('former-member');
  const pool = makePool({ assigned_to: gone }, ['x']);
  db.prepare("UPDATE users SET deactivated_at = datetime('now') WHERE id = ?").run(gone);
  assert.deepEqual(drawFromPool(db, pool, { today: MONDAY }), []);
  assert.equal(drawDuePools(db, { today: MONDAY }).drawn, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
  assert.equal(db.prepare('SELECT last_drawn_on FROM task_pools WHERE id = ?').get(pool.id).last_drawn_on, null,
    'a dormant pool does not use up the day');
  db.prepare('UPDATE task_pools SET assigned_to = ? WHERE id = ?').run(BOB, pool.id);
  assert.equal(drawDuePools(db, { today: MONDAY }).drawn, 1, 'given to someone else, it wakes up');
});

test('Route: ein Pool behaelt seine Person nach dem Austritt, neue Personen muessen Mitglieder sein', async () => {
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
  assert.equal((await call('PUT', `/${id}`, { assigned_to: other })).status, 400);
  assert.equal((await call('PUT', `/${id}`, { assigned_to: 999999 })).status, 400, 'an unknown id is refused, not a 500');
});

test('ein persoenlicher Pool endet mit dem Konto - ein geteilter, den die Person angelegt hat, nicht', async () => {
  const { PRIVATE_USER_COLUMNS } = await import('../server/services/user-removal.js');
  assert.ok(PRIVATE_USER_COLUMNS.has('task_pools.assigned_to'));
  assert.ok(!PRIVATE_USER_COLUMNS.has('task_pools.created_by'));
});

// --------------------------------------------------------
// 7. Migration
// --------------------------------------------------------

test('Migration 278 legt das Schema an, ein zweiter Lauf aendert nichts, die Pruefungen greifen', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(':memory:');
  raw.exec('CREATE TABLE users (id INTEGER PRIMARY KEY);');
  const migration = dbmod.MIGRATIONS.find((m) => m.version === 278);
  assert.ok(migration, 'migration 278 exists');
  assert.equal(dbmod.MIGRATIONS.filter((m) => m.version > 277).length, 1, 'the feature is one migration');
  migration.up(raw);
  raw.exec("INSERT INTO task_pools (name) VALUES ('p')");
  const once = JSON.stringify(raw.prepare('SELECT * FROM task_pools').all());
  migration.up(raw);
  assert.equal(JSON.stringify(raw.prepare('SELECT * FROM task_pools').all()), once, 'a second run changes nothing');
  assert.deepEqual({ ...raw.prepare('SELECT * FROM task_pools').get(), created_at: null }, {
    id: 1, name: 'p', assigned_to: null, created_by: null, draw_count: 1, cooldown_days: 30, enabled: 1,
    last_drawn_on: null, created_at: null,
  }, 'the defaults');
  for (const bad of ['draw_count = 0', 'draw_count = 6', 'cooldown_days = -1', 'cooldown_days = 366', 'enabled = 2']) {
    assert.throws(() => raw.exec(`UPDATE task_pools SET ${bad} WHERE id = 1`), bad);
  }
});

test('die echte Datenbank traegt das Schema der Migration 278', () => {
  assert.deepEqual(db.prepare('PRAGMA table_info(task_pools)').all().map((c) => c.name), [
    'id', 'name', 'assigned_to', 'created_by', 'draw_count', 'cooldown_days', 'enabled', 'last_drawn_on', 'created_at',
  ]);
  assert.deepEqual(db.prepare('PRAGMA table_info(task_pool_items)').all().map((c) => c.name), [
    'id', 'pool_id', 'title', 'last_drawn_on', 'created_at',
  ]);
});
