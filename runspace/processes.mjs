import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Every command owns a process group, including Cargo/Angular's descendants.
export class Processes {
  children = new Set();
  interrupted = false;

  constructor() {
    this.onSignal = () => {
      this.interrupted = true;
      this.stopAll();
    };
    process.on('SIGINT', this.onSignal);
    process.on('SIGTERM', this.onSignal);
  }

  start(program, args, options = {}) {
    if (this.interrupted) throw new Error('Development command interrupted.');
    const { label, ...spawnOptions } = options;
    const child = spawn(program, args, {
      stdio: label ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      ...spawnOptions,
      detached: true,
    });
    this.children.add(child);
    if (label) {
      for (const stream of [child.stdout, child.stderr]) {
        createInterface({ input: stream }).on('line', (line) => console.log(`[${label}] ${line}`));
      }
    }
    const done = new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => accept(code ?? (signal ? 130 : 1)));
    }).finally(() => this.children.delete(child));
    done.catch(() => {});
    return { child, done };
  }

  stop(child) {
    const signal = (name) => {
      try {
        process.kill(-child.pid, name);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    };
    if (!child.pid || child.stopping) return;
    child.stopping = true;
    signal('SIGTERM');
    // Keep the deadline even if the parent exits before an uncooperative descendant.
    setTimeout(() => signal('SIGKILL'), 1500);
  }

  stopAll() {
    for (const child of this.children) this.stop(child);
  }

  async run(program, args, options) {
    const code = await this.start(program, args, options).done;
    if (code !== 0) throw new Error(`${program} failed (${code}).`);
  }

  async foreground(tasks) {
    try {
      const code = await Promise.race(tasks.map((task) => task.done));
      if (code !== 0 && !this.interrupted) throw new Error(`Development process exited (${code}).`);
    } finally {
      for (const task of tasks) this.stop(task.child);
      await Promise.allSettled(tasks.map((task) => task.done));
    }
  }

  dispose() {
    this.stopAll();
    process.off('SIGINT', this.onSignal);
    process.off('SIGTERM', this.onSignal);
  }
}
