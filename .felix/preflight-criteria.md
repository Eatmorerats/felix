# Local pre-flight mode

The criteria Felix grades this working tree against, before the PR exists. Copy this section into
the PR description when you open it — pre-flight prints the fingerprint so you can confirm the two
match, and CI will pin whatever the PR body says.

## Acceptance criteria

- [ ] `felix preflight` verifies the current working tree, including uncommitted and untracked
      changes, without creating a commit, moving a ref, or modifying the user's index or stash.
- [ ] Running pre-flight with `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `GITHUB_TOKEN` all
      unset completes normally and produces a verdict.
- [ ] The `preflight` module's transitive require closure contains neither `log.js` nor
      `github.js`, so no local run can write a `felix_verdicts` row or call the GitHub API.
- [ ] `runPreflight()` returns `retryable: true` only for the causes `criteria_unmet` and
      `install_failed`; `no_spec` and `spec_too_large` return `retryable: false`.
- [ ] Snapshotting the same unchanged working tree twice produces the same commit SHA, and
      pre-flight refuses to call the judge a second time on an unchanged tree.
- [ ] The cross-family judge is not called unless `--judge` is passed.
- [ ] Local and CI triage share one implementation, so a locally SKIPPED change is one CI skips too.
