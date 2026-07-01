export const meta = {
  name: 'test-skill',
  description: 'Fresh-eyes test of the /kb skill. Spins up isolated scratch KB, has fresh agents exercise init/add/edit/search + the auto-trigger hook the way a user would, adversarially verifies the outcomes against the scratch repo, and reports pass/fail plus doc-followability friction. Safe: never touches the real KB or its remote.',
  phases: [
    { title: 'Setup', detail: 'mktemp an isolated scratch KB + config, seed known entries, build index' },
    { title: 'Exercise', detail: 'One fresh writer + one fresh reader perform user tasks by following the skill docs' },
    { title: 'Verify', detail: 'One adversarial pass confirms every outcome against the scratch repo' },
    { title: 'Teardown', detail: 'Remove all scratch dirs' },
  ],
}

// ─── Schemas ───────────────────────────────────────────────────────────────

const SETUP_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    skillDir: { type: 'string', description: 'Absolute path to the git-kb skill root (contains SKILL.md, scripts/, references/)' },
    scriptsDir: { type: 'string', description: 'Absolute path to the scripts/ dir' },
    dataDir: { type: 'string', description: 'Absolute path to the scratch kb-data repo' },
    cfgDir: { type: 'string', description: 'Absolute path to the scratch CLAUDE_PLUGIN_DATA dir (holds kb-config.json)' },
    seededIds: { type: 'array', items: { type: 'string' }, description: 'kb-NNNN ids seeded into the scratch repo' },
    notes: { type: 'string', description: 'Anything that went wrong or was ambiguous during setup' },
  },
  required: ['ok', 'skillDir', 'scriptsDir', 'dataDir', 'cfgDir', 'seededIds', 'notes'],
}

// One agent runs several tests; it returns one entry per test id.
const PER_TEST_RESULT = {
  type: 'object',
  properties: {
    testId: { type: 'string' },
    scriptOutput: { type: 'string', description: 'ONLY the single decisive line the script printed (the SAVED/EDITED/push line, the top search hit id, or the trigger verdict). Not full output.' },
    claimedOutcome: { type: 'string', description: 'What happened for this test, in one sentence.' },
  },
  required: ['testId', 'scriptOutput', 'claimedOutcome'],
}

const EXERCISE_SCHEMA = {
  type: 'object',
  properties: {
    results: { type: 'array', items: PER_TEST_RESULT },
    friction: {
      type: 'array',
      items: { type: 'string' },
      description: 'Fresh-eyes friction across ALL tasks: anything ambiguous, missing, or that forced a guess while following the docs. Prefix each note with the testId it relates to (or "general").',
    },
  },
  required: ['results', 'friction'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          testId: { type: 'string' },
          pass: { type: 'boolean' },
          evidence: { type: 'string', description: 'One line of concrete proof from the repo (the git log line, the changed field, or the trigger verdict). Keep it to a sentence.' },
          reason: { type: 'string', description: 'If failed, the one-line discrepancy. Empty if passed.' },
        },
        required: ['testId', 'pass', 'evidence', 'reason'],
      },
    },
  },
  required: ['verdicts'],
}

// ─── Test definitions ────────────────────────────────────────────────────────

// Mutating tests — one writer agent runs them IN ORDER. They share one git repo,
// so they must be sequential (concurrent kb-save.js would collide on index.lock).
const WRITE_TESTS = [
  {
    id: 'add-decision',
    task: 'Capture this decision into the KB: "We decided to standardize on OpenTelemetry for distributed tracing because it avoids vendor lock-in and is supported across our stack."',
    expect: 'A new entry with type `decision` is created, committed (git log shows `add kb-NNNN: ...`), and the script printed SAVED. The body reflects the OpenTelemetry rationale.',
  },
  {
    id: 'add-bookmark',
    task: 'Save this bookmark into the KB: the URL https://runbooks.example.com/oncall — it is our on-call runbook.',
    expect: 'A new entry with type `bookmark` and a `url:` frontmatter field equal to https://runbooks.example.com/oncall is created and committed. The script printed SAVED.',
  },
  {
    id: 'edit-factual',
    task: 'The seeded entry about the API rate limit is out of date. Update it: the rate limit is now 200 requests per minute (was 100).',
    expect: 'The existing rate-limit entry (kb-0003) is edited in place (same id, no new id assigned), its body now says 200, `updated:` is bumped, and git log shows an `edit kb-NNNN: ...` commit. The script printed EDITED.',
  },
]

// Read-only tests — one reader agent runs all of them. Safe against the repo.
const READ_TESTS = [
  {
    id: 'search-keyword',
    task: 'The user asks: "what did we decide about the analytics database?" Search the KB for relevant entries and answer.',
    expect: 'kb-search.js returns the seeded PostgreSQL/analytics decision entry (kb-0001) as a top hit (matched on title/tags). The agent answers from the returned body without re-reading files.',
  },
  {
    id: 'search-type-filter',
    task: 'The user asks: "list all my bookmarks." Use the skill to list only bookmark-type entries.',
    expect: 'The agent runs kb-search.js with `--type bookmark "*"` and gets back only bookmark entries (at minimum the seeded deploy-dashboard bookmark kb-0002). No non-bookmark entries appear.',
  },
  {
    id: 'trigger-positive',
    task: 'Test the auto-trigger hook with a natural-language prompt that SHOULD match seeded content. Feed kb-trigger.js this prompt via stdin JSON: {"prompt":"How should we scale the analytics database running on postgres?"} and report what it emits.',
    expect: 'kb-trigger.js emits JSON on stdout containing hookSpecificOutput.additionalContext, because the prompt hits >= 2 seeded index keywords (analytics, database, postgres). The injected context includes the seeded PostgreSQL decision entry.',
  },
  {
    id: 'trigger-negative',
    task: 'Test the auto-trigger hook with a prompt that should NOT trigger. Feed kb-trigger.js this prompt via stdin JSON: {"prompt":"git status"} and report what it emits.',
    expect: 'kb-trigger.js emits NOTHING on stdout (exits 0, no context injected) — "git status" matches a skip pattern and is below the keyword threshold.',
  },
  {
    id: 'cache-dedup',
    task: `Verify the auto-trigger hook's per-session caching: it must NOT re-inject entries already injected earlier in the same session, but MUST resurface them if the KB changes. Run this exact sequence in ONE shell:
  1. Pick a session id unique to this run: SID="kbtest-$(date +%s)-$$"
  2. Define a fire helper (substitute the real cfg + scripts paths for this harness):
       fire() { echo '{"session_id":"'"$SID"'","prompt":"How should we scale the analytics database on postgres?"}' | CLAUDE_PLUGIN_DATA=<cfgDir> node <scriptsDir>/kb-trigger.js; echo "---END---"; }
  3. FIRE #1: run fire
  4. FIRE #2: run fire again (SAME session id, SAME prompt)
  5. Simulate an add/edit by bumping the index mtime: touch <dataDir>/kb-index.json
  6. FIRE #3: run fire again
  Report the stdout of all three fires (delimited by ---END---).`,
    expect: 'Fire #1 emits JSON with hookSpecificOutput.additionalContext (the seeded postgres entry kb-0001). Fire #2 emits NOTHING between its delimiters — those entries were already injected this session (dedup by entry id via the per-session ledger). Fire #3 emits JSON again — touching kb-index.json changed its mtime, invalidating the session ledger so previously-seen entries resurface.',
  },
]

// ─── Prompt builders ─────────────────────────────────────────────────────────

const harnessPreamble = (env) => `
You are a FRESH user of the \`/kb\` skill — you have no memory of how it was built.
Learn it only from its docs, then use it to accomplish the tasks below.

Test-harness environment (this is NOT the real KB — it is a disposable scratch copy):
- Skill root:  ${env.skillDir}
- Scripts dir: ${env.scriptsDir}
- Scratch config (CLAUDE_PLUGIN_DATA): ${env.cfgDir}
- Scratch data repo: ${env.dataDir}
- Seeded entries already present: ${env.seededIds.join(', ')}

How to run the skill in this harness:
1. Read ${env.skillDir}/SKILL.md ONCE up front. Follow whatever it says. If it points
   you to a file under references/, read that too — that is part of the test (does the
   doc send you to the right place?). Read the docs once, then reuse that knowledge
   across all your tasks; do not re-read on every task.
2. The docs reference \`\${CLAUDE_SKILL_DIR}/scripts\`. In this harness, substitute the
   literal path ${env.scriptsDir} for that.
3. The skill resolves its data repo from CLAUDE_PLUGIN_DATA. So prefix EVERY command
   that runs a kb script with \`CLAUDE_PLUGIN_DATA=${env.cfgDir}\` in the same shell
   invocation, e.g.:
     CLAUDE_PLUGIN_DATA=${env.cfgDir} node ${env.scriptsDir}/kb-search.js "term"
4. Do exactly what a careful user following the docs would do — no more. If the docs
   are ambiguous and you have to guess, DO make the guess, but record it as friction.

Report honestly, including every point where the docs were unclear, sent you to the
wrong place, or made you guess. That friction is the primary output of this test.
Collect friction across all tasks into the single \`friction\` list; prefix each note
with the testId it relates to (or "general").

EFFICIENCY: You are a test harness, not a writer. Do the minimum tool calls each task
needs and stop. Do NOT narrate your reasoning, summarize what you are about to do, or
recap what you did — the structured fields ARE your entire report. No preamble, no
running commentary between tool calls. Keep every friction note to one sentence.
`.trim()

const taskBlock = (tests) =>
  tests.map((t, i) => `${i + 1}. [${t.id}] ${t.task}`).join('\n\n')

const writerPrompt = (env) => `${harnessPreamble(env)}

## Your tasks (do them IN THIS ORDER — they share one git repo, so never run two
## save operations at once)
${taskBlock(WRITE_TESTS)}

For each task, follow the skill's documented write flow end to end (draft the entry
per the spec, run the save helper, interpret its output). Return one \`results\` entry
per task (testId, the script output you saw, and what you believe happened), plus the
combined \`friction\` list.`

const readerPrompt = (env) => `${harnessPreamble(env)}

## Your tasks (independent; order doesn't matter)
${taskBlock(READ_TESTS)}

For each task, follow the skill's documented flow. Return one \`results\` entry per
task (testId, the script output you saw, and what you believe happened), plus the
combined \`friction\` list.`

const verifyPrompt = (env, tests, claims) => `
You are an adversarial verifier. Do NOT trust the test agents' self-reports — confirm
the truth by inspecting the scratch KB directly. You verify ALL tests in one pass by
examining the final state of the repo.

Scratch data repo: ${env.dataDir}  (git repo; entries in entries/, manifest kb.json, index kb-index.json)
Scripts dir: ${env.scriptsDir}
Scratch config: ${env.cfgDir}  (set CLAUDE_PLUGIN_DATA=${env.cfgDir} to run any kb script)
Seeded entries: ${env.seededIds.join(', ')}

## Start by capturing the final state once, then reason about each test against it:
- git -C ${env.dataDir} log --oneline
- ls ${env.dataDir}/entries/
- cat any entry file that a test touched
- CLAUDE_PLUGIN_DATA=${env.cfgDir} node ${env.scriptsDir}/kb-search.js "<term>"   (for the search tests)
- echo '<the json>' | CLAUDE_PLUGIN_DATA=${env.cfgDir} node ${env.scriptsDir}/kb-trigger.js   (for the trigger tests)
- For cache-dedup: do NOT trust the agent's pasted output. Re-run the 3-fire sequence
  yourself with a FRESH session id (e.g. SID="verify-$(date +%s)-$$"): fire once, fire
  again with the same id+prompt, then \`touch ${env.dataDir}/kb-index.json\`, then fire a
  third time. Confirm fire #1 emits additionalContext, fire #2 emits nothing, fire #3
  emits additionalContext again.

## Tests to verify (with each test's expected outcome and what the agent claimed):
${tests.map((t) => {
  const c = claims[t.id]
  return `### ${t.id}
Expected: ${t.expect}
Agent claimed: ${c ? c.claimedOutcome : '(no claim returned — treat as fail unless the repo state proves it happened anyway)'}`
}).join('\n\n')}

Return one verdict per testId. Decide pass/fail based on what the repo ACTUALLY
contains, not what was claimed. Cite concrete evidence (the git log line, file
contents, exact script output) in each verdict.

EFFICIENCY: Run the checks, fill the verdicts, stop. Do NOT narrate your inspection
or explain your reasoning outside the structured fields. One line of evidence per
verdict — the decisive fact, not a transcript.`

// ─── Orchestration ───────────────────────────────────────────────────────────

phase('Setup')
log('Creating an isolated scratch KB (your real KB is never touched)...')

const setupPrompt = `
Set up an ISOLATED, disposable scratch copy of the git-kb skill's data repo for a test
run. Touch nothing outside the temp dirs you create. Steps:

1. Locate the git-kb skill root: the directory that contains BOTH \`SKILL.md\` and
   \`scripts/kb-save.js\`. It is likely under ~/.claude/skills/git-kb or a sibling path.
   Find it robustly, e.g.:
     find ~/.claude /local -maxdepth 6 -name kb-save.js -path '*git-kb*' 2>/dev/null
   Resolve its absolute skill root (parent of scripts/) and the absolute scripts/ dir.

2. Create two temp dirs with mktemp -d:
     DATA=$(mktemp -d)   # the scratch kb-data repo
     CFG=$(mktemp -d)    # stands in for CLAUDE_PLUGIN_DATA

3. Initialize the scratch data repo as a FRESH kb-data repo (no remote — so pushes
   safely resolve to NO_REMOTE and never leave the machine):
     git -C "$DATA" init
     git -C "$DATA" config user.email test@example.com
     git -C "$DATA" config user.name "kb test"
     mkdir "$DATA/entries"
     echo '{"schema_version": 1, "next_id": 4}' > "$DATA/kb.json"

4. Seed three known entries as files in "$DATA/entries" (use these EXACT ids and
   frontmatter so downstream tests are deterministic). Each file needs the standard
   frontmatter (id, title, type, tags, created, updated) then a body. Use created/
   updated = 2026-01-01.
   - entries/kb-0001-postgres-analytics.md — type: decision,
     title: "Adopt PostgreSQL for the analytics pipeline",
     tags: [database, analytics, postgres],
     body: a sentence explaining the choice.
   - entries/kb-0002-deploy-dashboard.md — type: bookmark,
     title: "Internal deploy dashboard", url: https://deploy.example.com,
     tags: [dashboard, deploy], body: short note.
   - entries/kb-0003-rate-limit.md — type: factual_reference,
     title: "API rate limit", tags: [api, rate-limit],
     body: "The rate limit is 100 requests per minute."

5. Write the scratch config so the scripts resolve the scratch repo:
     echo '{"data_dir": "'"$DATA"'"}' > "$CFG/kb-config.json"

6. Build the index against the scratch repo:
     CLAUDE_PLUGIN_DATA="$CFG" node <scriptsDir>/kb-build-index.js
   Confirm it prints INDEX_BUILT and that "$DATA/kb-index.json" now exists.

7. Commit the seed so git log has a clean baseline:
     git -C "$DATA" add -A && git -C "$DATA" commit -m "seed test fixtures"

Return the absolute paths (skillDir, scriptsDir, dataDir, cfgDir), the seeded ids
[kb-0001, kb-0002, kb-0003], ok=true if all steps succeeded, and notes on anything
that failed or surprised you.`

const env = await agent(setupPrompt, { label: 'setup:scratch-kb', phase: 'Setup', schema: SETUP_SCHEMA, model: 'sonnet', effort: 'low' })

if (!env || !env.ok) {
  log('Setup failed — aborting before any tests ran.')
  return {
    status: 'setup_failed',
    setupNotes: env ? env.notes : '(setup agent returned nothing)',
  }
}

log(`Scratch KB at ${env.dataDir} (seeded ${env.seededIds.join(', ')}). Config at ${env.cfgDir}.`)

let report
try {
  // ── Exercise ──────────────────────────────────────────────────────────────
  // Two fresh agents. Writer runs first and completes all mutations (serial,
  // shared repo); reader runs concurrently since reads don't touch the repo.
  phase('Exercise')
  log('One fresh writer (3 tasks, serial) + one fresh reader (4 tasks) — each reads the docs once...')

  const [writer, reader] = await parallel([
    () => agent(writerPrompt(env), { label: 'exercise:writer', phase: 'Exercise', schema: EXERCISE_SCHEMA, model: 'sonnet', effort: 'low' }),
    () => agent(readerPrompt(env), { label: 'exercise:reader', phase: 'Exercise', schema: EXERCISE_SCHEMA, model: 'sonnet', effort: 'low' }),
  ])

  const exerciseResults = [
    ...(writer ? writer.results : []),
    ...(reader ? reader.results : []),
  ]
  const friction = [
    ...(writer ? writer.friction : []),
    ...(reader ? reader.friction : []),
  ]
  const claims = Object.fromEntries(exerciseResults.map((r) => [r.testId, r]))

  // ── Verify ────────────────────────────────────────────────────────────────
  // One adversarial pass over the final repo state covers all tests.
  phase('Verify')
  log('Adversarially verifying every outcome against the final scratch-repo state...')

  const allTests = [...WRITE_TESTS, ...READ_TESTS]
  const verify = await agent(verifyPrompt(env, allTests, claims), { label: 'verify:all', phase: 'Verify', schema: VERIFY_SCHEMA, model: 'sonnet' })

  const verdicts = verify ? verify.verdicts : []
  const passed = verdicts.filter((v) => v.pass)
  const failed = verdicts.filter((v) => !v.pass)
  const unverified = allTests.filter((t) => !verdicts.some((v) => v.testId === t.id)).map((t) => t.id)

  report = {
    status: verdicts.length === 0 ? 'verify_failed' : failed.length === 0 && unverified.length === 0 ? 'all_passed' : 'failures',
    summary: `${passed.length}/${allTests.length} tests passed${unverified.length ? `, ${unverified.length} unverified` : ''}.`,
    passed: passed.map((v) => v.testId),
    failed: failed.map((v) => ({ testId: v.testId, reason: v.reason, evidence: v.evidence })),
    unverified,
    friction,
    verdicts,
  }
} finally {
  // ── Teardown (best-effort; runs even if the exercise/verify threw) ──────────
  phase('Teardown')
  log('Removing scratch dirs...')
  await agent(
    `Remove the test scratch directories and confirm they are gone. Run:
       rm -rf ${env.dataDir} ${env.cfgDir}
     Then verify neither path exists anymore (ls should fail for both). Return a one-line
     confirmation. Do NOT touch any other path.`,
    { label: 'teardown:cleanup', phase: 'Teardown', model: 'sonnet', effort: 'low' },
  )
}

return report
