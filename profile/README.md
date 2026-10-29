<p align="center"><img src="https://raw.githubusercontent.com/govengers/.github/main/profile/gophers-assemble.jpg" alt="Go gophers assemble" width="800"></p>

# govengers

Boring, well-tested Go libraries for building web services: configuration, authentication, caching, logging, real-time APIs and AI tooling. Every library follows the same [standards](https://github.com/govengers/standards) and runs the same CI.

## Libraries

| Library | What it does |
|---------|--------------|
| [config](https://github.com/govengers/config) | Environment-based configuration: declared once, validated at startup, bound into one struct |
| [cache](https://github.com/govengers/cache) | Generic, type-safe caching: local, Redis and synchronized two-layer caches, plus leader election |
| [wide-event-logger](https://github.com/govengers/wide-event-logger) | Wide event logging: one rich, structured event per unit of work |
| [basicauth](https://github.com/govengers/basicauth) | Session authentication with Argon2id, TOTP and backup codes |
| [oidc-auth](https://github.com/govengers/oidc-auth) | OpenID Connect login and forward authentication |
| [github-auth](https://github.com/govengers/github-auth) | GitHub OAuth login and forward authentication |
| [auth](https://github.com/govengers/auth) | One authentication and authorization library (in progress; supersedes basicauth, oidc-auth and github-auth) |
| [livewire](https://github.com/govengers/livewire) | Declare an API once: REST routes, live WebSocket subscriptions from Postgres, a generated TypeScript client |
| [aikido](https://github.com/govengers/aikido) | Provider-agnostic AI inference: chat, tool calling, virtual file system, agent loops |

## How we build

- [standards](https://github.com/govengers/standards): how we write Go. Principles, graded rules and playbooks; the source of truth for people and coding agents.
- Every library uses the reusable workflow in [govengers/.github](https://github.com/govengers/.github): lint, race-tested unit tests with a coverage gate, end-to-end tests, vulnerability scan and badges.
