<p align="center"><img src="profile/gophers-assemble.jpg" alt="Go gophers assemble" width="800"></p>

# govengers/.github

Shared GitHub configuration for the govengers org: the [org profile](profile/README.md), the reusable CI workflows for Go libraries and services and their starter templates.

## Go library CI

[`.github/workflows/go-library.yml`](.github/workflows/go-library.yml) runs a library's own justfile recipes, so CI and a local `just check` are the same commands, then publishes badges.

```yaml
# .github/workflows/ci.yml in a library
name: CI

on:
  push:
    branches: [main]
    tags: ["v*"]
  pull_request:

permissions:
  contents: read

jobs:
  go-library:
    uses: govengers/.github/.github/workflows/go-library.yml@v1
    permissions:
      contents: write # the badges job pushes to the badges branch
```

The same file is offered as a starter workflow in every org repo under Actions, New workflow.

### Contract

The library provides these justfile recipes:

| Recipe | Does | Writes |
|--------|------|--------|
| `just lint` | `golangci-lint run` with the repo's `.golangci.yml` (copied from [standards](https://github.com/govengers/standards/blob/main/.golangci.yml)) | |
| `just test` | unit tests with `-race`, without `-count=1` (TST-014), fails below the coverage threshold (TST-010) | `sandbox/unit.json` (`go test -json`), `sandbox/unit.cover` |
| `just test-e2e` | end-to-end tests behind the `e2e` build tag (TST-011); may skip an unchanged suite (TST-015) | `sandbox/e2e.json`, records in `sandbox/e2e-passed/` |
| `just vulncheck` | `govulncheck` in text mode (TCH-008) | |
| `just test-typescript` | only with `bun-version`: type checks and bun tests of the library's TypeScript sources; Bun is on the `PATH` for every recipe, so `just test-e2e` may drive it too | |
| `just test-all`, `just test-e2e-all` | only with `full: true`: every test, uncached and shuffled (`-count=1 -shuffle=on`, TST-005) | as above |

`gotestsum --jsonfile` gives readable output and the JSON file in one run; a library pins it with `go run gotest.tools/gotestsum@<version>` (TCH-002).

### Inputs

| Input | Default | |
|-------|---------|---|
| `golangci-lint-version` | `v2.15.0` | the release `just lint` runs |
| `e2e` | `true` | run `just test-e2e` |
| `badges` | `true` | publish badges on pushes to the default branch |
| `bun-version` | `""` | install this Bun release before the tests and run `just test-typescript` after the unit tests; empty installs no Bun |
| `full` | `false` | run `just test-all` and `just test-e2e-all` instead; the starters set it for the nightly schedule and for `v*` tags, so a release is never tested from the cache |
| `budget-seconds` | `0` | fail a run that is not full when the check job's own steps took longer (TST-018); the job then times out after 60 minutes instead of GitHub's 360. The job's own clock: no API call, no permission, no queue time (a library gates no deployment). `0` sets none |

### Only what changed is tested

- The workflow restores the newest Go build and test cache saved on main (setup-go's own cache is off: it is keyed on `go.sum` alone and never refreshed). `go test` then reruns only the packages whose test binary changed (TST-014). Only pushes to main save the cache, so pull requests cannot crowd it out of the cache quota.
- The cache holds the children of `~/.embedded-postgres-go` except `postgrestest`, postgrestest's server state: on the self-hosted runners it is a mount, tar cannot restore over it, and the whole restore would fail.
- It restores and saves `sandbox/e2e-passed`, the records of green end-to-end runs: `just test-e2e` skips a suite whose server, suite and inputs equal a recorded run (TST-015).
- The nightly run (`full: true`) runs everything uncached, so a flaky test cannot hide in the cache for longer than a day.

### Badges

On every push to the default branch the workflow force-pushes three [shields.io endpoint](https://shields.io/badges/endpoint-badge) files to the `badges` branch of the library:

```markdown
[![CI](https://github.com/govengers/<repo>/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/govengers/<repo>/actions/workflows/ci.yml)
![unit tests](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/govengers/<repo>/badges/unit-tests.json)
![e2e tests](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/govengers/<repo>/badges/e2e-tests.json)
![coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/govengers/<repo>/badges/coverage.json)
```

## Go service CI

[`.github/workflows/go-service.yml`](.github/workflows/go-service.yml) runs the recipes of the library contract above in parallel jobs, then, on a push to the default branch or a `v*` tag, builds the image from the service's Dockerfile for amd64 and arm64, attests its provenance and pushes it: `:main` on main, `:1.2.3` on a tag, and `:1.2`, `:1` and `:latest` only when the tag is the newest release they cover. See the starter in [workflow-templates/go-service.yml](workflow-templates/go-service.yml) and the service template in [govengers/standards](https://github.com/govengers/standards/tree/main/templates/service); the design is in [docs/design.md](docs/design.md).

| Job | Runs | When |
|-----|------|------|
| lint, vulncheck | `just lint`, `just vulncheck` | always |
| unit tests | `just test` (`full`: `just test-all`); unit test and coverage badges | always |
| end-to-end tests | `just test-e2e` (`full`: `just test-e2e-all`), skipped by the recipe when server and suite equal a green run (TST-015) | `e2e: true` |
| TypeScript tests | `just test-typescript`: the frontend's type checks, tests and build | `bun-version` set, `typescript` not false |
| just &lt;recipe&gt; | one job per entry of `recipes` | `recipes` not empty |
| browser journeys (running: `browser journeys (1)`, one per shard) | `just <browser>`, one job per shard: the recipe selects the journeys the change needs; Chromium's download is cached, the Playwright report uploaded on failure | `browser` set |
| build the image | builds the image beside the checks, for every platform: a pull request exports it to a tarball, a push pushes it by digest, untagged | `hot-path-seconds` set; pull requests, pushes to the default branch, `v*` tags |
| check / lint, test, e2e, vulncheck | fails when any job above failed or was cancelled, or when a job that `browser` or `hot-path-seconds` enables did not succeed: the one check for branch protection to require. On a hot path run its last step, `Hot path budget`, judges the run (see "Hot path") | always |
| pipeline budget | prints every job's time and fails when the pipeline took longer than its budget plus the margin | a budget set, `hot-path-seconds` not set, not on `full` runs |
| publish badges | pushes the badges to the `badges` branch | pushes to the default branch |
| build, attest and push the image | without `hot-path-seconds`: builds the image after the checks and pushes it with its tags; with it: tags and attests the digest `build the image` pushed. Private repositories get no attestation | pushes to the default branch and `v*` tags |

### Inputs

| Input | Default | |
|-------|---------|---|
| `image` | required | image repository, e.g. `ghcr.io/govengers/example` |
| `dockerfile` | `docker/server.Dockerfile` | |
| `platforms` | `linux/amd64,linux/arm64` | |
| `e2e` | `true` | run the end-to-end job |
| `full` | `false` | every test uncached; extra recipes see `FULL=true`; no budget. The starter sets it for the nightly schedule and for `v*` tags |
| `golangci-lint-version` | `v2.15.0` | installed in the lint job and the recipe jobs |
| `bun-version` | `""` | Bun on the `PATH` of every job and the TypeScript job; empty installs no Bun |
| `typescript` | `true` | with `bun-version`, run the TypeScript job; `false` when Bun only serves a tool, e.g. squawk in a recipe |
| `recipes` | `""` | extra recipes as a JSON array, e.g. `'["generate-check", "db-check"]'`; each job checks out the full history and sees `BASE_REF`, the pull request's base branch, for checks against it |
| `budget-warm-seconds` | `0` | the pipeline's budget when the test job restored a cache of the same Go release and `go.sum`; `0` sets none |
| `budget-cold-seconds` | `0` | the budget without such a cache |
| `budget-margin-percent` | `20` | overrun tolerated before the budget fails |
| `hot-path-seconds` | `0` | hot path mode and its cap, at most `600` (TST-018, see "Hot path"); `0` keeps the pipeline above |
| `browser` | `""` | the justfile recipe of the browser journeys, e.g. `ui-e2e`, in a job per shard; empty runs none |
| `browser-shards` | `1` | Playwright shards, `1` to `8`, one job each; the recipe sees `SHARD=<n>/<browser-shards>` |

Every recipe sees `FULL`; the recipe jobs see `BASE_REF`; the recipe and browser jobs see `BASE_SHA`, the commit to compare the checkout with (the pull request's base commit, or the commit before the push); a browser job sees `SHARD`, e.g. `1/2`.

The caller grants `contents: write` (badges), `packages: write`, `id-token: write` and `attestations: write`, and with a budget or `hot-path-seconds` `actions: read`: the budget job and `check` read the run's job times from the API.

The caller's `ci.yml` puts every run in one concurrency group per ref and event, `ci-${{ github.ref }}-${{ github.event_name }}`, so a full run and a push of the same branch do not wait for each other.

### Hot path

A caller that sets `hot-path-seconds`, e.g. `600`, holds every pipeline that gates a deployment to that many seconds (standards TST-018):

- **Hot path run:** a pull request, or a push to the default branch. Nothing else decides it: `full: true` on such a run still gets the cap and the short timeouts. Scheduled and dispatched runs and `v*` tags are full runs, outside the cap.
- **Span:** from the run's `run_started_at` to the last step of `check`, the required check. `check` needs every job and, on a push, the tag job, so the span ends with the check result on a pull request and with the pushed tags on the default branch. Every wait counts: for runners, for the image job's turn, for `check`'s own runner. No bound on waiting is claimed; the summary shows each job's runner, queue and run seconds, so a breach reads as "the pipeline grew" or as "the runners were busy".
- **Cap:** `hot-path-seconds`, at most 600 (a higher value fails), no margin. A pull request gets 60 s less: the push of the same commit also pushes the image, saves the compile cache and tags, and a pull request must predict that run. A pull request builds and exports the image for every platform, so compile and compression are inside its measurement.
- **Blocking:** the verdict is a step of `check`, so a pull request over the cap cannot merge, and no job can be skipped around it. On the default branch the image is out when the verdict falls; the red run is the alarm.
- **Early warning:** `budget-warm-seconds` and `budget-cold-seconds` with their margin are judged by the same step over the same span (cold when the unit test job or `build the image` found no cache of its kind); the separate `pipeline budget` job does not run.
- **Timeouts:** every job that runs the repository's code times out after 10 minutes on a hot path run and after 60 on any other run, `check` after 5. They end a hung job; they are no run deadline, and no input changes them.
- **Re-runs:** an attempt in which every expected job ran again (each job that was not skipped, every recipe, every shard) is judged like a first one. A partial re-run repeats the verdict of the attempt before only when every job of that attempt passed and its time was within the cap, e.g. a re-run of the tag job of a green run. After a failed job ("re-run failed jobs"), a cancelled run or a broken budget, a partial re-run fails: the earlier time is no measurement of the whole pipeline, so re-run all jobs.
- **Image:** `build the image` runs beside the checks; on a push it pushes by digest, and `build, attest and push the image` tags that digest only after every check passed, so nothing deploys an image whose checks failed. The branch tag (`:main`) moves only when the branch head still is the run's commit, so a re-run of an older run cannot point it back; the `sha-` tag is always written. The lever when the cap is tight: `platforms: linux/amd64` on the default branch and both platforms on tags (the input takes an expression).

### Nightly alert

[`.github/workflows/nightly-alert.yml`](.github/workflows/nightly-alert.yml) turns a red scheduled or dispatched run into an issue (TST-021): labelled `nightly-ci`, titled `<workflow> is red on <ref>`, assigned to the logins in `assignees`. Every further red run comments on it and reconciles its assignees; the first later green run of the same workflow and ref closes it. An older run that finishes late neither closes the issue nor opens a new one that a newer green run closed (runs compare by number, then attempt); when the newer green run found no issue to close, a late older red run still opens one, and the next green full run closes it. The alert job has one concurrency group per workflow and ref, which keeps one pending job: three alerts of one workflow and ref within seconds of each other can drop the middle one. The job fails, red run or green, when a login cannot be assigned or the open issue has no assignee: a red run would reach nobody. A second job of the caller's `ci.yml` calls it:

```yaml
  alert:
    needs: service
    if: ${{ always() && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') }}
    uses: govengers/.github/.github/workflows/nightly-alert.yml@<commit>
    with:
      result: ${{ needs.service.result }}
      assignees: ${{ vars.CI_ALERT_ASSIGNEES }}
    permissions:
      issues: write # the issue of a red full run
      actions: read # its failed jobs
```

Until the `v1` tag carries this workflow, `<commit>` is a commit of main that does; the snippet moves to `@v1` with the tag. `CI_ALERT_ASSIGNEES` is a variable of the org or, for a private repository on GitHub Free, of the repository.

### Caches

Every Go job restores its own cache, keyed on the installed Go release and `go.sum`: the Go build and test cache, the module cache, embedded PostgreSQL's download and unpacked binaries (the children of `~/.embedded-postgres-go` except `*-test`, where a service keeps its running test server's data, and except `postgrestest`, postgrestest's server state: on the self-hosted runners it is a mount, tar cannot restore over a mount point it does not own, and the whole restore would fail, leaving every job cold) and golangci-lint's cache. Pushes to the default branch save them; a pull request saves only when it found no cache of its Go release and `go.sum`, so its next push is warm without crowding the default branch's caches out. The e2e job carries `sandbox/e2e-passed`, the records of green runs, like `go-library.yml`.

With `hot-path-seconds`:

- The lint, recipe and browser jobs carry their green-run records (`sandbox/*-passed`, e.g. `vulncheck-passed`, `derive-passed`), one key per job and shard, so a recipe that skips what equals a green run (TST-015) skips in CI too. Without `hot-path-seconds` these jobs carry no records, so their recipes run in CI as before.
- `build the image` carries the Go compile cache of the Dockerfile's cache mount (`--mount=type=cache,target=/root/.cache/go-build`, as in the service template) as an `actions/cache` entry (`sandbox/image-mounts`, which the service template's `.dockerignore` keeps out of the build context): copied into the builder before the build, copied out and saved afterwards, with the save rule of the Go caches. A Dockerfile without that mount builds as before, uncached. No layer cache (`type=gha`): its export cost 111 to 183 s per run and missed anyway once the repository's cache quota evicted its blobs (design S10).

With `browser`, the browser jobs carry Chromium's download (`~/.cache/ms-playwright`, keyed on `bun.lock`); the recipe installs the browser.

## Runners

Both workflows run the jobs that execute the repository's code (library: the one check job; service: lint, unit tests, e2e, TypeScript, extra recipes, browser journeys and the image build) on the runs-on label in the caller's `CI_RUNNER` variable, and on `ubuntu-latest` when it is unset. The govengers org sets `CI_RUNNER=fuji-govengers`, the self-hosted runners on the fujis cluster; unset it to fall back to GitHub's runners. GitHub Free does not share org variables with private repositories, so a private repository sets its own `CI_RUNNER`. A pull request from a fork always runs on `ubuntu-latest`: a self-hosted runner never runs code of an outside fork. The aggregate jobs (check, budget, badges) stay on `ubuntu-latest`, except `check` with `hot-path-seconds`: it judges the hot path and runs on the runner kind of the checks, so no second kind of runner sits in the span it measures. The nightly alert runs on `CI_RUNNER` too; neither needs `gh` or `jq` on the runner.

## Versioning

Libraries and services call `@v1`. Backward-compatible changes move the `v1` tag; a change to the contract above is `v2`. New inputs with defaults that keep the old behaviour and new jobs are backward compatible. Check names are not part of the contract and may change under `v1`, except one per workflow that branch protection can require: `go-service / check / lint, test, e2e, vulncheck` for services (the caller's job id first), `go-library / lint, test, e2e, vulncheck` for libraries.

What a service that sets none of `hot-path-seconds`, `browser` and `browser-shards` sees of the hot path change, all of it: `check` reports after the image job on a push to the default branch or a tag, with the same result as before (pull requests: no difference), `check` no longer declares empty permissions, the two new jobs show as skipped checks (`browser journeys`, `build the image`), as the end-to-end job does with `e2e: false`, and the recipes see two more environment variables: `BASE_SHA` in the recipe jobs, `RECORDS_JOB` in the lint and recipe jobs (harmless unless a recipe already reads a variable of that name). The image build, the `pipeline budget` job, the e2e job's records, the job names and every other step are unchanged, and the new record steps do not run. A library without `budget-seconds` sees one new step, `Start the budget clock`, and no other change.

Pull requests here run [actionlint](.github/workflows/actionlint.yml) and the tests of the `github-script` steps against fakes of the GitHub API (`node --test test/github-scripts.test.mjs`, with `yq` on the `PATH`). A change to a reusable workflow is verified by a throwaway draft pull request in a library that points its `ci.yml` at the branch (`uses: govengers/.github/.github/workflows/<file>@<branch>`), closed without merging.
