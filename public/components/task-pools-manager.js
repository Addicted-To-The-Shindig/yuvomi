/**
 * Module: Manage task pools (D#2254)
 * Purpose: The dialog behind "Idea pools" in the tools menu of the tasks page -
 *          create, change, delete and draw by hand.
 * Dependencies: /api.js, /components/modal.js, /utils/friendly-error.js
 *
 * A DIALOG AND NOT A PAGE, like the quick links: whoever sees tasks is already
 * where the pools belong, and a page for a handful of lists makes the
 * navigation more expensive than it is worth.
 *
 * THE IDEAS ARE ONE TEXT FIELD, ONE IDEA PER LINE. A pool is a loose list, and
 * keeping it that way means: paste, type, done. On save the list is held
 * against the state of the server (see utils/task-pool-ideas.js) - an edited
 * line renames its idea, what is missing is removed, what is new is added, and
 * what stays keeps its cooldown.
 */

import { api } from '/api.js';
import { t, formatTimeInput, parseTimeInput } from '/i18n.js';
import { esc } from '/utils/html.js';
import { rowActionHtml } from '/utils/row-action.js';
import { formSwitchRowHtml } from '/settings/components.js';
import { errorSentence, isGone } from '/utils/friendly-error.js';
import { reloadAfterSave } from '/utils/reload-after-save.js';
import { FALLBACK_CATEGORY, catLabel } from '/utils/task-fields.js';
import { parseIdeas, planIdeaChanges } from '/utils/task-pool-ideas.js';
import {
  openModal, closeModal, captureModalContext, captureOpenContext, isModalContextCurrent,
  confirmOverModal, reportFieldError, btnError, dialogInitialFocus, advancedSection,
} from '/components/modal.js';

/** The same cap as in server/routes/task-pools.js. */
const MAX_NAME = 100;

function audienceName(pool) {
  return pool.assigned_to ? pool.assigned_name : t('taskPools.audienceEveryone');
}

function rowHtml(pool) {
  return `
    <li class="task-pool-row${pool.enabled ? '' : ' task-pool-row--off'}" data-id="${pool.id}">
      <span class="task-pool-row__body">
        <span class="task-pool-row__name">${esc(pool.name)}</span>
        <span class="task-pool-row__meta">${esc(audienceName(pool))}${pool.enabled ? '' : ` · ${esc(t('taskPools.pausedBadge'))}`}</span>
      </span>
      ${pool.can_edit
    ? rowActionHtml({ icon: 'pencil', label: t('taskPools.editOne', { name: pool.name }), attrs: { 'data-edit': pool.id } })
    : ''}
    </li>`;
}

/**
 * Opens the manager.
 * @param {object} opts
 * @param {Function} opts.onChange  after every change that affects tasks
 */
export async function openTaskPoolsManager({ onChange = () => {} } = {}) {
  const context = captureOpenContext();
  let pools = [];
  try {
    pools = (await api.get('/task-pools'))?.data ?? [];
  } catch (err) {
    window.yuvomi?.showToast(errorSentence(err), 'danger');
    return;
  }
  if (!isModalContextCurrent(context)) return;

  const reload = async () => {
    await onChange();
    await openTaskPoolsManager({ onChange });
  };

  openModal({
    title: t('taskPools.title'),
    size: 'sm',
    content: `
      ${pools.length
    ? `<ul class="task-pool-list">${pools.map(rowHtml).join('')}</ul>`
    : `<p class="task-pool-empty">${esc(t('taskPools.empty'))}</p>`}
      <button type="button" class="btn btn--secondary task-pool-add" id="task-pool-add">
        <i data-lucide="plus" aria-hidden="true"></i>
        <span>${esc(t('taskPools.add'))}</span>
      </button>
      <div class="modal-panel__footer modal-panel__footer--plain">
        <button type="button" class="btn btn--secondary" id="task-pool-close">${esc(t('common.close'))}</button>
      </div>`,
    onSave(panel) {
      panel.querySelector('#task-pool-close').addEventListener('click', () => closeModal({ force: true }));
      panel.querySelector('#task-pool-add').addEventListener('click', () => openPoolForm(null, [], reload));
      panel.querySelectorAll('[data-edit]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const pool = pools.find((p) => String(p.id) === btn.dataset.edit);
          if (pool) openPoolForm(pool, pool.items, reload);
        });
      });
    },
  });
}

/** Weekdays 1 (Monday) to 7 (Sunday), the way the server counts them; the names come from rrule-ui. */
const WEEKDAY_LABELS = () => [
  t('rrule.dayMo'), t('rrule.dayTu'), t('rrule.dayWe'), t('rrule.dayTh'),
  t('rrule.dayFr'), t('rrule.daySa'), t('rrule.daySu'),
];

function weekdayButtonsHtml(selected) {
  return WEEKDAY_LABELS().map((label, i) => {
    const active = selected.includes(i + 1);
    return `<button type="button" class="rrule-day${active ? ' rrule-day--active' : ''}" data-day="${i + 1}"
             aria-label="${esc(label)}" aria-pressed="${active}">${esc(label)}</button>`;
  }).join('');
}

/**
 * The task categories a pool can draw into. A category that has been deleted since
 * stays in the list under its key, selected - otherwise the select would jump to the
 * first entry and saving would change the pool's category without anyone asking.
 */
function categoryOptions(selected, categories) {
  const list = categories.some((c) => c.key === selected) ? categories : [...categories, { key: selected }];
  return list.map((c) => `<option value="${esc(c.key)}"${c.key === selected ? ' selected' : ''}>${esc(catLabel(c.key, categories))}</option>`).join('');
}

/**
 * The seldom-needed settings of a pool, behind "More settings": schedule,
 * points, reminder and what happens to a finished idea. What a pool is about
 * (name, who gets it, the ideas) stays in view.
 */
function advancedFieldsHtml(pool, defaultPoints, audience, categories) {
  return `
    <div class="form-group">
      <label class="form-label" for="task-pool-per-day">${esc(t('taskPools.perDayLabel'))}</label>
      <input type="number" class="form-input" id="task-pool-per-day" min="1" max="5" step="1" value="${pool?.draw_count ?? 1}">
    </div>
    <div class="form-group">
      <label class="form-label" for="task-pool-interval">${esc(t('taskPools.intervalLabel'))}</label>
      <input type="number" class="form-input" id="task-pool-interval" min="1" max="365" step="1" value="${pool?.interval_days ?? 1}">
    </div>
    <div class="form-group">
      <span class="form-label" id="task-pool-weekdays-label">${esc(t('rrule.labelOnDays'))}</span>
      <div class="rrule-day-grid" id="task-pool-weekdays" role="group" aria-labelledby="task-pool-weekdays-label">
        ${weekdayButtonsHtml(pool?.weekdays ?? [1, 2, 3, 4, 5, 6, 7])}
      </div>
    </div>
    <div class="form-group">
      <label class="form-label" for="task-pool-cooldown">${esc(t('taskPools.cooldownLabel'))}</label>
      <input type="number" class="form-input" id="task-pool-cooldown" min="0" max="365" step="1" value="${pool?.cooldown_days ?? 30}">
    </div>
    ${formSwitchRowHtml({
    label: t('taskPools.skipIfOpenLabel'),
    checked: Boolean(pool?.skip_if_open),
    attrs: { id: 'task-pool-skip-open' },
  })}
    <div class="form-group">
      <label class="form-label" for="task-pool-category">${esc(t('tasks.categoryLabel'))}</label>
      <select class="form-input" id="task-pool-category">
        ${categoryOptions(pool?.category ?? FALLBACK_CATEGORY, categories)}
      </select>
    </div>
    <div class="form-group">
      <label class="form-label" for="task-pool-points">${esc(t('tasks.pointsLabel'))}</label>
      <input type="number" class="form-input" id="task-pool-points" min="0" max="10000" step="1" inputmode="numeric"
             value="${pool ? pool.points : defaultPoints}">
    </div>
    <div class="form-group">
      <label class="form-label" for="task-pool-time">${esc(t('tasks.dueTimeLabel'))}</label>
      <yuvomi-datepicker type="time" id="task-pool-time" name="remind_time"
             value="${esc(formatTimeInput(pool?.remind_time ?? ''))}"></yuvomi-datepicker>
      <p class="form-hint">${esc(t('taskPools.remindHint'))}</p>
    </div>
    ${formSwitchRowHtml({
    label: t('taskPools.noDueDateLabel'),
    checked: Boolean(pool?.no_due_date),
    attrs: { id: 'task-pool-no-due' },
  })}
    <!-- Shared pools only: a personal pool always reminds its own person. -->
    <div class="form-group" id="task-pool-remind-who-group"${audience === '' ? '' : ' hidden'}>
      <label class="form-label" for="task-pool-remind-who">${esc(t('taskPools.remindWhoLabel'))}</label>
      <select class="form-input" id="task-pool-remind-who">
        <option value="all"${(pool?.remind_scope ?? 'all') === 'all' ? ' selected' : ''}>${esc(t('taskPools.remindWhoAll'))}</option>
        <option value="creator"${pool?.remind_scope === 'creator' ? ' selected' : ''}>${esc(t('taskPools.remindWhoCreator'))}</option>
      </select>
    </div>
    ${formSwitchRowHtml({
    label: t('taskPools.retireDoneLabel'),
    checked: Boolean(pool?.retire_done),
    attrs: { id: 'task-pool-retire' },
  })}
    ${formSwitchRowHtml({
    label: t('taskPools.enabledLabel'),
    checked: pool ? Boolean(pool.enabled) : true,
    attrs: { id: 'task-pool-enabled' },
  })}`;
}

/**
 * The people a pool can be given to. A person who has left the household since
 * stays in the list under their name, selected - otherwise the select would
 * fall back to "Everyone" and saving would silently turn the pool into a shared one.
 */
function audienceOptions(pool, users, audience) {
  const people = pool?.assigned_to && !users.some((u) => u.id === pool.assigned_to)
    ? [...users, { id: pool.assigned_to, display_name: pool.assigned_name ?? '' }]
    : users;
  return people.map((u) => `<option value="${u.id}"${audience === u.id ? ' selected' : ''}>${esc(u.display_name)}</option>`).join('');
}

function formHtml(pool, items, users, defaultPoints = 0, categories = []) {
  const isEdit = Boolean(pool);
  const audience = pool?.assigned_to ?? '';
  return `
    <div class="form-group">
      <label class="form-label" for="task-pool-name">${esc(t('taskPools.nameLabel'))}</label>
      <input type="text" class="form-input" id="task-pool-name" maxlength="${MAX_NAME}" value="${esc(pool?.name ?? '')}">
    </div>
    <div class="form-group">
      <label class="form-label" for="task-pool-audience">${esc(t('taskPools.audienceLabel'))}</label>
      <select class="form-input" id="task-pool-audience">
        <option value=""${audience === '' ? ' selected' : ''}>${esc(t('taskPools.audienceEveryone'))}</option>
        ${audienceOptions(pool, users, audience)}
      </select>
    </div>
    <div class="form-group">
      <label class="form-label" for="task-pool-items">${esc(t('taskPools.itemsLabel'))}</label>
      <textarea class="form-input" id="task-pool-items" rows="6" maxlength="20000">${esc(items.map((i) => i.title).join('\n'))}</textarea>
      <p class="form-hint">${esc(t('taskPools.itemsHint'))}</p>
    </div>
    ${isEdit ? `
    <button type="button" class="btn btn--secondary task-pool-draw" id="task-pool-draw">
      <i data-lucide="shuffle" aria-hidden="true"></i>
      <span>${esc(t('taskPools.drawNow', { name: pool.name }))}</span>
    </button>` : ''}
    ${advancedSection(advancedFieldsHtml(pool, defaultPoints, audience, categories), { hint: t('taskPools.advancedHint') })}
    <div class="modal-panel__footer modal-panel__footer--plain">
      ${isEdit ? `<button type="button" class="btn btn--danger-outline" id="task-pool-delete">${esc(t('common.delete'))}</button>` : ''}
      <button type="button" class="btn btn--secondary" id="task-pool-cancel">${esc(t('common.cancel'))}</button>
      <button type="button" class="btn btn--primary" id="task-pool-save">${esc(isEdit ? t('common.save') : t('common.add'))}</button>
    </div>`;
}

/**
 * The form for a new or an existing pool.
 * @param {object|null} pool  null = new
 * @param {{id:number,title:string}[]} items  the saved state
 * @param {Function} onDone  after a successful save, delete or draw
 */
async function openPoolForm(pool, items, onDone) {
  const isEdit = Boolean(pool);
  const context = captureOpenContext();
  let users = [];
  let categories = [];
  let defaultPoints = 0;
  try {
    const meta = await api.get('/tasks/meta/options');
    users = meta?.users ?? [];
    categories = meta?.categories ?? [];
    // A new pool starts with the household's default point value, like a new task.
    defaultPoints = Number(meta?.default_points) || 0;
  } catch (err) {
    window.yuvomi?.showToast(errorSentence(err), 'danger');
    return;
  }
  if (!isModalContextCurrent(context)) return;

  openModal({
    title: isEdit ? t('taskPools.editTitle') : t('taskPools.addTitle'),
    initialFocus: dialogInitialFocus(isEdit),
    size: 'sm',
    content: formHtml(pool, items, users, defaultPoints, categories),
    onSave(panel) {
      panel.querySelector('#task-pool-cancel').addEventListener('click', () => closeModal());

      // Who a reminder reaches is a choice for shared pools only.
      const audienceSelect = panel.querySelector('#task-pool-audience');
      const remindWhoGroup = panel.querySelector('#task-pool-remind-who-group');
      audienceSelect.addEventListener('change', () => { remindWhoGroup.hidden = audienceSelect.value !== ''; });

      // The weekdays are toggles; the last chosen one cannot be switched off,
      // because a pool without a day would never draw.
      const dayButtons = [...panel.querySelectorAll('#task-pool-weekdays .rrule-day')];
      dayButtons.forEach((btn) => btn.addEventListener('click', () => {
        const on = btn.classList.contains('rrule-day--active');
        if (on && dayButtons.filter((b) => b.classList.contains('rrule-day--active')).length === 1) return;
        btn.classList.toggle('rrule-day--active', !on);
        btn.setAttribute('aria-pressed', String(!on));
      }));

      // Draws right away, outside the schedule: the saved state of the pool,
      // not what is currently in the form.
      const drawBtn = panel.querySelector('#task-pool-draw');
      drawBtn?.addEventListener('click', async () => {
        drawBtn.disabled = true;
        const modalContext = captureModalContext();
        try {
          const res = await api.post(`/task-pools/${pool.id}/draw`);
          const titles = (res?.data?.tasks ?? []).map((task) => task.title).join(', ');
          window.yuvomi?.showToast(t('taskPools.drawn', { titles }), 'success');
        } catch (err) {
          window.yuvomi?.showToast(errorSentence(err, 'taskPools.saveError'), 'danger');
          if (!isGone(err)) {
            drawBtn.disabled = false;
            return;
          }
        }
        closeModal({ force: true, context: modalContext });
        // After the try: once the draw has arrived it counts as drawn (#2069).
        await reloadAfterSave(onDone);
      });

      panel.querySelector('#task-pool-delete')?.addEventListener('click', async () => {
        if (!await confirmOverModal(t('taskPools.deleteConfirm', { name: pool.name }))) return;
        try {
          await api.delete(`/task-pools/${pool.id}`);
        } catch (err) {
          // Already gone counts as done.
          if (!isGone(err)) {
            window.yuvomi?.showToast(errorSentence(err, 'taskPools.saveError'), 'danger');
            return;
          }
        }
        await reloadAfterSave(onDone);
      });

      const saveBtn = panel.querySelector('#task-pool-save');
      saveBtn.addEventListener('click', async () => {
        const nameInput = panel.querySelector('#task-pool-name');
        const name = nameInput.value.trim();
        if (!name) return reportFieldError(nameInput, t('taskPools.nameRequired'));

        const assigned = panel.querySelector('#task-pool-audience').value;
        const body = {
          name,
          assigned_to: assigned === '' ? null : Number(assigned),
          draw_count: Number(panel.querySelector('#task-pool-per-day').value) || 1,
          cooldown_days: Math.max(0, Number(panel.querySelector('#task-pool-cooldown').value) || 0),
          interval_days: Math.min(365, Math.max(1, Math.round(Number(panel.querySelector('#task-pool-interval').value) || 1))),
          weekdays: dayButtons.filter((b) => b.classList.contains('rrule-day--active')).map((b) => Number(b.dataset.day)),
          category: panel.querySelector('#task-pool-category').value,
          skip_if_open: panel.querySelector('#task-pool-skip-open').checked,
          no_due_date: panel.querySelector('#task-pool-no-due').checked,
          points: Math.min(10000, Math.max(0, Math.trunc(Number(panel.querySelector('#task-pool-points').value) || 0))),
          remind_time: parseTimeInput(panel.querySelector('#task-pool-time')?.value || '') || null,
          retire_done: panel.querySelector('#task-pool-retire').checked,
          remind_scope: panel.querySelector('#task-pool-remind-who').value,
          enabled: panel.querySelector('#task-pool-enabled').checked,
        };
        const ideas = parseIdeas(panel.querySelector('#task-pool-items').value);

        const label = saveBtn.textContent;
        const modalContext = captureModalContext();
        saveBtn.disabled = true;
        saveBtn.textContent = '…';
        try {
          if (!isEdit) {
            await api.post('/task-pools', { ...body, items: ideas });
          } else {
            await api.put(`/task-pools/${pool.id}`, body);
            // The list against the state of the server: what stays keeps its
            // cooldown, only the difference goes over the wire. A line that was
            // edited is a rename of the same idea, not a delete and an add.
            const plan = planIdeaChanges(items, ideas);
            for (const { id, title } of plan.renames) await api.put(`/task-pools/${pool.id}/items/${id}`, { title });
            for (const id of plan.removals) await api.delete(`/task-pools/${pool.id}/items/${id}`);
            for (const title of plan.additions) await api.post(`/task-pools/${pool.id}/items`, { title });
          }
        } catch (err) {
          window.yuvomi?.showToast(errorSentence(err, 'taskPools.saveError'), 'danger');
          // The pool no longer exists: the dialog has nothing left to save, and
          // the manager comes back with the current state.
          if (!isGone(err)) {
            btnError(saveBtn);
            saveBtn.disabled = false;
            saveBtn.textContent = label;
            return;
          }
        }
        closeModal({ force: true, context: modalContext });
        // After the try: a failed reload is not a failed save (#2069).
        await reloadAfterSave(onDone);
      });
    },
  });
}
