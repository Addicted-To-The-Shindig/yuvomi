import { op, jsonBody, idParam, withCaseReasons } from '../helpers.js';

export function taskPoolsPaths() {
  return withCaseReasons('task-pools', CASE_REASONS, {
    '/api/v1/task-pools': {
      get: op({
        summary: 'List task pools',
        tag: 'Tasks',
        description: 'Returns every pool of the household with its `items`. Each item carries '
          + '`available`: whether it could be drawn right now (not resting, no open task). '
          + '`can_edit` says whether the caller may change the pool.',
      }),
      post: op({
        summary: 'Create a task pool',
        tag: 'Tasks',
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body: { name, assigned_to?, draw_count?, cooldown_days?, interval_days?, weekdays?, category?, points?, remind_time?, remind_scope?, retire_done?, skip_if_open?, no_due_date?, enabled?, items? }. '
          + 'A pool is a list of ideas from which the server draws at random once a day and creates an '
          + 'ordinary task due today. `assigned_to` null (the default) makes the pool shared: the drawn '
          + 'task has no assignee. With a household member, that member gets the task. `draw_count` is '
          + '1 to 5 per day, `cooldown_days` 0 to 365 (the days an idea rests after being drawn), '
          + '`interval_days` (1 to 365, default 1) is the number of days between draws, counted from '
          + 'the last draw; `weekdays` lists the days a draw may happen, 1 (Monday) to 7 (Sunday), '
          + 'default all seven. `points` (0 to 10000) is the point value of each drawn task. '
          + '`remind_time` (HH:MM, household time, or null) sets the due time of the drawn task and '
          + 'creates a reminder at that time, for the assigned member. For a shared pool `remind_scope` '
          + 'decides: `all` (default) reminds every household member, `creator` only the member who '
          + 'created the pool (everyone, if that member is gone). `retire_done` true removes an idea from the pool once its task is done; '
          + 'otherwise it returns after `cooldown_days`. `enabled` false pauses the pool. '
          + '`category` is a key of the task categories (default `misc`) for the drawn task. '
          + '`skip_if_open` true keeps the scheduled run from drawing while a task from this pool is '
          + 'still open, so ignored ideas do not pile up; the manual draw ignores it. `no_due_date` true '
          + 'draws tasks without a due date (the time then only sets the reminder). '
          + '`items` is an array of idea titles.',
      }),
    },
    '/api/v1/task-pools/{id}': {
      put: op({
        summary: 'Update a task pool',
        tag: 'Tasks',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body: any field of the create call except `items`; what is missing stays. '
          + 'Allowed for the creator, the assigned member and administrators.',
      }),
      delete: op({
        summary: 'Delete a task pool',
        tag: 'Tasks',
        params: [idParam()],
        stateChanging: true,
        description: 'Tasks already drawn from the pool stay; they are ordinary tasks.',
      }),
    },
    '/api/v1/task-pools/{id}/items': {
      post: op({
        summary: 'Add an idea to a task pool',
        tag: 'Tasks',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body: { title }. Returns the pool.',
      }),
    },
    '/api/v1/task-pools/{id}/items/{itemId}': {
      put: op({
        summary: 'Rename an idea of a task pool',
        tag: 'Tasks',
        params: [idParam(), idParam('itemId', 'Idea ID')],
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body: { title }. The idea stays the same one: its cooldown and the link to the '
          + 'task of its last draw are kept, so a corrected typo does not make it drawable again while '
          + 'its task is still open. Returns the pool.',
      }),
      delete: op({
        summary: 'Remove an idea from a task pool',
        tag: 'Tasks',
        params: [idParam(), idParam('itemId', 'Idea ID')],
        stateChanging: true,
        description: 'Returns the pool.',
      }),
    },
    '/api/v1/task-pools/{id}/draw': {
      post: op({
        summary: 'Draw from a task pool now',
        tag: 'Tasks',
        params: [idParam()],
        stateChanging: true,
        description: 'Draws outside the schedule and counts as the pool\'s draw of the day. '
          + 'Returns `{ tasks, pool }`.',
      }),
    },
  });
}

const POOL_GONE = '`task_pools_pool_not_found` (404, the pool was deleted)';
const CASE_REASONS = {
  '/api/v1/task-pools': {
    post: '`task_pools_limit_reached` (400, the household has the maximum number of pools; `params.limit` names it)',
  },
  '/api/v1/task-pools/{id}': { put: POOL_GONE, delete: POOL_GONE },
  '/api/v1/task-pools/{id}/items': {
    post: `${POOL_GONE}; \`task_pools_items_limit_reached\` (400, the pool is full; \`params.limit\` names it)`,
  },
  '/api/v1/task-pools/{id}/items/{itemId}': { put: POOL_GONE, delete: POOL_GONE },
  '/api/v1/task-pools/{id}/draw': {
    post: `${POOL_GONE}; \`task_pools_nothing_to_draw\` (409, every idea is resting or still open as a task)`,
  },
};
