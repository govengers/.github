# govengers/.github

Shared GitHub configuration for the govengers org: the [org profile](profile/README.md), the reusable CI workflow for Go libraries and its starter template.

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
| `just test` | unit tests with `-race`, fails below the coverage threshold (TST-010) | `sandbox/unit.json` (`go test -json`), `sandbox/unit.cover` |
| `just test-e2e` | end-to-end tests behind the `e2e` build tag (TST-011) | `sandbox/e2e.json` |
| `just vulncheck` | `govulncheck` in text mode (TCH-008) | |

`gotestsum --jsonfile` gives readable output and the JSON file in one run; a library pins it with `go run gotest.tools/gotestsum@<version>` (TCH-002).

### Inputs

| Input | Default | |
|-------|---------|---|
| `golangci-lint-version` | `v2.11.4` | the release `just lint` runs |
| `e2e` | `true` | run `just test-e2e` |
| `badges` | `true` | publish badges on pushes to the default branch |

### Badges

On every push to the default branch the workflow force-pushes three [shields.io endpoint](https://shields.io/badges/endpoint-badge) files to the `badges` branch of the library:

```markdown
[![CI](https://github.com/govengers/<repo>/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/govengers/<repo>/actions/workflows/ci.yml)
![unit tests](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/govengers/<repo>/badges/unit-tests.json)
![e2e tests](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/govengers/<repo>/badges/e2e-tests.json)
![coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/govengers/<repo>/badges/coverage.json)
```

## Versioning

Libraries call `@v1`. Backward-compatible changes move the `v1` tag; a change to the contract above is `v2`.
