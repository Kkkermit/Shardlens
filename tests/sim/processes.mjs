// The long-running processes of a run (fake Discords, bots, collectors). Output goes to a log file each, and
// whatever is still running when the run ends is stopped by PID.
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';

const running = new Set();

/** Starts `node args…`. The returned child has `closed`: a promise of its exit code (or signal). */
export function startNode(args, { log, ...options }) {
  writeFileSync(log, '', { flag: 'a' });
  const child = spawn(process.execPath, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  // Synchronous, so a log is complete as soon as its process has closed.
  child.stdout.on('data', (d) => appendFileSync(log, d));
  child.stderr.on('data', (d) => appendFileSync(log, d));
  running.add(child);
  child.closed = new Promise((resolve) =>
    child.once('close', (code, signal) => {
      running.delete(child);
      resolve(code ?? signal);
    }),
  );
  return child;
}

export function stopAll() {
  for (const child of running) child.kill('SIGKILL');
}
