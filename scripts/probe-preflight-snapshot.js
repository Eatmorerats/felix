#!/usr/bin/env node
/**
 * probe-preflight-snapshot.js — prove the working-tree snapshot does not disturb the working tree.
 *
 * snapshot.js builds a real commit out of whatever is currently on disk so pre-flight can check it
 * out into a worktree. The whole mechanism is only acceptable if it is genuinely invisible to the
 * user: their index, their stash, their staged-but-uncommitted work and their branch must all be
 * exactly as they left them. "Should be fine, it uses a temp index" is not evidence — this runs it
 * against a fixture repo carrying every state that could break and diffs the before and after
 * bytes.
 *
 *   node scripts/probe-preflight-snapshot.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { snapshotWorkingTree } = require('../src/engine/snapshot');

let failures = 0;
const ok = (name, detail = '') => console.log(`  ✓ PASS  ${name}${detail ? ` — ${detail}` : ''}`);
const bad = (name, detail) => { failures++; console.log(`  ✗ FAIL  ${name} — ${detail}`); };
const check = (name, cond, detail = '') => (cond ? ok(name, detail) : bad(name, detail || 'assertion false'));

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** A fixture repo carrying every state the snapshot could plausibly trample. */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'felix-snap-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'probe@felix.invalid']);
  git(dir, ['config', 'user.name', 'Probe']);

  // `tracked-then-ignored.txt` is committed FIRST and only later listed in .gitignore. Tracking
  // beats .gitignore — but only for files the index already knows, which is the one thing the
  // read-tree seed buys. Without it `add -A` skips this file and it vanishes from the snapshot.
  fs.writeFileSync(path.join(dir, '.gitignore'), 'secret.env\n');
  fs.writeFileSync(path.join(dir, 'tracked-then-ignored.txt'), 'committed before it was ignored\n');
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'v1\n');
  fs.writeFileSync(path.join(dir, 'will-stash.txt'), 'original\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'base']);

  fs.appendFileSync(path.join(dir, '.gitignore'), 'tracked-then-ignored.txt\n');
  git(dir, ['add', '.gitignore']);
  git(dir, ['commit', '-qm', 'ignore a file that is already tracked']);

  // A stash the snapshot must not touch or consume.
  fs.writeFileSync(path.join(dir, 'will-stash.txt'), 'stashed change\n');
  git(dir, ['stash', 'push', '-q', '-m', 'probe stash']);

  // The three states that matter: staged, unstaged, untracked, plus one ignored file.
  fs.writeFileSync(path.join(dir, 'staged.txt'), 'staged content\n');
  git(dir, ['add', 'staged.txt']);
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'v2 modified but not staged\n');
  fs.writeFileSync(path.join(dir, 'untracked.txt'), 'brand new file\n');
  fs.writeFileSync(path.join(dir, 'secret.env'), 'API_KEY=hunter2\n');
  return dir;
}

const capture = (dir) => ({
  status: git(dir, ['status', '--porcelain=v2', '--branch', '--untracked-files=all']),
  stash: git(dir, ['stash', 'list']),
  head: git(dir, ['rev-parse', 'HEAD']),
  branch: git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
  indexHash: sha256(fs.readFileSync(path.join(dir, '.git', 'index'))),
  tracked: fs.readFileSync(path.join(dir, 'tracked.txt'), 'utf8'),
});

(async () => {
  console.log('\nprobe-preflight-snapshot — does snapshotting disturb the working tree?\n');
  const dir = makeRepo();
  let dir2;

  try {
    const before = capture(dir);
    const snap = await snapshotWorkingTree({ repoPath: dir });
    const after = capture(dir);

    console.log('[1] the user\'s repository state is untouched');
    check('git status is byte-identical', before.status === after.status);
    check('the stash is intact', before.stash === after.stash && after.stash.includes('probe stash'));
    check('HEAD has not moved', before.head === after.head, before.head.slice(0, 8));
    check('still on the same branch', before.branch === after.branch, after.branch);
    check('.git/index is byte-identical', before.indexHash === after.indexHash);
    check('no ref was created for the snapshot', !git(dir, ['for-each-ref', '--format=%(refname)']).includes(snap.sha));

    console.log('\n[2] the snapshot contains the right files');
    const inTree = git(dir, ['ls-tree', '-r', '--name-only', snap.sha]).split('\n');
    check('the unstaged modification is included', git(dir, ['show', `${snap.sha}:tracked.txt`]) === 'v2 modified but not staged');
    check('the staged file is included', inTree.includes('staged.txt'));
    check('the UNTRACKED file is included', inTree.includes('untracked.txt'));
    check('the GITIGNORED file is EXCLUDED', !inTree.includes('secret.env'),
      'a local green must not come from an uncommitted secret, and it must never be blobbed into .git');
    check('a TRACKED file that is also gitignored survives', inTree.includes('tracked-then-ignored.txt'),
      'tracking beats .gitignore only for files the index knows — this is what read-tree buys');
    check('untracked files are reported to the caller', snap.untracked.includes('untracked.txt'),
      `reported: ${snap.untracked.join(', ')}`);
    check('the tree is marked dirty', snap.dirty === true);

    // A leftover CI worktree inside the repo must never be folded in. It is only gitignored in
    // Felix's OWN repo, and without the explicit drop the next snapshot swallows a whole second
    // copy of the repository — which also means no two snapshots are ever byte-identical.
    fs.mkdirSync(path.join(dir, '.felix-worktrees', 'pr-1-abcdef12'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.felix-worktrees', 'pr-1-abcdef12', 'leftover.txt'), 'a previous run\n');
    const withLeftover = await snapshotWorkingTree({ repoPath: dir });
    check('a leftover .felix-worktrees is EXCLUDED even when not gitignored',
      !git(dir, ['ls-tree', '-r', '--name-only', withLeftover.sha]).includes('.felix-worktrees'));
    check('and it does not change the tree', withLeftover.tree === snap.tree,
      'otherwise the unchanged-tree rule can never fire in an adopter repo');
    fs.rmSync(path.join(dir, '.felix-worktrees'), { recursive: true, force: true });

    // A deletion on disk must reach the tree, or pre-flight grades a file the author removed.
    fs.unlinkSync(path.join(dir, 'staged.txt'));
    const deleted = await snapshotWorkingTree({ repoPath: dir });
    check('a file deleted in the working tree is absent from the snapshot',
      !git(dir, ['ls-tree', '-r', '--name-only', deleted.sha]).split('\n').includes('staged.txt'));
    fs.writeFileSync(path.join(dir, 'staged.txt'), 'staged content\n');
    git(dir, ['add', 'staged.txt']);

    console.log('\n[3] the snapshot SHA is deterministic');
    const again = await snapshotWorkingTree({ repoPath: dir });
    check('an unchanged tree snapshots to the same sha', snap.sha === again.sha, snap.sha.slice(0, 12));
    check('the same repo from a SUBDIRECTORY gives the same sha', await (async () => {
      const sub = path.join(dir, 'sub');
      fs.mkdirSync(sub, { recursive: true });
      // A new dir with no files in it is invisible to git, so this really is the same tree.
      const s = await snapshotWorkingTree({ repoPath: sub });
      return s.sha === snap.sha;
    })(), 'add -A is scoped to the cwd, so this would silently grade a subset');

    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'v3\n');
    const changed = await snapshotWorkingTree({ repoPath: dir });
    check('a changed tree snapshots to a DIFFERENT sha', changed.sha !== snap.sha);

    console.log('\n[4] the dangling commit survives an aggressive gc');
    // The worktree's HEAD is a reachability root once `worktree add` succeeds, so the commit
    // cannot be pruned mid-run. Asserted live rather than trusted: git internals are exactly the
    // kind of thing that is remembered slightly wrong.
    const { createLocalSandbox } = require('../src/engine/sandbox');
    const sandbox = await createLocalSandbox({ repoPath: dir, sha: snap.sha });
    try {
      execFileSync('git', ['gc', '--prune=now', '--quiet'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
      check('the snapshot commit still resolves after gc --prune=now',
        git(dir, ['cat-file', '-t', snap.sha]) === 'commit');
      check('the checked-out worktree still has the untracked file',
        fs.existsSync(path.join(sandbox.dir, 'untracked.txt')));
    } finally {
      await sandbox.teardown();
    }

    console.log('\n[5] an unborn HEAD is refused in words, not plumbing noise');
    dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'felix-snap-empty-'));
    git(dir2, ['init', '-q', '-b', 'main']);
    let msg = '';
    try { await snapshotWorkingTree({ repoPath: dir2 }); } catch (e) { msg = e.message; }
    check('an empty repo errors with a human sentence', /no commits yet/i.test(msg), msg || '(no error thrown)');
  } finally {
    for (const d of [dir, dir2]) {
      if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* windows file locks */ } }
    }
  }

  console.log(failures === 0
    ? '\nprobe-preflight-snapshot: OK — the snapshot is invisible to the working tree.\n'
    : `\nprobe-preflight-snapshot: ${failures} FAILURE(S).\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(`probe failed: ${e.stack || e.message}`); process.exit(1); });
