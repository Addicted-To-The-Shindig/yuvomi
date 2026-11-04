/**
 * Module: Manage task pools (D#2254)
 * Purpose: The dialog behind "Idea pools" in the tools menu of the tasks page -
 *          create, change and delete pools.
 * Dependencies: /api.js, /components/modal.js, /utils/friendly-error.js
 *
 * A DIALOG AND NOT A PAGE, like the quick links: whoever sees tasks is already
 * where the pools belong, and a page for a handful of lists makes the
 * navigation more expensive than it is worth.
 *
 * THE IDEAS ARE ONE TEXT FIELD, ONE IDEA PER LINE. A pool is a loose list, and
 * keeping it that way means: paste, type, done. A save sends the whole list;
 * the server keeps the rest period of every idea that is still in it.
 */

import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { rowActionHtml } from '/utils/row-action.js';
import { formSwitchRowHtml } from '/settings/components.js';
import { errorSentence, isGone } from '/utils/friendly-error.js';
import { reloadAfterSave } from '/utils/reload-after-save.js';
import {
  openModal, closeModal, captureModalContext, captureOpenContext, isModalContextCurrent,
  confirmOverModal, reportFieldError, btnError, dialogInitialFocus,
} from '/components/modal.js';

/** The same cap as in server/routes/task-pools.js. */
const MAX_NAME = 100;

/** One idea per line; empty lines and duplicates are dropped. */
function parseIdeas(text) {
  return [...new Set(String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
}

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

/** Opens the manager. */
export async function openTaskPoolsManager() {
  const context = captureOpenContext();
  let pools = [];
  try {
    pools = (await api.get('/task-pools'))?.data ?? [];
  } catch (err) {
    window.yuvomi?.showToast(errorSentence(err), 'danger');
    return;
  }
  if (!isModalContextCurrent(context)) return;

  const reload = () => openTaskPoolsManager();

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
      panel.querySelector('#task-pool-add').addEventListener('click', () => openPoolForm(null, reload));
      panel.querySelectorAll('[data-edit]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const pool = pools.find((p) => String(p.id) === btn.dataset.edit);
          if (pool) openPoolForm(pool, reload);
        });
      });
    },
  });
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

function formHtml(pool, users) {
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
      <textarea class="form-input" id="task-pool-items" rows="6" maxlength="20000">${esc((pool?.items ?? []).map((i) => i.title).join('\n'))}</textarea>
      <p class="form-hint">${esc(t('taskPools.itemsHint'))}</p>
    </div>
    <div class="form-group">
      <label class="form-label" for="task-pool-per-day">${esc(t('taskPools.perDayLabel'))}</label>
      <input type="number" class="form-input" id="task-pool-per-day" min="1" max="5" step="1" value="${pool?.draw_count ?? 1}">
    </div>
    <div class="form-group">
      <label class="form-label" for="task-pool-cooldown">${esc(t('taskPools.cooldownLabel'))}</label>
      <input type="number" class="form-input" id="task-pool-cooldown" min="0" max="365" step="1" value="${pool?.cooldown_days ?? 30}">
    </div>
    ${formSwitchRowHtml({
    label: t('taskPools.enabledLabel'),
    checked: pool ? Boolean(pool.enabled) : true,
    attrs: { id: 'task-pool-enabled' },
  })}
    <div class="modal-panel__footer modal-panel__footer--plain">
      ${isEdit ? `<button type="button" class="btn btn--danger-outline" id="task-pool-delete">${esc(t('common.delete'))}</button>` : ''}
      <button type="button" class="btn btn--secondary" id="task-pool-cancel">${esc(t('common.cancel'))}</button>
      <button type="button" class="btn btn--primary" id="task-pool-save">${esc(isEdit ? t('common.save') : t('common.add'))}</button>
    </div>`;
}

/**
 * The form for a new or an existing pool.
 * @param {object|null} pool  null = new
 * @param {Function} onDone  after a successful save or delete
 */
async function openPoolForm(pool, onDone) {
  const isEdit = Boolean(pool);
  const context = captureOpenContext();
  let users = [];
  try {
    users = (await api.get('/tasks/meta/options'))?.users ?? [];
  } catch (err) {
    window.yuvomi?.showToast(errorSentence(err), 'danger');
    return;
  }
  if (!isModalContextCurrent(context)) return;

  openModal({
    title: isEdit ? t('taskPools.editTitle') : t('taskPools.addTitle'),
    initialFocus: dialogInitialFocus(isEdit),
    size: 'sm',
    content: formHtml(pool, users),
    onSave(panel) {
      panel.querySelector('#task-pool-cancel').addEventListener('click', () => closeModal());

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
          enabled: panel.querySelector('#task-pool-enabled').checked,
          items: parseIdeas(panel.querySelector('#task-pool-items').value),
        };

        const label = saveBtn.textContent;
        const modalContext = captureModalContext();
        saveBtn.disabled = true;
        saveBtn.textContent = '…';
        try {
          if (isEdit) await api.put(`/task-pools/${pool.id}`, body);
          else await api.post('/task-pools', body);
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
