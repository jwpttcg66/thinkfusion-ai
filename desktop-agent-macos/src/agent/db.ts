import fs from 'node:fs';
import path from 'node:path';

type Row = Record<string, unknown>;
type State = { tasks: Row[]; steps: Row[]; grants: Row[] };

/** Atomic JSON journal. Deliberately avoids native SQLite addons so npm install
 * does not invoke node-gyp on Apple Silicon / Node 26. Suitable for this local MVP;
 * use a transactional database before high-volume production workloads. */
export function openDb(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let state: State = { tasks: [], steps: [], grants: [] };
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')) as State; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const persist = () => {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  return {
    insertTask(row: Row) { state.tasks.push(row); persist(); },
    insertGrant(row: Row) { state.grants.push(row); persist(); },
    insertStep(row: Row) { state.steps.push(row); persist(); },
    updateStep(id: string, patch: Row) {
      const row = state.steps.find(item => item.id === id);
      if (!row) throw new Error(`step not found: ${id}`);
      Object.assign(row, patch); persist();
    },
    updateTask(id: string, patch: Row) {
      const row = state.tasks.find(item => item.id === id);
      if (!row) throw new Error(`task not found: ${id}`);
      Object.assign(row, patch); persist();
    },
    close() { /* no open file handle */ }
  };
}
