# Design decisions

Numbered decisions behind the reusable workflows. A new decision takes the next free number; a changed
one is rewritten in place.

## S1 go-service.yml runs its checks in parallel jobs, compatibly with v1

`go-service.yml` used to call `go-library.yml`: one job ran lint, unit tests, end to end and vulncheck in
sequence. It now runs them as parallel jobs (lint and vulncheck, unit tests, end to end, TypeScript, one
job per extra recipe), so the pipeline takes as long as its slowest job instead of the sum. Every v1 input
keeps its name, type and default, and a v1 caller needs no new permission, so the change ships under `v1`
(the owner moves the tag). What a v1 caller sees change: one check per job (`go-service / unit tests`
and so on), and the image job runs only on pushes to the default branch and `v*` tags, which is what the
v1 starter triggers anyway. v1's single check `go-service / check / lint, test, e2e, vulncheck` stays:
a last job of that name (job names may contain ` / `) fails when any job failed or was cancelled, so a
branch protection rule that requires it keeps working, and the set of other checks may follow the inputs
(one per recipe) without touching branch protection. It runs with `always()`, since a skipped required
check counts as passed. `go-library.yml` keeps
its single job: a library's pipeline is short, and one runner saves a cache restore per job.

## S2 One cache per job, setup steps shared by YAML anchors

The jobs build different things (race-instrumented tests, the coverage build of the e2e suite, lint), so
each restores and saves its own cache (`go-<job>-<os>-<go release>-<go.sum hash>-<sha>`): the Go build and
test cache, the module cache, the children of `~/.embedded-postgres-go` except `*-test` (a service's
running test server keeps its data, and a `postmaster.pid` that refuses the next start, under such a
directory; an excluded path inside an included directory would still land in the archive) and
golangci-lint's cache. Pushes to the default branch save; a pull request saves only when it restored
no cache of its Go release and `go.sum` (a cold run, typically a dependency update or a Go patch release), so its next push is warm, and
pull requests do not crowd the default branch's caches out of the quota. The key names the installed Go
release (`go env GOVERSION`), not the minor of `go.mod`: setup-go installs the newest patch, and after a
patch release a cache of the old one holds no usable build or test result, so the run must count as cold
(cold budget, and a pull request saves). Any cache of the job is the last restore key, for the modules.
The setup steps are written
once, in the lint job, and aliased in the others: a reusable workflow cannot use a local composite action
of its own repository (`./` is the caller's checkout), and referencing one by tag would run the tag's
version from a branch under test.

## S3 The budget job reads job times from the API and takes the caller's grant

The budget job prints every job's time and fails when the run, from its start to the budget job, took
longer than `budget-<warm|cold>-seconds` plus `budget-margin-percent`. Warm means the unit test job
restored a cache of the same Go release and `go.sum`. It reads `run_started_at` and the jobs of the run attempt from the
API, which needs `actions: read` on private repositories. The job declares no `permissions`: a job of a
called workflow that declares a permission the caller did not grant fails the whole run at startup, even
when the job would be skipped (verified 16.11.2026 on a probe pull request), which would break every v1
caller. Without a declaration the job takes the caller's grant; it checks out nothing and runs only the
workflow's own script, so the wider token reaches no code of the calling repository. A caller that sets a
budget grants `actions: read`; without it the job fails with that hint. Job outputs instead of the API
would need no permission, but cannot report the time of each matrix job, and miss the queue time.
Budgets default to 0 (none), so a slow v1 caller does not start failing; full runs are uncached and
have no budget. A re-run attempt prints the times but checks no budget: `run_started_at` restarts with
the attempt, and "re-run failed jobs" runs only some jobs, so the elapsed time is not the pipeline's. The
first attempt's verdict stands in its own run.

The budget job is frozen as it is: a caller without `hot-path-seconds` keeps its job, span, runner and
verdict. With `hot-path-seconds` the job does not run; the budgets and the cap are judged by the last step
of `check` instead (S15). Its span runs from `run_started_at` to that step, so it covers the queue of
`check` and, on a push, the tag job; the cap is `hot-path-seconds`, which the workflow refuses above the org
limit of 600 s, minus 60 s on a pull request. A re-run there is judged anew when every expected job ran
again, and repeats the verdict of the attempt before when only some did and that attempt was green. `check` declares no permissions
for the same reason as the budget job.

## S4 Extra recipes as a JSON matrix with FULL and BASE_REF

`recipes` is a JSON array of justfile recipes, one job each, with its own cache and golangci-lint and
Bun installed (a derivation check lints, a migration check runs squawk through Bun). A recipe sees
`FULL=true` on a full run, so it can run uncached and shuffled, and `BASE_REF`, the pull request's base
branch, with the full history checked out, for checks against the base such as an API breaking-change
check. A recipe list instead of fixed inputs per check keeps application-specific checks in the
application's justfile.

## S5 The TypeScript job has no Go

With `bun-version`, `just test-typescript` runs in its own job with Bun and just only: a frontend's type
checks, tests and build need neither the Go toolchain nor its cache. Bun is also on the `PATH` of every
Go job, as in `go-library.yml`. `typescript: false` keeps Bun and drops the job, for a service that uses
Bun only for a tool (squawk in a migration check) and has no `test-typescript` recipe.

## S6 Badges from the jobs that ran the tests

The unit test job writes the unit test and coverage badges (it has the Go toolchain for
`go tool cover`), the e2e job the e2e badge; each uploads them with its JSON report, and the badges job
collects them on pushes to the default branch. Without the e2e job, or when `just test-e2e` skipped an
unchanged suite without writing `sandbox/e2e.json` (TST-015 asks only for the record), the badges branch
carries no e2e badge, as with `go-library.yml`.

## S7 No attestation on private repositories

GitHub stores build provenance attestations for public repositories only (private ones need GitHub
Enterprise Cloud), so the attestation step is skipped when the repository is private, and the image is
still pushed. The image job still declares `id-token: write` and `attestations: write`, so a private
caller grants them too: a job's permissions cannot depend on the repository's visibility.

## S8 Full runs shuffle in the recipes, not in the workflow

`full: true` runs `just test-all` and `just test-e2e-all`, and the contract says both run every test
uncached and shuffled (`-count=1 -shuffle=on`, TST-005). The workflow adds no flag: v1 recipes take no
arguments, and a flag injected by CI (`GOFLAGS`) would make CI and a local `just test-e2e-all` differ.

## S9 The image is built beside the checks and tagged after them

With `hot-path-seconds` the job `build the image` starts with the checks, on pull requests too. A pull
request exports every platform to an OCI tarball and pushes nothing, so compile and compression are inside
its measurement and a broken Dockerfile fails it. A push pushes the image by digest, without a tag; the job
`build, attest and push the image` tags that digest (`docker buildx imagetools create`) once every check
passed, and attests the digest the `sha-` tag resolves to. A deploy follows tags, so nothing deploys an
image whose checks failed, and the pipeline takes the longer of checks and build instead of their sum
(measured on the first service: checks 135 to 160 s, then the image job 428 to 545 s). Without
`hot-path-seconds` the image job builds and pushes as before. The untagged versions of failed runs stay in
the registry; they are harmless for deploys.

## S10 The compile cache travels as a cache mount, not as layers

The image job's `type=gha` layer cache did not pay: on the first service the repository's cache quota was
over-committed (10.5 GB of 10 GB), the blobs were evicted, every run missed (`go mod download`, 38 to 41 s,
never `CACHED`) and then spent 111 to 183 s exporting the layers again, while the two cold Go compiles took
190 to 245 s. In hot path mode there is no layer cache. The Go compile cache is carried instead: an
`actions/cache` entry (`sandbox/image-mounts`, keyed on the Dockerfile) that two small `docker buildx
build` calls copy into the builder's cache mount `/root/.cache/go-build` before the build and out of it
afterwards. Cache mounts are keyed by their target inside a builder, so the service's build finds the
files. The transfer builds take a stamp of run id and attempt as a build argument, never `--no-cache`,
which empties cache mounts. The busybox they run is pinned by digest and pulled from Amazon's mirror of the
Docker library, which has no Docker Hub pull limit. The save rule is the Go caches' (S2); an extraction
that finds no file warns and saves nothing, so a Dockerfile without the mount builds as before, uncached.
`go mod download` and the frontend build run every time, in parallel stages, beside the checks.

## S11 A browser job with shards, selection in the recipe

`browser` names the justfile recipe of the browser journeys; `browser-shards` (1 to 8) runs it in one job
per shard with `SHARD=<n>/<shards>`. Expressions have no arithmetic, so the shard list is a lookup by
count; a count outside the range yields no matrix and fails the run, so no shard can be left out. Which
journeys a change needs is the recipe's decision (`BASE_SHA`), so CI and a local run select the same; the
job checks out the full history, carries Chromium's download keyed on `bun.lock` and uploads the
Playwright report of a failed shard. The recipe installs the browser.

## S12 Green-run records for every job

With `hot-path-seconds` the lint, recipe and browser jobs restore and save `sandbox/*-passed`, the records
a recipe writes after a green run (TST-015), under `passed-<job>-<sha>-<run id>-<attempt>`: one key per job
and shard, so no two jobs of a run write one key, and run id and attempt keep a scheduled run or a re-run on
a commit that already saved from failing to save. Full runs restore them too: the recipes ignore records
when `FULL=true`, and a green full run writes them. Without `hot-path-seconds` these jobs carry no records: a
caller's recipe that happens to write `sandbox/*-passed` then runs in CI exactly as before. The e2e job
keeps its own records (`e2e-passed-`).

## S13 The nightly alert is its own workflow

`nightly-alert.yml` is called by a second job of the caller's `ci.yml`, not run inside `go-service.yml` or
`go-library.yml`: a called job that declares `issues: write` fails every v1 caller that does not grant it
at startup (S3), and one workflow serves both and a caller with jobs of its own. The issue of a workflow on
a ref is the open issue labelled `nightly-ci` whose body carries `<!-- nightly-alert <workflow ref> -->`
(workflow file and full ref), so two workflows, or a branch and a tag of one name, never share one, and a
probe on a branch never touches the default branch's issue. The body records the newest red run and, when
closed, the green run that closed it (`<run number>.<attempt>`): an older green run that finishes late
leaves the issue open, a late old red run does not open one that a newer green run closed, and a re-run of
the red run closes it. The job has one concurrency group per workflow ref and checks every login with the
assignability endpoint before it changes anything; it fails on every run while no login can be assigned or
the open issue has no assignee, and the next red run adds the assignees an issue lacks.

## S14 Timeouts are not an input

Every job that runs the repository's code times out after 10 minutes on a hot path run, after 60 on any
other run of a caller with `hot-path-seconds`, and keeps GitHub's 360 without it; `check` after 5. The
failure mode they guard against is a suite whose timeout was raised step by step until the pipeline took an
hour, so no input, `full` included, changes them. They end a hung job and are no run deadline: one that
cancels the run at the cap would turn the same pipeline red a little earlier and tell nothing more, while the
verdict already blocks the merge. The YAML anchor of the first job carries the expression to the others.

## S15 The required check judges the hot path

The cap is a step of `check`, the one check branch protection requires, not a job of its own: a pull
request over the cap cannot merge without a new required check, and no job can be skipped around it. The
step reads the run attempt and its jobs from the API, writes a table of runner, queue and run seconds per
job, and samples the elapsed time once more as its last statement before the verdict, so only the end of
the job lies behind the span. A re-run attempt is complete only when every expected job (each need that was
not skipped, one per recipe and per shard) started at or after the attempt's start; a partial attempt
repeats the verdict of the step in the attempt before only when that attempt's results step passed too,
and fails otherwise: a job that failed early, or a cancelled run, shortened the pipeline the earlier step
measured. A cancelled run gets no verdict at all (the step is skipped). `check` also fails when a job
that `browser` or `hot-path-seconds` enables was skipped, so a cancelled run cannot pass without its image.
In hot path mode `check` runs on the checks' runner kind, written without `gh` or `jq`.

## S16 Only the branch head moves the branch tag

The caller's concurrency group serializes the pushes of a branch and the image job keeps its own group, but
neither stops a re-run of an older run's image job from pointing `:main` back. The tag step therefore asks
the remote for the branch head (`git ls-remote`) and writes the branch tag only when the head is the run's
commit; the `sha-` tag is always written. That is right for a rollback (the head is the older commit, its
run moves the tag) and for diverged history (an old run is not the head). The price: a commit superseded
before its tag job runs never carries `:main`; the head that follows it does, when it is green.
