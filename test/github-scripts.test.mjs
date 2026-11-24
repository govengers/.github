// Runs the github-script steps of the workflows against fakes of the GitHub API: the hot path verdict of
// go-service.yml (cap, budgets, re-run completeness) and the issue logic of nightly-alert.yml (run ordering,
// assignees). Needs node 20 or newer and yq on the PATH: node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const script = (file, query) => execFileSync('yq', [query, file], { encoding: 'utf8' })
const hotPath = script('.github/workflows/go-service.yml', '.jobs.check.steps[] | select(.name == "Hot path budget") | .with.script')
const alert = script('.github/workflows/nightly-alert.yml', '.jobs.alert.steps[0].with.script')
const AsyncFunction = (async () => {}).constructor

// Runs a script as actions/github-script does, with env, a fake client, a context and a clock.
async function run(source, { env, github, context, now = 0 }) {
  const log = { failed: [], info: [], warnings: [], summary: '' }
  const core = {
    setFailed: (message) => log.failed.push(message),
    info: (message) => log.info.push(message),
    warning: (message) => log.warnings.push(message),
    summary: { addRaw(text) { log.summary += text; return this }, async write() {} },
  }
  const saved = { ...process.env }
  const realNow = Date.now
  Object.assign(process.env, env)
  Date.now = () => now
  try {
    await new AsyncFunction('github', 'context', 'core', source)(github, context, core)
  } finally {
    Date.now = realNow
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  }
  return log
}

const notFound = () => Object.assign(new Error('Not Found'), { status: 404 })

// The hot path verdict.

const T0 = Date.parse('2026-11-24T10:00:00Z')
const at = (s) => new Date(T0 + s * 1000).toISOString()
const job = (name, startedAt, extra = {}) => ({ name: `service / ${name}`, started_at: at(startedAt), completed_at: at(startedAt + 30), created_at: at(startedAt - 2), runner_name: 'fuji-1', conclusion: 'success', ...extra })
const success = { result: 'success', outputs: {} }
const skipped = { result: 'skipped', outputs: {} }
const prNeeds = { lint: success, test: success, e2e: success, typescript: skipped, recipes: success, browser: success, 'image-build': success, image: skipped }

function checkRun({ attempts, needs = prNeeds, event = 'pull_request', now, env = {} }) {
  const attempt = Math.max(...Object.keys(attempts).map(Number))
  const github = {
    rest: { actions: {
      getWorkflowRunAttempt: async ({ attempt_number: n }) => {
        if (!attempts[n].readable) throw Object.assign(new Error('Resource not accessible by integration'), { status: 403 })
        return { data: { run_started_at: at(attempts[n].started) } }
      },
      listJobsForWorkflowRunAttempt: 'listJobsForWorkflowRunAttempt',
    } },
    paginate: async (method, { attempt_number: n }) => attempts[n].jobs,
  }
  return run(hotPath, {
    github,
    context: { repo: { owner: 'govengers', repo: 'holo' }, runId: 7, eventName: event },
    now: T0 + now * 1000,
    env: {
      GITHUB_RUN_ATTEMPT: String(attempt), HOT_PATH_SECONDS: '600', WARM_BUDGET: '0', COLD_BUDGET: '0', MARGIN_PERCENT: '20',
      TEST_CACHE: 'warm', IMAGE_CACHE: 'warm', NEEDS: JSON.stringify(needs), RECIPES: '["db-check"]', BROWSER_SHARDS: '2', ...env,
    },
  })
}

const allJobs = (start) => ['lint, vulncheck', 'unit tests', 'end-to-end tests', 'just db-check', 'browser journeys 1/2', 'browser journeys 2/2', 'build the image']
  .map((name) => job(name, start + 5))
const checkJob = (start, conclusion) => job('check / lint, test, e2e, vulncheck', start, { steps: conclusion ? [{ name: 'Hot path budget', conclusion }] : [] })

test('hot path: a value above 600 fails with the org cap', async () => {
  const log = await checkRun({ attempts: { 1: { started: 0, readable: true, jobs: allJobs(0) } }, now: 100, env: { HOT_PATH_SECONDS: '900' } })
  assert.deepEqual(log.failed, ['hot path: hot-path-seconds is 900, above the org cap of 600 s (TST-018)'])
})

test('hot path: unreadable jobs fail with the actions: read hint', async () => {
  const log = await checkRun({ attempts: { 1: { started: 0, readable: false, jobs: [] } }, now: 100 })
  assert.match(log.failed[0], /^hot path: the run's jobs are not readable .*; the caller must grant actions: read$/)
})

test('hot path: a pull request is capped 60 s below a push', async () => {
  const attempts = { 1: { started: 0, readable: true, jobs: allJobs(0) } }
  assert.deepEqual((await checkRun({ attempts, now: 540 })).failed, [])
  assert.deepEqual((await checkRun({ attempts, now: 541 })).failed, ['hot path: 541 s, over the cap of 540 s (TST-018)'])
  assert.deepEqual((await checkRun({ attempts, now: 600, event: 'push' })).failed, [])
  assert.deepEqual((await checkRun({ attempts, now: 601, event: 'push' })).failed, ['hot path: 601 s, over the cap of 600 s (TST-018)'])
})

test('hot path: the early warning takes the budget of the run kind, and the cap holds without budgets', async () => {
  const attempts = { 1: { started: 0, readable: true, jobs: allJobs(0) } }
  const budgets = { WARM_BUDGET: '300', COLD_BUDGET: '480' }
  assert.deepEqual((await checkRun({ attempts, now: 360, env: budgets })).failed, [])
  assert.deepEqual((await checkRun({ attempts, now: 361, env: budgets })).failed, ['budget: the pipeline took 361 s, over its warm budget of 300 s plus 20 %'])
  assert.deepEqual((await checkRun({ attempts, now: 361, env: { ...budgets, IMAGE_CACHE: 'cold' } })).failed, [])
  const both = await checkRun({ attempts, now: 590, env: { ...budgets, TEST_CACHE: 'cold' } })
  assert.deepEqual(both.failed, ['hot path: 590 s, over the cap of 540 s (TST-018)\nbudget: the pipeline took 590 s, over its cold budget of 480 s plus 20 %'])
})

test('hot path: the summary lists runner, queue and run seconds, a dash for a carried job', async () => {
  const jobs = [...allJobs(0), job('unit tests', 10, { created_at: at(20) })]
  const log = await checkRun({ attempts: { 1: { started: 0, readable: true, jobs } }, now: 200 })
  assert.match(log.summary, /\| service \/ lint, vulncheck \| fuji-1 \| 2 \| 30 \|/)
  assert.match(log.summary, /\| service \/ unit tests \| fuji-1 \| - \| 30 \|/)
  assert.match(log.summary, /\| \*\*hot path\*\* \(warm caches, attempt 1\) \| \| \| \*\*200\*\* \|/)
})

test('hot path: a re-run in which every expected job ran again is judged anew', async () => {
  const attempts = {
    1: { started: 0, readable: true, jobs: [...allJobs(0), checkJob(400, 'failure')] },
    2: { started: 1000, readable: true, jobs: allJobs(1000) },
  }
  assert.deepEqual((await checkRun({ attempts, now: 1300 })).failed, [])
  assert.deepEqual((await checkRun({ attempts, now: 1600 })).failed, ['hot path: 600 s, over the cap of 540 s (TST-018)'])
})

test('hot path: a partial re-run repeats the verdict of the attempt before', async () => {
  // Browser shard 2/2 carried over with its old timestamps; on the next attempt shard 1/2 is missing.
  const carried = allJobs(1000).map((j) => (j.name.endsWith('2/2') ? job('browser journeys 2/2', 5) : j))
  const missing = allJobs(1000).filter((j) => !j.name.endsWith('1/2'))
  for (const [jobs, verdict, expected] of [
    [carried, 'success', []],
    [missing, 'success', []],
    [carried, 'failure', ['hot path: attempt 1 broke the budget and this re-run did not repeat every job; make the pipeline faster or re-run all jobs']],
    [carried, 'skipped', ['hot path: no verdict of a complete attempt; re-run all jobs']],
    [carried, 'cancelled', ['hot path: no verdict of a complete attempt; re-run all jobs']],
    [carried, undefined, ['hot path: no verdict of a complete attempt; re-run all jobs']],
  ]) {
    const attempts = { 1: { started: 0, readable: true, jobs: [...allJobs(0), checkJob(400, verdict)] }, 2: { started: 1000, readable: true, jobs } }
    const log = await checkRun({ attempts, now: 1100 })
    assert.deepEqual(log.failed, expected, `earlier verdict ${verdict}`)
    if (expected.length === 0) assert.ok(log.info.includes('hot path: earlier verdict stands'))
  }
})

test('hot path: expected jobs follow the needs, a skipped need expects nothing', async () => {
  // On a push the image job is expected too; here it did not run again.
  const needs = { ...prNeeds, image: success }
  const attempts = { 1: { started: 0, readable: true, jobs: [checkJob(400, 'failure')] }, 2: { started: 1000, readable: true, jobs: allJobs(1000) } }
  assert.match((await checkRun({ attempts, needs, now: 1100, event: 'push' })).failed[0], /^hot path: attempt 1 broke the budget/)
  // Without recipes and browser jobs, the remaining jobs are complete.
  const fewer = { ...prNeeds, recipes: skipped, browser: skipped }
  const jobs = allJobs(1000).filter((j) => !/just|browser/.test(j.name))
  const complete = { 1: { started: 0, readable: true, jobs: [checkJob(400, 'failure')] }, 2: { started: 1000, readable: true, jobs } }
  assert.deepEqual((await checkRun({ attempts: complete, needs: fewer, now: 1100 })).failed, [])
})

// The nightly alert.

const REF = 'govengers/holo/.github/workflows/ci.yml@refs/heads/main'
const MARKER = `<!-- nightly-alert ${REF} -->`

function repository({ issues = [], label = true, assignable = ['ada'] } = {}) {
  const state = { issues: issues.map((issue) => ({ assignees: [], ...issue })), comments: [], label, labelsCreated: 0 }
  const find = (number) => state.issues.find((issue) => issue.number === number)
  const github = {
    rest: {
      issues: {
        checkUserCanBeAssigned: async ({ assignee }) => { if (!assignable.includes(assignee)) throw notFound() },
        listForRepo: 'listForRepo',
        getLabel: async () => { if (!state.label) throw notFound() },
        createLabel: async () => { state.label = true; state.labelsCreated++ },
        create: async ({ title, body, labels, assignees }) => {
          const issue = { number: state.issues.length + 1, state: 'open', title, body, labels, assignees: assignees.map((login) => ({ login })) }
          state.issues.push(issue)
          return { data: { ...issue } }
        },
        createComment: async ({ issue_number, body }) => { state.comments.push({ issue: issue_number, body }) },
        update: async ({ issue_number, ...changes }) => { Object.assign(find(issue_number), changes); return { data: { ...find(issue_number) } } },
        addAssignees: async ({ issue_number, assignees }) => {
          find(issue_number).assignees.push(...assignees.map((login) => ({ login })))
          return { data: { ...find(issue_number) } }
        },
      },
      actions: { listJobsForWorkflowRunAttempt: 'listJobsForWorkflowRunAttempt' },
    },
    paginate: async (method, params) => {
      if (method === 'listJobsForWorkflowRunAttempt') {
        return [{ name: 'service / unit tests', conclusion: 'failure', html_url: 'https://github.com/govengers/holo/actions/runs/7/job/1' }, { name: 'service / lint, vulncheck', conclusion: 'success' }, { name: 'alert / nightly alert', conclusion: null }]
      }
      return state.issues.filter((issue) => issue.state === params.state).map((issue) => ({ ...issue }))
    },
  }
  return { state, github }
}

const alertRun = (github, { result, number, attempt = 1, assignees = 'ada' }) => run(alert, {
  github,
  context: { repo: { owner: 'govengers', repo: 'holo' }, runId: 7, runNumber: number, serverUrl: 'https://github.com' },
  env: { RESULT: result, ASSIGNEES: assignees, WORKFLOW: 'CI', WORKFLOW_REF: REF, REF_NAME: 'main', GITHUB_RUN_ATTEMPT: String(attempt) },
})
const openIssue = (lastRed, extra = {}) => ({ number: 1, state: 'open', body: `red\n${MARKER}\n<!-- last-red-run ${lastRed} -->`, assignees: [{ login: 'ada' }], ...extra })

test('alert: a red run opens an assigned issue with both markers and creates the label', async () => {
  const { state, github } = repository({ label: false })
  const log = await alertRun(github, { result: 'failure', number: 12 })
  assert.deepEqual(log.failed, [])
  assert.equal(state.labelsCreated, 1)
  const [issue] = state.issues
  assert.equal(issue.title, 'CI is red on main')
  assert.deepEqual(issue.labels, ['nightly-ci'])
  assert.deepEqual(issue.assignees, [{ login: 'ada' }])
  assert.ok(issue.body.includes(MARKER) && issue.body.includes('<!-- last-red-run 12.1 -->'))
  assert.ok(issue.body.includes('[service / unit tests](https://github.com/govengers/holo/actions/runs/7/job/1): failure'))
  assert.ok(!issue.body.includes('lint, vulncheck') && !issue.body.includes('nightly alert'))
})

test('alert: an issue of another workflow or ref is not this one', async () => {
  const other = openIssue('3.1', { body: 'red\n<!-- nightly-alert govengers/holo/.github/workflows/ci.yml@refs/heads/probe -->\n<!-- last-red-run 3.1 -->' })
  const { state, github } = repository({ issues: [other] })
  await alertRun(github, { result: 'failure', number: 12 })
  assert.equal(state.issues.length, 2)
  await alertRun(github, { result: 'success', number: 13 })
  assert.equal(state.issues[0].state, 'open')
  assert.equal(state.issues[1].state, 'closed')
})

test('alert: a further red run comments, raises last-red-run only when newer, and adds missing assignees', async () => {
  const { state, github } = repository({ issues: [openIssue('12.1', { assignees: [] })] })
  await alertRun(github, { result: 'failure', number: 14 })
  assert.equal(state.comments.length, 1)
  assert.match(state.comments[0].body, /^Red again: https:\/\/github\.com\/govengers\/holo\/actions\/runs\/7\/attempts\/1/)
  assert.ok(state.issues[0].body.includes('<!-- last-red-run 14.1 -->'))
  assert.deepEqual(state.issues[0].assignees, [{ login: 'ada' }])
  await alertRun(github, { result: 'failure', number: 13 })
  assert.equal(state.comments.length, 2)
  assert.ok(state.issues[0].body.includes('<!-- last-red-run 14.1 -->'))
})

test('alert: a newer green run closes, a re-run of the red run too, an older one leaves it open', async () => {
  for (const [number, attempt, closes] of [[13, 1, true], [12, 2, true], [12, 1, false], [11, 3, false]]) {
    const { state, github } = repository({ issues: [openIssue('12.1')] })
    const log = await alertRun(github, { result: 'success', number, attempt })
    assert.deepEqual(log.failed, [])
    assert.equal(state.issues[0].state, closes ? 'closed' : 'open', `run ${number}.${attempt}`)
    if (closes) {
      assert.equal(state.issues[0].state_reason, 'completed')
      assert.ok(state.issues[0].body.includes(`<!-- closed-by-run ${number}.${attempt} -->`))
      assert.match(state.comments[0].body, /^green again: /)
    } else {
      assert.equal(state.comments.length, 0)
    }
  }
})

test('alert: a late old red run does not reopen what a newer green run closed', async () => {
  const closed = { number: 1, state: 'closed', body: `red\n${MARKER}\n<!-- last-red-run 12.1 -->\n<!-- closed-by-run 14.1 -->` }
  const late = repository({ issues: [closed] })
  await alertRun(late.github, { result: 'failure', number: 13 })
  assert.equal(late.state.issues.length, 1)
  const fresh = repository({ issues: [closed] })
  await alertRun(fresh.github, { result: 'failure', number: 15 })
  assert.equal(fresh.state.issues.length, 2)
})

test('alert: cancelled and skipped results change nothing', async () => {
  for (const result of ['cancelled', 'skipped']) {
    const { state, github } = repository({ issues: [openIssue('12.1')] })
    const log = await alertRun(github, { result, number: 13 })
    assert.deepEqual(log.failed, [])
    assert.equal(state.issues[0].state, 'open')
    assert.equal(state.comments.length, 0)
  }
})

test('alert: nobody to assign fails every run, red or green, after the issue is opened', async () => {
  const empty = repository()
  const red = await alertRun(empty.github, { result: 'failure', number: 12, assignees: ' ' })
  assert.equal(empty.state.issues.length, 1)
  assert.deepEqual(red.failed, ['nightly alert: no login in assignees can be assigned; #1 has no assignee; a red run would reach nobody (CI_ALERT_ASSIGNEES)'])
  const typo = await alertRun(repository().github, { result: 'success', number: 12, assignees: 'ada, adaa' })
  assert.deepEqual(typo.failed, ['nightly alert: adaa cannot be assigned in govengers/holo; a red run would reach nobody (CI_ALERT_ASSIGNEES)'])
  // The next red run with the variable restored assigns the issue.
  const restored = await alertRun(empty.github, { result: 'failure', number: 13, assignees: 'ada' })
  assert.deepEqual(restored.failed, [])
  assert.deepEqual(empty.state.issues[0].assignees, [{ login: 'ada' }])
})
