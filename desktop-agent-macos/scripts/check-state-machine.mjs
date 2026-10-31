/**
 * The task state machine, checked as a table.
 *
 * This file exists because of a specific complaint: the window looked frozen.
 * The task was waiting for the user to answer a question, but it was recorded
 * as `planning` — a state that means "the app is working". Nothing was broken
 * in the sense of throwing; the model of the world was simply wrong, and every
 * part of the UI that reads the status drew the wrong conclusion from it.
 *
 * So the states a person is blocked on get their own names, and the edges in
 * and out of them are asserted here. The store is a stub: what is under test is
 * which transitions are legal, not where they are written down.
 *
 * Run with: npm run test:state
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const { TaskManager, TERMINAL } = await import(path.join(root, 'out/adapter/main/task-manager.js'));

/** The minimum a TaskManager touches, in memory. */
function createStore() {
  const tasks = new Map();
  const rounds = new Map();
  return {
    upsertTask(task) {
      tasks.set(task.taskId, { ...task });
    },
    getTask(taskId) {
      return tasks.get(taskId) ?? null;
    },
    listTasks() {
      return [...tasks.values()];
    },
    deleteTask(taskId) {
      tasks.delete(taskId);
    },
    listRounds(taskId) {
      return [...rounds.values()].filter(round => round.taskId === taskId);
    },
    insertRound(round) {
      rounds.set(round.roundId, { ...round });
    },
    updateRound(roundId, patch) {
      rounds.set(roundId, { ...rounds.get(roundId), ...patch });
    },
    getRound(roundId) {
      return rounds.get(roundId) ?? null;
    }
  };
}

function createTask(status) {
  const store = createStore();
  const events = [];
  const tasks = new TaskManager(store, event => events.push(event));
  const task = tasks.create({ prompt: '检查项目结构', permissionPreset: 'read-only', workspaceRoot: '/tmp/ws' });
  if (status && status !== 'created') {
    // Walk the legal path rather than writing the status directly, so a broken
    // table fails here instead of silently setting up an impossible state.
    const path = { planning: ['planning'], awaiting_clarification: ['planning', 'awaiting_clarification'] }[status];
    if (!path) throw new Error(`no setup path for ${status}`);
    for (const step of path) tasks.transition(task.taskId, step);
  }
  return { tasks, task, events };
}

test('a pending question is its own state, not "planning"', () => {
  const { tasks, task } = createTask('planning');
  const next = tasks.transition(task.taskId, 'awaiting_clarification');
  assert.equal(next.status, 'awaiting_clarification');
  // The distinction only matters if the two states are visibly different to the
  // rest of the app, which is why this is not folded into `planning`.
  assert.notEqual(next.status, 'planning');
});

test('answering a question returns the task to planning', () => {
  const { tasks, task } = createTask('awaiting_clarification');
  assert.equal(tasks.transition(task.taskId, 'planning').status, 'planning');
});

test('a pending question cannot be skipped', () => {
  const { tasks, task } = createTask('awaiting_clarification');
  for (const target of ['plan_ready', 'awaiting_approval', 'executing', 'verifying', 'report_pending', 'completed']) {
    assert.throws(() => tasks.transition(task.taskId, target), /非法状态转换/, `awaiting_clarification -> ${target} must be rejected`);
  }
});

test('a pending question can still be cancelled', () => {
  const { tasks, task } = createTask('awaiting_clarification');
  assert.equal(tasks.transition(task.taskId, 'cancelled').status, 'cancelled');
});

test('planning cannot jump straight to approval', () => {
  // The plan has to be stored and hashed in between; skipping that would let a
  // plan be approved without anything to approve.
  const { tasks, task } = createTask('planning');
  assert.throws(() => tasks.transition(task.taskId, 'awaiting_approval'), /非法状态转换/);
});

test('the happy path still walks end to end', () => {
  const { tasks, task } = createTask('created');
  const walk = [
    'planning',
    'plan_ready',
    'awaiting_approval',
    'executing',
    'verifying',
    'report_pending',
    'awaiting_next_round',
    'planning',
    'completed'
  ];
  for (const step of walk) tasks.transition(task.taskId, step);
  assert.equal(tasks.get(task.taskId).status, 'completed');
});

test('terminal states are final', () => {
  const setup = {
    // Each terminal state is reached the way the app actually reaches it.
    completed: ['planning', 'plan_ready', 'awaiting_approval', 'executing', 'verifying', 'report_pending', 'completed'],
    failed: ['planning', 'failed'],
    cancelled: ['cancelled']
  };
  for (const terminal of TERMINAL) {
    const { tasks, task } = createTask('created');
    for (const step of setup[terminal]) tasks.transition(task.taskId, step);
    assert.equal(tasks.get(task.taskId).status, terminal);
    for (const target of ['planning', 'completed', 'cancelled', 'awaiting_clarification']) {
      if (target === terminal) continue;
      assert.throws(() => tasks.transition(task.taskId, target), /非法状态转换/, `${terminal} -> ${target} must be rejected`);
    }
  }
});

test('every transition publishes the task, so the UI cannot miss a status change', () => {
  const { tasks, task, events } = createTask('planning');
  const before = events.length;
  tasks.transition(task.taskId, 'awaiting_clarification');
  const published = events.slice(before).filter(event => event.type === 'task.updated');
  assert.equal(published.length, 1);
  assert.equal(published[0].task.status, 'awaiting_clarification');
});
