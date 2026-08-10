---
name: felix-preflight-loop
description: Grind a change against Felix locally until it is clean, BEFORE opening a PR. Use when you have finished writing a change and want to know what Felix's CI verdict will be, or when a Felix pre-flight run came back NOT VERIFIED and you are about to fix and re-run. Covers `felix preflight --loop`, which causes may be retried, and which must stop the loop dead.
---

# Felix pre-flight loop

Felix in CI is a **one-shot**: it grades the pushed head once, against criteria it pinned, under a
budget it enforces. That independence is the whole product. Reading Felix's CI verdict and pushing
a fix in response is the thing Felix is built to prevent — `required_to_pass` is derived from head
content, so a code comment in the diff becomes a prompt-injection channel into an agent holding
push credentials.

Locally that is not true. You already own the working tree, so reading your own file back is not a
privilege boundary. So the loop belongs **here, before the PR exists**: grind until clean, open the
PR once, leave CI's single shot untouched.

## The loop

```bash
felix preflight --loop --json
```

1. **Write the acceptance criteria first**, into `.felix/preflight-criteria.md`, as a markdown
   checklist under an `## Acceptance criteria` heading. These are the same criteria that go in the
   PR description. Do not start the loop without them.
2. Run the command. Read `retryable` from the JSON.
3. **`retryable: true`** → fix the **code**, run again. That is the whole loop.
4. **`retryable: false`** → stop. Report the result to the human verbatim, including
   `required_to_pass` and `loop.halted`. Do not run again, do not work around it.
5. On `VERIFIED`, check the `fingerprint` line. **Paste the criteria into the PR description
   unchanged** — CI pins a hash of what the PR body says, and if it differs from this one, CI
   grades a different spec than the one you just passed.

Exit codes, if you are branching in a shell instead of parsing JSON: `0` clean · `1` NOT VERIFIED ·
`2` INSUFFICIENT EVIDENCE · `3` Felix itself broke · `4` the loop was refused and **nothing was
graded**. Only `retryable` tells you whether to iterate; the exit code does not, because "the tests
failed" and "you have no acceptance criteria" are both `1`.

## What you may fix, and what you may never touch

**Only `criteria_unmet` and `install_failed` are retryable.** Both mean the fix is unambiguously in
the code: the tests do not pass, or the thing would not build. Iterating on those is the work.

Everything else is terminal, and two of them are the hard line:

| Cause | Why the loop stops |
|---|---|
| `no_spec` | The only way to "pass" is to **author** the rubric. |
| `spec_too_large` | The only way to "pass" is to **trim** the rubric. |
| `spec_changed` | The rubric **moved** mid-loop. See below. |
| `judge_error`, `judge_unconfigured` | Retrying re-buys the same failure. |

A verifier that grades a spec written by the thing it is grading is decorative. So, during a loop:

- **Never edit `.felix/preflight-criteria.md`.** Attempt 1 pins it; any later change halts the loop
  with `spec_changed`, including deleting the file. If the criteria genuinely need to change,
  that is a human's call — stop and say so.
- **Never edit `felix.config.json`** to widen `skipGlobs`, weaken commands, or disable a check.
- **Never move a git ref** to change what the diff is computed against.
- **Never delete the state file** named in a refusal message, and never drop `--loop` to dodge the
  counter. Both are possible. Both are visible. If you think the ceiling is genuinely wrong, say so
  and let the human raise it.

If a fix requires one of these, that is the signal to stop and hand back — not a step in the loop.

## The ceiling

`--loop` counts attempts in a durable session, five by default, keyed on the repo. It is charged on
entry, so a crashed attempt burns one. Past the ceiling Felix **refuses**: no install, no tests, no
judge, `verdict: null`, exit 4.

This is a tripwire, not a wall, and it says so in its own refusal text. Its real jobs are to stop
runaway thrash on the human's machine, and to stop an unconverged diff being rolled against a
non-deterministic judge until a green comes up. It also survives your own context being compacted
mid-loop, which is the more common way a loop loses count.

- `--max-attempts N` or `FELIX_PREFLIGHT_LOOP_MAX` moves the ceiling.
- `--reset-loop` starts a clean session — new budget, new criteria pin.
- A `VERIFIED` result ends the session automatically.

Raising the ceiling or resetting mid-task is a judgement call with a cost. **Tell the human you did
it and why**, in one line, in the same message as the result.

## The judge costs money

Tier 1 (install, build, tests, secret scan) runs every time and is free. The cross-family judge —
the step that actually grades your criteria — is **off unless you pass `--judge`**, and each call
costs real money on the pay-as-you-go key.

Most of the loop does not need it: `install_failed` and most `criteria_unmet` surface in Tier 1.
The honest pattern is **grind free, then grade**:

```bash
felix preflight --loop              # until Tier 1 is clean
felix preflight --loop --judge      # then grade the criteria
```

Without `--judge` a clean run is `INSUFFICIENT EVIDENCE / judge_unconfigured`, and pre-flight says
so in words: the checks are real, but nothing has yet checked the code against the criteria. That
is not a pass. Do not report it as one.

Felix also refuses to judge a tree byte-identical to the last graded one — re-judging buys judge
variance, not information.

## What this does not do

Pre-flight **publishes nothing**: no verdict row, no PR comment, no check run. It cannot — it
loads neither the Supabase client nor the GitHub client, and runs with those credentials absent.
CI still grades the PR independently, and a local `VERIFIED` is a prediction, not a result.

It is also a tripwire everywhere it looks like enforcement: the criteria are a file you can rewrite,
the refs are refs you can move, the counters are files you can delete. Every one of those is said
out loud rather than papered over. The real wall is CI, plus a hard vendor-side spend limit on
`OPENAI_API_KEY_PREFLIGHT`.
