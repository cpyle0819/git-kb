export const meta = {
  name: 'test-skill',
  description: 'Fresh-eyes test of the /kb skill. Spins up isolated scratch KB, has fresh agents exercise init/add/edit/search + the auto-trigger hook the way a user would, adversarially verifies the outcomes against the scratch repo, and reports pass/fail plus doc-followability friction. Safe: never touches the real KB or its remote.',
  phases: [
    { title: 'Setup', detail: 'mktemp an isolated scratch KB + config, seed known entries, build index' },
    { title: 'Exercise', detail: 'Fresh-eyes agents perform user tasks by following the skill docs' },
    { title: 'Verify', detail: 'Adversarially confirm each outcome in the scratch repo' },
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

const TEST_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    testId: { type: 'string' },
    commandsRun: { type: 'array', items: { type: 'string' }, description: 'The exact shell commands run, in order' },
    scriptOutput: { type: 'string', description: 'The relevant output the script(s) printed (SAVED/EDITED/push line/search results/etc.)' },
    claimedOutcome: { type: 'string', description: 'What the agent believes happened' },
    friction: { type: 'array', items: { type: 'string' }, description: 'Fresh-eyes friction: anything ambiguous, missing, or that forced a guess while following the docs' },
  },
  required: ['testId', 'commandsRun', 'scriptOutput', 'claimedOutcome', 'friction'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    testId: { type: 'string' },
    pass: { type: 'boolean' },
    evidence: { type: 'string', description: 'What was actually observed in the scratch repo (git log line, file contents, search output) that proves pass/fail' },
    reason: { type: 'string', description: 'If failed, the concrete discrepancy between expected and actual' },
  },
  required: ['testId', 'pass', 'evidence', 'reason'],
}

// ─── Test definitions ────────────────────────────────────────────────────────

// Mutating tests run SERIALLY — they all commit to one git repo and concurrent
// kb-save.js runs would collide on .git/index.lock and the pull/commit cycle.
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
    expect: 'The existing rate-limit entry is edited in place (same id, no new id assigned), its body now says 200, `updated:` is bumped, and git log shows an `edit kb-NNNN: ...` commit. The script printed EDITED.',
  },
]

// Read-only tests run in PARALLEL — safe against the shared repo.
const READ_TESTS = [
  {
    id: 'search-keyword',
    task: 'The user asks: "what did we decide about the analytics database?" Search the KB for relevant entries and answer.',
    expect: 'kb-search.js returns the seeded PostgreSQL/analytics decision entry as a top hit (matched on title/tags). The agent answers from the returned body without re-reading files.',
  },
  {
    id: 'search-type-filter',
    task: 'The user asks: "list all my bookmarks." Use the skill to list only bookmark-type entries.',
    expect: 'The agent runs kb-search.js with `--type bookmark "*"` and gets back only bookmark entries (the seeded deploy-dashboard bookmark, plus any added during this test run). No non-bookmark entries appear.',
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
]

// ─── Prompt builders ─────────────────────────────────────────────────────────

const harnessPreamble = (env) => `
You are a FRESH user of the \`/kb\` skill — you have no memory of how it was built.
Learn it only from its docs, then use it to accomplish a task.

Test-harness environment (this is NOT the real KB — it is a disposable scratch copy):
- Skill root:  ${env.skillDir}
- Scripts dir: ${env.scriptsDir}
- Scratch config (CLAUDE_PLUGIN_DATA): ${env.cfgDir}
- Scratch data repo: ${env.dataDir}
- Seeded entries already present: ${env.seededIds.join(', ')}

How to run the skill in this harness:
1. Read ${env.skillDir}/SKILL.md first. Follow whatever it says. If it points you to a
   file under references/, read that too — that is part of the test (does the doc
   send you to the right place?).
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
`.trim()

const writePrompt = (t, env) => `${harnessPreamble(env)}

## Your task
${t.task}

Follow the skill's documented flow for this kind of task end to end (draft the entry
per the spec, run the save helper, interpret its output). Then return the structured
result: the exact commands you ran, the script's output, what you believe happened,
and any friction.`

const readPrompt = (t, env) => `${harnessPreamble(env)}

## Your task
${t.task}

Follow the skill's documented flow. Return the structured result: exact commands,
script output, what you believe happened, and any friction.`

const verifyPrompt = (x, env) => `
You are an adversarial verifier. Do NOT trust the test agent's self-report — confirm
the truth by inspecting the scratch KB directly.

Scratch data repo: ${env.dataDir}  (git repo; entries in entries/, manifest kb.json, index kb-index.json)
Scripts dir: ${env.scriptsDir}
Scratch config: ${env.cfgDir}  (set CLAUDE_PLUGIN_DATA=${env.cfgDir} to run any kb script)
Seeded entries: ${env.seededIds.join(', ')}

## Test under verification: ${x.t.id}
Expected outcome:
${x.t.expect}

The test agent claimed:
${x.r ? JSON.stringify({ claimedOutcome: x.r.claimedOutcome, scriptOutput: x.r.scriptOutput }, null, 2) : '(the test agent produced no result — treat as fail unless the repo state proves the outcome happened anyway)'}

## How to verify
Inspect the actual state. Useful commands (all read-only):
- git -C ${env.dataDir} log --oneline
- git -C ${env.dataDir} show --stat HEAD
- ls ${env.dataDir}/entries/ ; cat the relevant entry file
- CLAUDE_PLUGIN_DATA=${env.cfgDir} node ${env.scriptsDir}/kb-search.js "<term>"
- for the trigger tests, re-run: echo '<the json>' | CLAUDE_PLUGIN_DATA=${env.cfgDir} node ${env.scriptsDir}/kb-trigger.js

Decide pass/fail based on what the repo ACTUALLY contains, not what was claimed. Cite
the concrete evidence (the git log line, the file contents, the exact script output).`

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

const env = await agent(setupPrompt, { label: 'setup:scratch-kb', phase: 'Setup', schema: SETUP_SCHEMA })

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
  phase('Exercise')
  log('Running mutating tests serially (shared git repo), then read tests in parallel...')

  const writeResults = []
  for (const t of WRITE_TESTS) {
    const r = await agent(writePrompt(t, env), { label: `exercise:${t.id}`, phase: 'Exercise', schema: TEST_RESULT_SCHEMA })
    writeResults.push({ t, r })
  }

  const readResults = (await parallel(
    READ_TESTS.map((t) => () =>
      agent(readPrompt(t, env), { label: `exercise:${t.id}`, phase: 'Exercise', schema: TEST_RESULT_SCHEMA })
        .then((r) => ({ t, r })),
    ),
  )).filter(Boolean)

  const allTests = [...writeResults, ...readResults]

  // ── Verify ────────────────────────────────────────────────────────────────
  phase('Verify')
  log(`Adversarially verifying ${allTests.length} test outcomes against the scratch repo...`)

  const verdicts = (await parallel(
    allTests.map((x) => () =>
      agent(verifyPrompt(x, env), { label: `verify:${x.t.id}`, phase: 'Verify', schema: VERDICT_SCHEMA })
        .then((v) => ({ testId: x.t.id, verdict: v, friction: x.r ? x.r.friction : [] })),
    ),
  )).filter(Boolean)

  const passed = verdicts.filter((v) => v.verdict && v.verdict.pass)
  const failed = verdicts.filter((v) => !v.verdict || !v.verdict.pass)
  const allFriction = verdicts.flatMap((v) => (v.friction || []).map((f) => ({ testId: v.testId, note: f })))

  report = {
    status: failed.length === 0 ? 'all_passed' : 'failures',
    summary: `${passed.length}/${verdicts.length} tests passed.`,
    passed: passed.map((v) => v.testId),
    failed: failed.map((v) => ({ testId: v.testId, reason: v.verdict ? v.verdict.reason : 'no verdict returned', evidence: v.verdict ? v.verdict.evidence : '' })),
    friction: allFriction,
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
    { label: 'teardown:cleanup', phase: 'Teardown' },
  )
}

return report
