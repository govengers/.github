# Design decisions

Numbered decisions behind the reusable workflows. A new decision takes the next free number; a changed
one is rewritten in place.

## S1 go-service.yml runs its checks in parallel jobs, compatibly with v1

`go-service.yml` used to call `go-library.yml`: one job ran lint, unit tests, end to end and vulncheck in
sequence. It now runs them as parallel jobs (lint and vulncheck, unit tests, end to end, TypeScript, one
job per extra recipe), so the pipeline takes as long as its slowest job instead of the sum. Every v1 input
keeps its name, type and default, and a v1 caller needs no new permission, so the change ships under `v1`
(the owner moves the tag). What a v1 caller sees change: the check names (`go-service / unit tests`
instead of `go-service / check / lint, test, e2e, vulncheck`), and the image job runs only on pushes to
the default branch and `v*` tags, which is what the v1 starter triggers anyway. `go-library.yml` keeps
its single job: a library's pipeline is short, and one runner saves a cache restore per job.

## S2 One cache per job, setup steps shared by YAML anchors

The jobs build different things (race-instrumented tests, the coverage build of the e2e suite, lint), so
each restores and saves its own cache (`go-<job>-<os>-<go minor>-<go.sum hash>-<sha>`): the Go build and
test cache, the module cache, the children of `~/.embedded-postgres-go` except `*-test` (a service's
running test server keeps its data, and a `postmaster.pid` that refuses the next start, under such a
directory; an excluded path inside an included directory would still land in the archive) and
golangci-lint's cache. Pushes to the default branch save; a pull request saves only when it restored
no cache of its `go.sum` (a cold run, typically a dependency update), so its next push is warm, and
pull requests do not crowd the default branch's caches out of the quota. The setup steps are written
once, in the lint job, and aliased in the others: a reusable workflow cannot use a local composite action
of its own repository (`./` is the caller's checkout), and referencing one by tag would run the tag's
version from a branch under test.

## S3 The budget job reads job times from the API and takes the caller's grant

The budget job prints every job's time and fails when the run, from its start to the budget job, took
longer than `budget-<warm|cold>-seconds` plus `budget-margin-percent`. Warm means the unit test job
restored a cache of the same `go.sum`. It reads `run_started_at` and the jobs of the run attempt from the
API, which needs `actions: read` on private repositories. The job declares no `permissions`: a job of a
called workflow that declares a permission the caller did not grant fails the whole run at startup, even
when the job would be skipped (verified 16.11.2026 on a probe pull request), which would break every v1
caller. Without a declaration the job takes the caller's grant; it checks out nothing and runs only the
workflow's own script, so the wider token reaches no code of the calling repository. A caller that sets a
budget grants `actions: read`; without it the job fails with that hint. Job outputs instead of the API
would need no permission, but cannot report the time of each matrix job, and miss the queue time.
Budgets default to 0 (none), so a slow v1 caller does not start failing; full runs are uncached and
have no budget.

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
Go job, as in `go-library.yml`.

## S6 Badges from the jobs that ran the tests

The unit test job writes the unit test and coverage badges (it has the Go toolchain for
`go tool cover`), the e2e job the e2e badge; each uploads them with its JSON report, and the badges job
collects them on pushes to the default branch. Without the e2e job the badges branch carries no e2e
badge, as with `go-library.yml`.

## S7 No attestation on private repositories

GitHub stores build provenance attestations for public repositories only (private ones need GitHub
Enterprise Cloud), so the attestation step is skipped when the repository is private, and the image is
still pushed. The image job still declares `id-token: write` and `attestations: write`, so a private
caller grants them too: a job's permissions cannot depend on the repository's visibility.
