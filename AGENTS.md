# WeLink Office Agent Repository Contract

## Read this first

This repository root is the complete, portable `welink-office-agent` Skill package. `SKILL.md` is the canonical cross-Agent entrypoint; do not add a nested `.claude/skills/`, `.codex/skills/`, or other host-specific copy inside this repository.

Before editing, read only the guide(s) matching the touched area. The linked guides are mandatory for that scope, not optional background reading.

| Change scope | Required guide |
| --- | --- |
| `SKILL.md`, `scripts/`, `references/`, `config/`, runtime behavior | [Skill 与 Runtime](docs/agent-guides/skill-runtime.md) |
| `server/`, HTTP routes, DTOs, SSE, API security | [Skill 与 Runtime](docs/agent-guides/skill-runtime.md) + [前后端对接设计](docs/frontend-backend-integration.md) |
| `web-console/`, routes, UI behavior, visual work | [Web Console](docs/agent-guides/web-console.md) |
| README, docs, schemas, commands, layout or behavior changes | [文档同步](docs/agent-guides/documentation.md) |
| Code review or files under `docs/reviews/` | [文档同步](docs/agent-guides/documentation.md) + [质量门禁](docs/agent-guides/quality-gates.md) |
| Any implementation or file move before handoff | [质量门禁](docs/agent-guides/quality-gates.md) |

Cross-layer work must read every applicable guide plus [前后端对接设计](docs/frontend-backend-integration.md).

## Repository index

```text
.
├── SKILL.md                 # portable Skill entrypoint and workflow
├── scripts/                 # executable CLI and runtime implementation
├── server/                  # local Console API: DTO read models, command inbox, SSE
├── references/              # on-demand command and runtime references
├── config/                  # tracked examples; active local config is ignored
├── runtime/                 # generated local state; only .gitkeep is tracked
├── web-console/             # React console, tests, and vendored GrokBot
├── test/                    # root runtime/CLI/API integration tests
├── docs/
│   ├── agent-guides/        # scoped implementation constraints
│   ├── design-reference/    # read-only visual specifications
│   ├── reviews/             # dated, branch-specific review results
│   ├── frontend-backend-integration.md
│   ├── ui-implementation-outline.md
│   └── ui-implementation-spec.md
├── README.md                # current user setup and operation guide
└── AGENTS.md                # this router and repository-wide invariants
```

When a top-level directory or public entrypoint changes, update this index in the same change.

## Code review contract

Save durable reviews under `docs/reviews/` using a kebab-case name such as `2026-08-30-main-review.md`. Every saved review must start with this identifying metadata:

```text
Branch: <branch name at review time>
Review range: <base commit>..<reviewed commit>
Reviewed at: <ISO 8601 timestamp with timezone>
Verdict: <approve | request changes | informational>
```

Formal findings are reserved for problems with repair value. Each finding must identify concrete code or test evidence, a realistic trigger within documented usage, a material impact, and a practical fix or verification path. Do not add findings to fill a quota, elevate harmless style preferences, or treat speculative and exceptionally rare benign cases as blockers. Put non-blocking observations in a separate section or omit them.

A low-frequency issue may remain a finding when its impact is severe, such as data loss, wrong reply attribution, security exposure, or duplicate external actions. State its prerequisites explicitly and distinguish release blockers from deferred hardening, so readers can judge probability and impact separately.

## Repository-wide invariants

- Preserve unrelated user changes and existing runtime behavior.
- Never commit active configuration, messages, raw CLI output, task snapshots, or credentials.
- Do not edit or ship files from `docs/design-reference/` as runtime assets.
- All WeLink actions go through the shared wrapper; persist external actions before execution and verify unknown results before retrying.
- `web-console/` never reads `runtime/` or active `config/` directly and never calls `welink-cli`; it talks to the Console API only.
- `server/` binds to loopback by default, exposes only `/api/v1`, reuses `scripts/lib/` services for every state change, never spawns `node scripts/agent.mjs` for writes, and never returns runtime paths, CLI output, or `w3account`. Server route schemas are the single source of the HTTP contract mirrored in `web-console/src/api/contracts.ts`.
- Console writes that need Agent reasoning or WeLink sends become persisted commands in `runtime/commands/` consumed by `tick`; the API performs only deterministic changes (pause, cancel, status, decision records) under lock and revision checks.
- Root tasks may run concurrently, but active private conversations with the same contact remain serialized until reply attribution is durable.
- Documentation changes with implementation, in the same change. In particular, user-facing behavior/setup changes require README review; repository layout/boundary changes require AGENTS review; Skill workflow changes require SKILL review.
- `scripts/agent.mjs` is the single public Node.js entry used by package scripts, installers, tests, SKILL instructions, and command reference.
