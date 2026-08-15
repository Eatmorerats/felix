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

/**
 * Read the prior-run state one PR's freeze and attempt cap depend on.
 *
 * THIS READ IS NOT BEST-EFFORT THE WAY logVerdict IS, and the difference is the whole reason
 * it lives in its own function. `logVerdict` may fail silently because a lost log costs a row
 * of history. A lost READ costs the security property: if Felix cannot tell what criteria it
 * pinned or how many times it has already graded this PR, then "the spec did not change" and
 * "this PR has attempts left" are both unproven, and returning them as true would be a
 * fail-open on the two controls that exist precisely because the author can edit the rubric
 * and the judge is stochastic.
 *
 * So this reports `available` separately from its data, and never conflates "the store says
 * there are no prior runs" (available: true, nothing pinned — a legitimate first run) with
 * "the store did not answer" (available: false). index.js decides what to do with the
 * difference: advisory mode warns and proceeds, gating mode refuses. That call belongs to the
 * caller because only it knows whether a verdict here can block a merge.
 *
 * @returns {{available:boolean, baselineFingerprint:string|null, judgeAttempts:number, reason:string|null}}
 */
async function fetchPriorRuns({ repo, prNumber }, env = process.env) {
  const unavailable = (reason) => ({ available: false, baselineFingerprint: null, judgeAttempts: 0, reason });
  const supabase = client(env);
  if (!supabase) return unavailable('Supabase is not configured');
  try {
    const { data, error } = await supabase
      .from('felix_verdicts')
      .select('spec_fingerprint, judge_attempted, created_at')
      .eq('repo', repo)
      .eq('pr_number', prNumber)
      .order('created_at', { ascending: true });
    if (error) {
      logger.warn(`fetchPriorRuns failed: ${error.message}`);
      return unavailable(error.message);
    }
    const rows = data || [];
    // EARLIEST non-null wins. The baseline is the criteria set of the first run that actually
    // graded something; later rows carry later fingerprints, and taking one of those would let
    // a drifted spec re-pin itself simply by being logged.
    const first = rows.find((r) => r && r.spec_fingerprint);
    return {
      available: true,
      baselineFingerprint: first ? first.spec_fingerprint : null,
      // Counts ATTEMPTS, not runs: a run that skipped the judge (triage, no spec, fork) costs
      // no roll of the dice and must not consume budget.
      judgeAttempts: rows.filter((r) => r && r.judge_attempted).length,
      reason: null,
    };
  } catch (e) {
    logger.warn(`fetchPriorRuns error: ${e.message}`);
    return unavailable(e.message);
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

module.exports = { logVerdict, recordOutcome, fetchVerdicts, fetchPriorRuns };
