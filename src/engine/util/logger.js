/**
 * logger.js — consistent [FELIX] console output.
 *
 * Uses a simple [TAG] prefix convention.
 * Levels are plain console methods; no external logging dependency.
 */

const PREFIX = '[FELIX]';

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

const logger = {
  info(msg, ...rest) {
    console.log(`${PREFIX} ${msg}`, ...rest);
  },
  step(n, msg) {
    console.log(`${PREFIX} (${n}) ${msg}`);
  },
  ok(msg, ...rest) {
    console.log(`${PREFIX} [OK] ${msg}`, ...rest);
  },
  warn(msg, ...rest) {
    console.log(`${PREFIX} [!!] ${msg}`, ...rest);
  },
  err(msg, ...rest) {
    console.error(`${PREFIX} [ERR] ${msg}`, ...rest);
  },
  debug(msg, ...rest) {
    if (process.env.FELIX_DEBUG === 'true') {
      console.log(`${PREFIX} [dbg ${ts()}] ${msg}`, ...rest);
    }
  },
};

module.exports = { logger };
