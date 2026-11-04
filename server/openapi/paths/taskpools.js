import { op, jsonBody, idParam, withCaseReasons } from '../helpers.js';

export function taskPoolsPaths() {
  return withCaseReasons('task-pools', CASE_REASONS, {
    '/api/v1/task-pools': {
      get: op({
        summary: 'List task pools',
        tag: 'Tasks',
        description: 'Returns every pool of the household with its `items`. Each item carries '
          + '`available`: whether it could be drawn right now (not resting). '
          + '`can_edit` says whether the caller may change the pool.',
      }),
      post: op({
        summary: 'Create a task pool',
        tag: 'Tasks',
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body: { name, assigned_to?, draw_count?, cooldown_days?, enabled?, items? }. '
          + 'A pool is a list of ideas from which the server draws at random once a day and creates an '
          + 'ordinary task without a due date. `assigned_to` null (the default) makes the pool shared: the '
          + 'drawn task has no assignee. With a household member, that member gets the task. '
          + '`draw_count` is 1 to 5 per day, `cooldown_days` 0 to 365 (the days an idea rests after '
          + 'being drawn). `enabled` false pauses the pool. `items` is an array of idea titles.',
      }),
    },
    '/api/v1/task-pools/{id}': {
      put: op({
        summary: 'Update a task pool',
        tag: 'Tasks',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body: any field of the create call; what is missing stays. `items` replaces the '
          + 'whole list of ideas: ideas that are still in it keep their rest period, the others are '
          + 'removed and new titles are added. Allowed for the creator, the assigned member and administrators.',
      }),
      delete: op({
        summary: 'Delete a task pool',
        tag: 'Tasks',
        params: [idParam()],
        stateChanging: true,
        description: 'Tasks already drawn from the pool stay; they are ordinary tasks.',
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
};
