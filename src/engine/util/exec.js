/**
 * exec.js — run a shell command with a hard timeout and captured output.
 *
 * Felix runs *untrusted PR build/test scripts*, so every spawn is bounded by
 * a timeout and killed (process group) if it overruns. Output is captured and
 * truncated to keep memory + downstream token budgets sane.
 */

const { spawn } = require('child_process');

const MAX_CAPTURE = 200 * 1024; // 200 KB per stream, then truncate

/**
 * Run `command` (a shell string) in `cwd`.
 *
 * @returns {Promise<{code:number|null, signal:string|null, stdout:string,
 *   stderr:string, combined:string, timedOut:boolean, durationMs:number}>}
 */
function run(command, { cwd = process.cwd(), env = process.env, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      // New process group so a timeout kill takes child processes with it.
      detached: process.platform !== 'win32',
    });

    const cap = (buf, isErr) => {
      const s = buf.toString();
      if (isErr) {
        if (stderr.length < MAX_CAPTURE) stderr += s;
      } else if (stdout.length < MAX_CAPTURE) {
        stdout += s;
      }
    };

    child.stdout.on('data', (d) => cap(d, false));
    child.stderr.on('data', (d) => cap(d, true));

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== 'win32' && child.pid) {
          process.kill(-child.pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch (_) {
        /* already gone */
      }
    }, timeoutMs);

    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const combined = (stdout + (stderr ? `\n${stderr}` : '')).trim();
      resolve({
        code,
        signal,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        combined,
        timedOut,
        durationMs: Date.now() - started,
      });
    };

    child.on('error', (e) => {
      stderr += `\n${e.message}`;
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

/** Last N chars of a string, with a leading marker if truncated. */
function tail(str, n = 4000) {
  if (!str) return '';
  if (str.length <= n) return str;
  return `…(truncated ${str.length - n} chars)…\n${str.slice(-n)}`;
}

module.exports = { run, tail, MAX_CAPTURE };
