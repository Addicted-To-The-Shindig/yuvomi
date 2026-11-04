/**
 * Test: the task pools dialog in a real browser (D#2254)
 * Purpose: What only a real page can show - the dialog the way it is clicked,
 *          against the real route and an in-memory database:
 *          1. a new pool: the ideas are one per line and arrive trimmed and
 *             without duplicates, shared by default,
 *          2. editing keeps the pool's person and ideas, and a paused pool says so,
 *          3. a pool whose person has left the household keeps them selected,
 *          4. deleting asks first and leaves the drawn tasks alone.
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
  // The dialog asks the tasks module for the members; the real tasks router is
  // far more than this test needs.
  app.get('/api/v1/tasks/meta/options', (_req, res) => {
    const users = db.prepare("SELECT id, display_name FROM users WHERE deactivated_at IS NULL ORDER BY id").all();
    res.json({ users });
  });
  app.use('/api/v1/task-pools', taskPoolsRouter);
  app.use('/api/v1', (_req, res) => res.json({ data: [] }));
  app.get('/__task-pools-probe.html', (_req, res) => res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles/tokens.css">
${['layout', 'typography', 'list-row', 'panel', 'tasks'].map((name) => `<link rel="stylesheet" href="/styles/${name}.css">`).join('')}</head>
<body><main id="c"></main><script type="module">
  import { initI18n } from '/i18n.js';
  import { setPermissions } from '/permissions.js';
  await initI18n();
  setPermissions({ admin: false, modules: { tasks: 'write' }, widgets: {}, capabilities: {} });
  window.__toasts = [];
  window.yuvomi = { showToast: (message, type) => window.__toasts.push({ message, type }) };
  const { openTaskPoolsManager } = await import('/components/task-pools-manager.js');
  window.__open = () => openTaskPoolsManager();
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
 * Runs an action that ends with the manager coming back (save, delete) and waits
 * for exactly that. The form has no add button, so the selector only matches the
 * manager - and `settled` waits until the closing form is out of the document.
 */
async function andBackToTheList(page, action) {
  await action();
  await page.waitForSelector('#task-pool-add');
  await settled(page);
}

const reset = () => {
  db.prepare('DELETE FROM task_pools').run();
  db.prepare('DELETE FROM task_assignments').run();
  db.prepare('DELETE FROM tasks').run();
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

test('a new pool: ideas are cleaned, shared by default', async () => {
  reset();
  const page = await newPage();
  await openManager(page);
  assert.equal(await page.$eval('.task-pool-empty', (el) => el.textContent.trim()), tr('taskPools.empty'));

  await openNewForm(page);
  assert.equal(await page.$eval('#task-pool-per-day', (el) => el.value), '1');
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
  assert.equal(post.body.assigned_to, null, 'shared by default');
  assert.equal(post.body.enabled, true);
  assert.equal(await page.$eval('.task-pool-row__name', (el) => el.textContent), 'Daily impulse');
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('editing: the ideas are filled in, a change is one PUT, and a paused pool says so', async () => {
  reset();
  const made = db.prepare("INSERT INTO task_pools (name, created_by, assigned_to) VALUES ('Mine', ?, ?)").run(ME, LENA);
  const poolId = Number(made.lastInsertRowid);
  for (const title of ['a', 'b']) db.prepare('INSERT INTO task_pool_items (pool_id, title) VALUES (?, ?)').run(poolId, title);

  const page = await newPage();
  await openManager(page);
  assert.match(await page.$eval('.task-pool-row__meta', (el) => el.textContent), /Lena/);
  await openFirstPool(page);
  assert.equal(await page.$eval('#task-pool-items', (el) => el.value), 'a\nb');
  assert.equal(await page.$eval('#task-pool-audience', (el) => el.value), String(LENA));

  await page.$eval('#task-pool-items', (el) => { el.value = 'a\nc'; });
  await page.click('#task-pool-enabled');
  await saveAndWaitForList(page);

  const [put] = poolWrites();
  assert.equal(put.method, 'PUT');
  assert.deepEqual(put.body.items, ['a', 'c']);
  assert.equal(put.body.enabled, false);
  assert.equal(put.body.assigned_to, LENA, 'the person stays');
  assert.deepEqual(db.prepare('SELECT title FROM task_pool_items WHERE pool_id = ? ORDER BY id').all(poolId).map((r) => r.title), ['a', 'c']);
  assert.match(await page.$eval('.task-pool-row__meta', (el) => el.textContent), new RegExp(tr('taskPools.pausedBadge')));
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

  await saveAndWaitForList(page);
  assert.equal(poolWrites()[0].body.assigned_to, gone);
  assert.equal(db.prepare('SELECT assigned_to FROM task_pools WHERE id = ?').get(Number(made.lastInsertRowid)).assigned_to, gone);
  await page.close();
});

test('deleting a pool asks first and leaves the drawn tasks alone', async () => {
  reset();
  const made = db.prepare("INSERT INTO task_pools (name, created_by) VALUES ('Impulse', ?)").run(ME);
  db.prepare('INSERT INTO task_pool_items (pool_id, title) VALUES (?, ?)').run(Number(made.lastInsertRowid), 'Idea');
  db.prepare("INSERT INTO tasks (title, created_by) VALUES ('Drawn earlier', ?)").run(ME);

  const page = await newPage();
  await openManager(page);
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
