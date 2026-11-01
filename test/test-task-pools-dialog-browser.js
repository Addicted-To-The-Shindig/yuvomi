/**
 * Test: the task pools dialog in a real browser (D#2254)
 * Purpose: What only a real page can show - the dialog the way it is clicked,
 *          against the real route and an in-memory database:
 *          1. a new pool: the rare settings sit behind "More details", the
 *             household's default points are the start value, the ideas are one
 *             per line and arrive trimmed and without duplicates,
 *          2. the weekdays: the last chosen one cannot be switched off,
 *          3. who a reminder reaches is a choice for shared pools only,
 *          4. editing a line RENAMES the idea (one PUT on the same row), it is
 *             not deleted and added again,
 *          5. a pool whose person has left the household keeps them selected,
 *          6. "Draw now" creates the task, and a second one says why it cannot,
 *          7. deleting asks first and leaves the drawn tasks alone,
 *          8. the settings that keep a pool from piling up - category, "only draw when nothing
 *             is open", "no due date" - and a category that was deleted stays selected.
 * Run: npm run test:task-pools-dialog-browser
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import { launchBrowser } from '../scripts/lib/chrome-executable.js';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
// The page runs in English and reads its expectations from en.json: without a
// stored locale, i18n.js falls back to navigator.languages, and headless Chrome
// takes those from the host.
const LOCALE = 'en';
const MESSAGES = JSON.parse(readFileSync(new URL(`../public/locales/${LOCALE}.json`, import.meta.url), 'utf8'));
const tr = (key) => key.split('.').reduce((node, part) => node?.[part], MESSAGES) ?? assert.fail(`missing ${LOCALE} key ${key}`);

const dbmod = await import('../server/db.js');
const { default: taskPoolsRouter } = await import('../server/routes/task-pools.js');
const db = dbmod.get();
const user = (name) => Number(db.prepare(
  "INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, 'x', 'member')",
).run(name, name).lastInsertRowid);
const ME = user('Me');
const LENA = user('Lena');

const DEFAULT_POINTS = 4;
const writes = [];
let server;
let baseUrl;
let browser;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', (req, _res, next) => {
    if (req.method !== 'GET') writes.push({ method: req.method, path: req.path, body: req.body });
    req.authUserId = ME; req.authRole = 'member'; req.session = { userId: ME };
    next();
  });
  // The dialog asks the tasks module for the members and the default points; the
  // real tasks router is far more than this test needs.
  app.get('/api/v1/tasks/meta/options', (_req, res) => {
    const users = db.prepare("SELECT id, display_name FROM users WHERE deactivated_at IS NULL ORDER BY id").all();
    const categories = db.prepare('SELECT key, name, label_key, sort_order FROM task_categories ORDER BY sort_order, key').all();
    res.json({ users, categories, default_points: DEFAULT_POINTS });
  });
  app.use('/api/v1/task-pools', taskPoolsRouter);
  app.use('/api/v1', (_req, res) => res.json({ data: [] }));
  app.get('/__task-pools-probe.html', (_req, res) => res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles/tokens.css">
${['layout', 'typography', 'list-row', 'panel', 'tasks'].map((name) => `<link rel="stylesheet" href="/styles/${name}.css">`).join('')}</head>
<body><main id="c"></main><script type="module">
  import { initI18n } from '/i18n.js';
  import { setPermissions } from '/permissions.js';
  import '/components/datepicker.js';
  await initI18n();
  setPermissions({ admin: false, modules: { tasks: 'write' }, widgets: {}, capabilities: {} });
  window.__toasts = [];
  window.__changes = 0;
  window.yuvomi = { showToast: (message, type) => window.__toasts.push({ message, type }) };
  const { openTaskPoolsManager } = await import('/components/task-pools-manager.js');
  window.__open = () => openTaskPoolsManager({ onChange: () => { window.__changes += 1; } });
  window.__ready = true;
</script></body></html>`));
  app.use(express.static(PUBLIC));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await launchBrowser(puppeteer, { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
});

/** A page whose locale is fixed before any script of the app runs. */
async function newPage() {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((locale) => localStorage.setItem('yuvomi-locale', locale), LOCALE);
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.errors = errors;
  await page.goto(`${baseUrl}/__task-pools-probe.html`);
  await page.waitForFunction(() => window.__ready === true);
  return page;
}

/**
 * Waits until exactly one dialog is in the document and its panel has stopped
 * moving. A closing dialog stays for the length of its exit animation, and a
 * selector that matches in the old one would return before the new one is
 * there; a click on a panel that is still sliding in lands next to its target.
 */
const settled = (page) => page.waitForFunction(() => {
  const dialogs = document.querySelectorAll('dialog.modal-overlay');
  if (dialogs.length !== 1) { window.__panelRect = null; return false; }
  const r = dialogs[0].querySelector('.modal-panel')?.getBoundingClientRect();
  if (!r) return false;
  const key = [r.top, r.left, r.width, r.height].map(Math.round).join(',');
  const same = window.__panelRect?.key === key;
  const count = same ? window.__panelRect.count + 1 : 0;
  window.__panelRect = { key, count };
  return count >= 3;
}, { polling: 'raf' });

/**
 * Opens "More details" and waits until it has stopped moving. The disclosure
 * slides open, and a click inside it while it still moves lands on a target that
 * is gone by the time the click arrives - rare on a quiet machine, regular under
 * load. The summary is clicked again until the section is open: a click that
 * arrived while the dialog was still sliding in may have missed it.
 */
async function openAdvanced(page) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await settled(page);
    if (await page.$eval('details.form-advanced', (d) => d.open)) break;
    await page.click('.form-advanced__summary').catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.equal(await page.$eval('details.form-advanced', (d) => d.open), true, 'the disclosure opened');
  await page.evaluate(() => { window.__advHeight = null; });
  await page.waitForFunction(() => {
    const height = document.querySelector('details.form-advanced .form-advanced__body').getBoundingClientRect().height;
    const settledNow = height > 0 && window.__advHeight === height;
    window.__advHeight = height;
    return settledNow;
  }, { polling: 'raf' });
}

/** Opens the form for a new pool and waits until it stands still. */
async function openNewForm(page) {
  await page.click('#task-pool-add');
  await page.waitForSelector('#task-pool-name');
  await settled(page);
}

/** Opens the manager and waits until its list is there. */
async function openManager(page) {
  await page.evaluate(() => window.__open());
  await page.waitForSelector('#task-pool-add');
  await settled(page);
}

/** Opens the form of the first pool in the list. */
async function openFirstPool(page) {
  await settled(page);
  await page.click('[data-edit]');
  await page.waitForSelector('#task-pool-items');
  await settled(page);
}

/**
 * Runs an action that ends with the manager coming back (save, draw, delete) and
 * waits for exactly that: the tasks page was told (`onChange`) and the manager
 * is open again. The counter is the synchronisation point, not the DOM - the
 * old dialog is still in it while it fades out.
 */
async function andBackToTheList(page, action) {
  const before = await page.evaluate(() => window.__changes);
  await action();
  await page.waitForFunction((n) => window.__changes > n, {}, before);
  await page.waitForSelector('#task-pool-add');
  await settled(page);
}

const reset = () => {
  db.prepare('DELETE FROM task_pools').run();
  db.prepare('DELETE FROM task_assignments').run();
  db.prepare('DELETE FROM tasks').run();
  db.prepare('DELETE FROM reminders').run();
  writes.length = 0;
};

/**
 * Answers the confirmation dialog. A freshly opened dialog ignores clicks for a
 * moment on purpose (a tap meant for the page below must not confirm it), so the
 * click is repeated until the dialog has reacted.
 */
async function answerConfirm(page, which) {
  const selector = `#confirm-modal-${which}`;
  await page.waitForSelector(selector);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await page.click(selector).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!(await page.$(selector))) return;
  }
  assert.fail(`the confirmation dialog never reacted to "${which}"`);
}

/** Clicks the save button and waits for the manager to come back. */
const saveAndWaitForList = (page) => andBackToTheList(page, () => page.click('#task-pool-save'));

const poolWrites = () => writes.filter((w) => w.path.startsWith('/task-pools'));

test('a new pool: rare settings are folded away, points start at the household default, ideas are cleaned', async () => {
  reset();
  const page = await newPage();
  await openManager(page);
  assert.equal(await page.$eval('.task-pool-empty', (el) => el.textContent.trim()), tr('taskPools.empty'));

  await openNewForm(page);
  assert.equal(await page.$eval('details.form-advanced', (d) => d.open), false, 'the rare settings are behind the disclosure');
  assert.match(await page.$eval('.form-advanced__summary', (el) => el.textContent), new RegExp(tr('taskPools.advancedHint')));
  assert.equal(await page.$('#task-pool-draw'), null, 'a new pool has nothing to draw yet');

  await openAdvanced(page);
  assert.equal(await page.$eval('#task-pool-points', (el) => el.value), String(DEFAULT_POINTS), 'the household default points');
  assert.equal(await page.$eval('#task-pool-interval', (el) => el.value), '1');
  assert.equal(await page.$eval('#task-pool-cooldown', (el) => el.value), '30');

  // A first save without a name is refused at the field, and nothing is sent.
  await page.click('#task-pool-save');
  await page.waitForFunction(() => document.querySelector('#task-pool-name')?.closest('.form-field, .form-group')?.textContent.includes('name'));
  assert.equal(poolWrites().length, 0);

  await page.type('#task-pool-name', 'Daily impulse');
  await page.type('#task-pool-items', ' Call family \n\nTidy up\nCall family\n');
  await saveAndWaitForList(page);

  const [post] = poolWrites();
  assert.equal(post.method, 'POST');
  assert.equal(post.body.name, 'Daily impulse');
  assert.deepEqual(post.body.items, ['Call family', 'Tidy up'], 'trimmed, no empty line, no duplicate');
  assert.equal(post.body.points, DEFAULT_POINTS);
  assert.equal(post.body.assigned_to, null, 'shared by default');
  assert.equal(post.body.category, 'misc');
  assert.equal(post.body.skip_if_open, false, 'off by default');
  assert.equal(post.body.no_due_date, false, 'off by default');
  assert.deepEqual(post.body.weekdays, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(await page.$eval('.task-pool-row__name', (el) => el.textContent), 'Daily impulse');
  assert.ok(await page.evaluate(() => window.__changes) >= 1, 'the tasks page is told to reload');
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('the last chosen weekday cannot be switched off', async () => {
  reset();
  const page = await newPage();
  await openManager(page);
  await openNewForm(page);
  await openAdvanced(page);
  const active = () => page.$$eval('#task-pool-weekdays .rrule-day--active', (els) => els.map((el) => el.dataset.day));

  for (const day of [2, 3, 4, 5, 6, 7]) await page.click(`#task-pool-weekdays [data-day="${day}"]`);
  assert.deepEqual(await active(), ['1']);
  await page.click('#task-pool-weekdays [data-day="1"]');
  assert.deepEqual(await active(), ['1'], 'the last one stays');
  await page.click('#task-pool-weekdays [data-day="3"]');
  assert.deepEqual(await active(), ['1', '3']);

  await page.type('#task-pool-name', 'Two days');
  await saveAndWaitForList(page);
  assert.deepEqual(poolWrites()[0].body.weekdays, [1, 3]);
  await page.close();
});

test('who a reminder reaches is a choice for shared pools only', async () => {
  reset();
  const page = await newPage();
  await openManager(page);
  await openNewForm(page);
  await openAdvanced(page);
  const visible = () => page.$eval('#task-pool-remind-who-group', (el) => !el.hidden);

  assert.equal(await visible(), true, 'shared by default');
  await page.select('#task-pool-audience', String(LENA));
  assert.equal(await visible(), false, 'a personal pool always reminds its person');
  await page.select('#task-pool-audience', '');
  assert.equal(await visible(), true);

  await page.type('#task-pool-name', 'Only me');
  await page.select('#task-pool-remind-who', 'creator');
  await saveAndWaitForList(page);
  assert.equal(poolWrites()[0].body.remind_scope, 'creator');
  await page.close();
});

test('editing a line renames the idea - one PUT on the same row, not a delete and an add', async () => {
  reset();
  const made = db.prepare("INSERT INTO task_pools (name, created_by) VALUES ('Impulse', ?)").run(ME);
  const poolId = Number(made.lastInsertRowid);
  for (const title of ['Call famly', 'Tidy up', 'Water the plants']) {
    db.prepare('INSERT INTO task_pool_items (pool_id, title) VALUES (?, ?)').run(poolId, title);
  }
  const before = db.prepare('SELECT id, title FROM task_pool_items ORDER BY id').all();

  const page = await newPage();
  await openManager(page);
  await openFirstPool(page);
  assert.equal(await page.$eval('#task-pool-items', (el) => el.value), 'Call famly\nTidy up\nWater the plants');

  // Fix the typo in the first line, keep the others.
  await page.$eval('#task-pool-items', (el) => { el.value = 'Call family\nTidy up\nWater the plants'; });
  await saveAndWaitForList(page);

  const methods = poolWrites().map((w) => `${w.method} ${w.path}`);
  assert.deepEqual(methods, [`PUT /task-pools/${poolId}`, `PUT /task-pools/${poolId}/items/${before[0].id}`],
    'the pool, then one rename - no DELETE, no POST');
  assert.deepEqual(poolWrites()[1].body, { title: 'Call family' });
  const after = db.prepare('SELECT id, title FROM task_pool_items ORDER BY id').all();
  assert.deepEqual(after.map((i) => i.id), before.map((i) => i.id), 'the same rows');
  assert.deepEqual(after.map((i) => i.title), ['Call family', 'Tidy up', 'Water the plants']);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('a person who has left the household stays selected, and the pool keeps them on save', async () => {
  reset();
  const gone = user('Former');
  const made = db.prepare("INSERT INTO task_pools (name, created_by, assigned_to) VALUES ('Theirs', ?, ?)").run(ME, gone);
  db.prepare("UPDATE users SET deactivated_at = datetime('now') WHERE id = ?").run(gone);

  const page = await newPage();
  await openManager(page);
  assert.match(await page.$eval('.task-pool-row__meta', (el) => el.textContent), /Former/);
  await openFirstPool(page);
  assert.equal(await page.$eval('#task-pool-audience', (el) => el.value), String(gone),
    'selected, not silently turned into "Everyone"');
  assert.equal(await page.$eval('#task-pool-remind-who-group', (el) => el.hidden), true, 'still a personal pool');

  await saveAndWaitForList(page);
  assert.equal(poolWrites()[0].body.assigned_to, gone);
  assert.equal(db.prepare('SELECT assigned_to FROM task_pools WHERE id = ?').get(Number(made.lastInsertRowid)).assigned_to, gone);
  await page.close();
});

test('"Draw now" creates the task, and a second one says why nothing is drawn', async () => {
  reset();
  const made = db.prepare("INSERT INTO task_pools (name, created_by) VALUES ('Impulse', ?)").run(ME);
  db.prepare('INSERT INTO task_pool_items (pool_id, title) VALUES (?, ?)').run(Number(made.lastInsertRowid), 'Only idea');

  const page = await newPage();
  await openManager(page);
  await openFirstPool(page);
  await andBackToTheList(page, () => page.click('#task-pool-draw'));
  assert.deepEqual(db.prepare('SELECT title, status FROM tasks').all().map((t) => ({ ...t })), [{ title: 'Only idea', status: 'open' }]);
  const toasts = await page.evaluate(() => window.__toasts);
  assert.ok(toasts.some((t) => t.type === 'success' && t.message.includes('Only idea')), 'says what was drawn');

  await openFirstPool(page);
  await page.click('#task-pool-draw');
  await page.waitForFunction(() => window.__toasts.some((t) => t.type === 'danger'));
  const refusal = (await page.evaluate(() => window.__toasts)).find((t) => t.type === 'danger');
  assert.equal(refusal.message, tr('taskPools.errorNothingToDraw'), 'the sentence of the app, not the server text');
  assert.equal(await page.$eval('#task-pool-draw', (el) => el.disabled), false, 'the form stays usable');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1, 'still one task');
  await page.close();
});

test('deleting a pool asks first and leaves the drawn tasks alone', async () => {
  reset();
  const made = db.prepare("INSERT INTO task_pools (name, created_by) VALUES ('Impulse', ?)").run(ME);
  db.prepare('INSERT INTO task_pool_items (pool_id, title) VALUES (?, ?)').run(Number(made.lastInsertRowid), 'Idea');

  const page = await newPage();
  await openManager(page);
  await openFirstPool(page);
  await andBackToTheList(page, () => page.click('#task-pool-draw'));

  await openFirstPool(page);
  await page.click('#task-pool-delete');
  await answerConfirm(page, 'cancel');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_pools').get().n, 1, 'cancelled: nothing deleted');

  await page.waitForSelector('#task-pool-delete');
  await andBackToTheList(page, async () => {
    await page.click('#task-pool-delete');
    await answerConfirm(page, 'ok');
  });
  await page.waitForSelector('.task-pool-empty');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_pools').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1, 'the drawn task stays');
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('category, "only draw when nothing is open" and "no due date" are sent - and a deleted category stays selected', async () => {
  reset();
  db.prepare("INSERT OR IGNORE INTO task_categories (key, name, sort_order) VALUES ('mini-chores', 'Mini chores', 99)").run();
  try {
    const page = await newPage();
    await openManager(page);
    await openNewForm(page);
    await openAdvanced(page);

    const options = await page.$$eval('#task-pool-category option', (els) => els.map((el) => ({ value: el.value, label: el.textContent, selected: el.selected })));
    assert.ok(options.length >= 8, 'the household categories are offered');
    assert.deepEqual(options.find((o) => o.selected)?.value, 'misc', 'the fallback category is the start value');
    assert.equal(options.find((o) => o.value === 'mini-chores')?.label, 'Mini chores', 'a custom category by its name');
    assert.equal(options.find((o) => o.value === 'household')?.label, tr('tasks.categoryHousehold'), 'a seed category by its translation');

    await page.type('#task-pool-name', 'No pile-up');
    await page.select('#task-pool-category', 'mini-chores');
    await page.evaluate(() => document.querySelector('#task-pool-skip-open').closest('label').click());
    await page.evaluate(() => document.querySelector('#task-pool-no-due').closest('label').click());
    await saveAndWaitForList(page);
    const [post] = poolWrites();
    assert.equal(post.body.category, 'mini-chores');
    assert.equal(post.body.skip_if_open, true);
    assert.equal(post.body.no_due_date, true);

    // The category goes away while the pool still names it: it stays selected and the pool saves unchanged.
    db.prepare("DELETE FROM task_categories WHERE key = 'mini-chores'").run();
    await openFirstPool(page);
    await openAdvanced(page);
    assert.equal(await page.$eval('#task-pool-category', (el) => el.value), 'mini-chores', 'not silently replaced');
    assert.equal(await page.$eval('#task-pool-skip-open', (el) => el.checked), true);
    assert.equal(await page.$eval('#task-pool-no-due', (el) => el.checked), true);
    writes.length = 0;
    await saveAndWaitForList(page);
    assert.equal(poolWrites()[0].body.category, 'mini-chores');
    assert.equal(db.prepare('SELECT category FROM task_pools').get().category, 'mini-chores');
    assert.deepEqual(page.errors, []);
    await page.close();
  } finally {
    db.prepare("DELETE FROM task_categories WHERE key = 'mini-chores'").run();
  }
});
