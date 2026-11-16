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

### Only what changed is tested

- The workflow restores the newest Go build and test cache saved on main (setup-go's own cache is off: it is keyed on `go.sum` alone and never refreshed). `go test` then reruns only the packages whose test binary changed (TST-014). Only pushes to main save the cache, so pull requests cannot crowd it out of the cache quota.
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
| check / lint, test, e2e, vulncheck | fails when any job above failed or was cancelled: the one check for branch protection to require | always |
| pipeline budget | prints every job's time and fails when the pipeline took longer than its budget plus the margin | a budget set, not on `full` runs |
| publish badges | pushes the badges to the `badges` branch | pushes to the default branch |
| build, attest and push the image | as above; private repositories get no attestation | pushes to the default branch and `v*` tags |

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
| `budget-warm-seconds` | `0` | the pipeline's budget when the test job restored a cache of the same `go.sum`; `0` sets none |
| `budget-cold-seconds` | `0` | the budget without such a cache |
| `budget-margin-percent` | `20` | overrun tolerated before the budget job fails |

The caller grants `contents: write` (badges), `packages: write`, `id-token: write` and `attestations: write`, and with a budget `actions: read`: the budget job reads the run's job times from the API.

### Caches

Every Go job restores its own cache, keyed on the installed Go release and `go.sum`: the Go build and test cache, the module cache, embedded PostgreSQL's download and unpacked binaries (the children of `~/.embedded-postgres-go` except `*-test`, where a service keeps its running test server's data) and golangci-lint's cache. Pushes to the default branch save them; a pull request saves only when it found no cache of its `go.sum`, so its next push is warm without crowding the default branch's caches out. The e2e job carries `sandbox/e2e-passed`, the records of green runs, like `go-library.yml`.

## Versioning

Libraries and services call `@v1`. Backward-compatible changes move the `v1` tag; a change to the contract above is `v2`. New inputs with defaults that keep the old behaviour and new jobs are backward compatible. Check names are not part of the contract and may change under `v1`, except one per workflow that branch protection can require: `go-service / check / lint, test, e2e, vulncheck` for services (the caller's job id first), `go-library / lint, test, e2e, vulncheck` for libraries.

Pull requests here run [actionlint](.github/workflows/actionlint.yml). A change to a reusable workflow is verified by a throwaway draft pull request in a library that points its `ci.yml` at the branch (`uses: govengers/.github/.github/workflows/<file>@<branch>`), closed without merging.
