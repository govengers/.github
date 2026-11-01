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
| `just test-all`, `just test-e2e-all` | only with `full: true`: every test, uncached | as above |

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

[`.github/workflows/go-service.yml`](.github/workflows/go-service.yml) runs the checks of `go-library.yml` and then, on a push to main or a `v*` tag, builds the image from the service's Dockerfile for amd64 and arm64, attests its provenance and pushes it: `:main` on main, `:1.2.3` on a tag, and `:1.2`, `:1` and `:latest` only when the tag is the newest release they cover. Inputs: `image` (required), `dockerfile` (`docker/server.Dockerfile`), `platforms`, `e2e`, `full`, `golangci-lint-version`. The caller grants `contents: write`, `packages: write`, `id-token: write` and `attestations: write`; see the starter in [workflow-templates/go-service.yml](workflow-templates/go-service.yml) and the service template in [govengers/standards](https://github.com/govengers/standards/tree/main/templates/service).

## Versioning

Libraries and services call `@v1`. Backward-compatible changes move the `v1` tag; a change to the contract above is `v2`.
