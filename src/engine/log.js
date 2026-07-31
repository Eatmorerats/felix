/**
 * log.js — best-effort write of one felix_verdicts row to Supabase.
 *
 * Per .env.example: if Supabase env is missing, Felix WARNS and CONTINUES.
 * Logging must never block a verdict.
 */

const { logger } = require('./util/logger');
const { getSupabaseCreateClient } = require('./preload');

/** Build a Supabase client, or null (with a warning) if the env isn't configured. */
function client(env = process.env) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    logger.warn('Supabase not configured — set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to log/read verdicts.');
    return null;
  }
  // Preloaded at startup, never require()d here: this function runs from finalize(),
  // i.e. AFTER untrusted PR code has executed, and a first-time load at that point can
  // be hijacked by a planted module running in-process with this very key (F5).
  const createClient = getSupabaseCreateClient();
  if (!createClient) {
    logger.warn('@supabase/supabase-js is not installed — skipping the verdict log.');
    return null;
  }
  return createClient(url, key);
}

async function logVerdict(row, env = process.env) {
  const supabase = client(env);
  if (!supabase) return { logged: false };  // logging must never block a verdict
  try {
    const { error } = await supabase.from('felix_verdicts').insert(row);
    if (error) {
      logger.warn(`verdict log failed: ${error.message}`);
      return { logged: false };
    }
    logger.debug('verdict logged to Supabase');
    return { logged: true };
  } catch (e) {
    logger.warn(`verdict log error: ${e.message}`);
    return { logged: false };
  }
}

/** Record the post-merge outcome (clean | defect) on a PR's verdict rows. */
async function recordOutcome({ repo, prNumber, outcome }, env = process.env) {
  const supabase = client(env);
  if (!supabase) return { updated: 0 };
  try {
    const { data, error } = await supabase
      .from('felix_verdicts')
      .update({ outcome, outcome_recorded_at: new Date().toISOString() })
      .eq('repo', repo)
      .eq('pr_number', prNumber)
      .select('id');
    if (error) { logger.warn(`recordOutcome failed: ${error.message}`); return { updated: 0 }; }
    return { updated: (data || []).length };
  } catch (e) {
    logger.warn(`recordOutcome error: ${e.message}`);
    return { updated: 0 };
  }
}

/** Fetch verdict + outcome rows (optionally for one repo) for calibration. */
async function fetchVerdicts({ repo } = {}, env = process.env) {
  const supabase = client(env);
  if (!supabase) return [];
  // PostgREST caps a select at ~1000 rows; paginate with a stable order so the
  // metrics aren't silently truncated or ordering-dependent.
  const PAGE = 1000;
  const all = [];
  try {
    for (let from = 0; ; from += PAGE) {
      let q = supabase
        .from('felix_verdicts')
        .select('verdict, outcome, pr_number, created_at')
        .order('created_at', { ascending: true })
        .range(from, from + PAGE - 1);
      if (repo) q = q.eq('repo', repo);
      const { data, error } = await q;
      if (error) { logger.warn(`fetchVerdicts failed: ${error.message}`); break; }
      if (!data || data.length === 0) break;
      all.push(...data);
      if (data.length < PAGE) break;
    }
    return all;
  } catch (e) {
    logger.warn(`fetchVerdicts error: ${e.message}`);
    return all;
  }
}

module.exports = { logVerdict, recordOutcome, fetchVerdicts };
