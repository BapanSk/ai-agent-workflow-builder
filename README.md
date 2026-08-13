# Multi-tenant SaaS foundation (Hasura + PostgreSQL)

A multi-tenant backend foundation built on **Hasura GraphQL Engine** and
**PostgreSQL**. Data is isolated at the **organization** level: a user acting in
Org A can never read or write Org B data, enforced both at the database layer
(denormalized `organization_id` + composite foreign keys) and at the GraphQL
layer (Hasura row-level permissions).

```mermaid
graph TD
    A["Client / Frontend"]
    B["Auth webhook (session vars)"]
    C["Hasura GraphQL Engine"]
    D["PostgreSQL"]
    A --> B
    A --> C
    C --> D
    B --> C
```

## Tech stack

- **Hasura GraphQL Engine** `v2.42.0` (metadata in `metadata/`, SQL migrations
  in `migrations/`)
- **PostgreSQL 15**

## Project structure

```
.
├── config.yaml                    # hasura CLI configuration
├── docker-compose.yml             # local dev: postgres + hasura + actions handler + web
├── .env.example
├── actions-handler/               # Node.js webhook for Hasura Actions
│   ├── src/                       #   db, expr (templates), workflow engine, handlers, server
│   └── test/                      #   unit tests (node --test)
├── frontend/                      # Next.js app + GraphQL reverse proxy (port 3000)
│   ├── server.js                  #   custom Next server; proxies /v1/graphql HTTP+WS + /webhook
│   ├── lib/                       #   session, GraphQL client, query definitions
│   ├── app/                       #   login, dashboard, workflow builder pages + auth API
│   ├── components/                #   NavBar, QuotaIndicator, StepEditor, RunPanel
│   └── Dockerfile
├── migrations/
│   └── default/
│       ├── 20240809000000_init/   # schema + triggers + indexes
│       ├── 20240809000100_seed/   # Org A / Org B demo data
│       ├── 20240809000200_workflows/  # workflow tables + org quotas
│       ├── 20240809000300_workflow_seed/ # seed workflows
│       ├── 20240809000400_workflow_v2/  # new step types + workflow_events/notifications
│       ├── 20240809000500_ai_release_workflow/ # AI Release demo workflow (webhook-triggered)
│       └── 20240809000800_org_roles_owner_editor_viewer/ # owner/editor/viewer org roles, canonical step types, restricted-step guard
└── metadata/
    ├── version.yaml
    └── databases/
        ├── databases.yaml         # source configuration
        └── default/
            ├── tables/            # per-table metadata: relationships + permissions
            ├── actions.yaml       # Hasura Actions definitions
            └── actions.graphql    # action + custom type SDL
```

## Database schema

| Table                  | Tenant-scoped | Notes |
|------------------------|:---:|-------|
| `organizations`        | n/a | Root tenant entity; also `quota_concurrent_runs` / `quota_monthly_runs` |
| `users`                | no  | Global identity, membership via `organization_members` |
| `organization_members` | yes | `role` in `owner` / `editor` / `viewer` |
| `invitations`          | yes | Invites, unique per org+email while pending |
| `projects`             | yes | Example tenant-scoped entity; project roles `owner`/`editor`/`viewer` |
| `project_members`      | yes | Child of `projects`; creator auto-inserted as `owner` via trigger |
| `tasks`                | yes | Child of `projects`; writable by project `owner`/`editor` |
| `workflows`            | yes | JSON `steps` definition, org-scoped |
| `workflow_runs`        | yes | One run per trigger; status machine + quotas |
| `workflow_run_steps`   | yes | Materialized per-step state (attempts, approval) |
| `workflow_events`      | yes | Append-only event log written by the `db_write` step |
| `notifications`        | yes | Org-scoped notifications written by the `notify` step |

Every tenant-scoped table carries `organization_id`. Child tables
(`project_members`, `tasks`) additionally hold a **composite foreign key**
`(organization_id, project_id) -> projects(organization_id, id)`, so a row can
never reference a project owned by another organization, even if an insert tries
to mix org ids.

## Session variables (JWT claims)

Authentication is Nhost-style: the frontend login route (`/api/auth/login`)
looks the user up with the admin secret, then mints a signed HS256 JWT
(`frontend/lib/jwt.js`) carrying the `https://hasura.io/jwt/claims`. Hasura is
started with `HASURA_GRAPHQL_JWT_SECRET` (same key as the frontend's
`AUTH_JWT_SECRET`) and derives the session from the token — clients can never
forge `X-Hasura-*` headers.

| Claim | Type | Purpose |
|-------|------|---------|
| `x-hasura-default-role` | string | One of `user`, `viewer`, `editor`, `owner` |
| `x-hasura-user-id` | uuid | The authenticated user |
| `x-hasura-organization-id` | uuid | Active organization for `viewer`/`editor`/`owner` |
| `x-hasura-allowed-organizations` | string | PostgreSQL array literal, e.g. `{uuid1,uuid2}` — orgs the user belongs to; used by the read-only `user` role |

> **Note on `x-hasura-allowed-organizations`:** Hasura treats `_in` array session
> variables as a PostgreSQL array literal, so the JWT claim carries
> `{uuid1,uuid2}` (not JSON `["uuid1"]`).

## Roles and permissions

| Capability | `user` | `viewer` | `editor` | `owner` |
|-----------|:---:|:---:|:---:|:---:|
| Read own profile | yes | - | - | - |
| Read orgs / tenant data (within allowed orgs) | read-only | yes | yes | yes |
| Create / update / delete workflows | - | no | yes | yes |
| Trigger runs / approve gates | - | no | yes | yes |
| Manage organization members / settings | - | read | read | read/write |
| Invitations | - | read | read | read/write |
| Create projects | - | - | - | yes |
| Update / delete projects | - | - | - | yes |
| Manage project members | - | - | - | yes |

`user` is a read-only "switcher" role (no org context). `viewer`, `editor`,
`owner` operate strictly inside `X-Hasura-Organization-Id`. On insert,
`organization_id` (and `created_by`/`invited_by`) are **preset from the session**
and guarded by a `check` so a client can never claim another org.

> **Restricted-step guard:** the workflow engine enforces a second layer on top
> of metadata. `db_write` and `notify` steps (which write `workflow_events` /
> `notifications` rows) are only executable when the run is triggered by an
> `owner`, and `workflow_events` / `notifications` row mutation via GraphQL is
> limited to `owner` too. `editor` can create/edit workflows and trigger runs,
> but triggering a workflow that contains restricted steps is rejected up front
> with `forbidden` (only the owner may run it). This is checked in the handler
> (`hasRestrictedSteps` + `sessionRole !== 'owner'`) and, at the save boundary,
> in the DB (`workflows_restricted_steps_guard` trigger rejects non-owner
> inserts/updates of workflows containing `db_write`/`notify`).

### Project roles (`owner` / `editor` / `viewer`)

Project-level access is enforced **in metadata**, via nested filters on the
`project.members` relationship, so no engine/handler changes are required:

| Project role | Read project + tasks | Write tasks | Manage project / members |
|--------------|:---:|:---:|:---:|
| `owner` | yes | yes | yes |
| `editor` | yes | yes | no |
| `viewer` | yes | no | no |

- Membership rows live in `project_members` (`role` is `owner`/`editor`/`viewer`,
  default `viewer`). The project creator is automatically made `owner` by a DB
  trigger (`20240809000700_project_owner_trigger`).
- `owner` bypasses project roles and sees the whole org.
- Rows from other projects (or other orgs) are invisible: every select/update
  filter requires the current user to be a member of the project's
  `project_members`, and writes additionally require `owner` (projects,
  `project_members`) or `owner`/`editor` (tasks).

## Workflows & Hasura Actions

Workflows are org-scoped JSON definitions stored in `workflows.steps`. Runs are
started and resumed through the Node.js handler in `actions-handler/`:

| Trigger | Roles / Auth | Purpose |
|---------|--------------|---------|
| `triggerWorkflowRun(input: TriggerWorkflowRunInput!): WorkflowRunOutput` (Hasura Action) | `editor`, `owner` | Validate role/membership, check quotas, create the run, execute steps |
| `approveStep(input: ApproveStepInput!): WorkflowRunOutput` (Hasura Action) | Roles in the step's `approver_roles` (default `owner`, `editor`) | Approve/reject an `awaiting_approval` gate; resumes or cancels the run |
| `POST /webhook/trigger` (plain HTTP) | `x-webhook-token: <WEBHOOK_TOKEN>` header | External systems trigger a workflow by organization (slug/id) + workflow (name/id) |

The two Actions are the **only** creation paths through GraphQL (no insert
permission on `workflow_runs`), so clients can't bypass membership or quota
checks. The webhook is a server-to-server integration point guarded by a shared
secret; it never exposes the admin secret.

### Webhook trigger

```bash
# Runs the "AI Release" workflow in Org A with some input
curl -X POST http://localhost:8080/webhook/trigger \
  -H 'content-type: application/json' \
  -H 'x-webhook-token: <WEBHOOK_TOKEN>' \
  -d '{"organization":"org-a","workflow":"AI Release","input":{"app":"checkout","risk":"critical"}}'
```

- `organization` is resolved by slug or UUID; `workflow` by name or UUID within
  that organization.
- The handler runs the same quota-checked, transaction-locked
  create-and-execute path as the GraphQL action (`trigger_type = 'webhook'`).
- If `WEBHOOK_TOKEN` is unset the endpoint returns `503 webhook_disabled`.
- The frontend proxies `/webhook/trigger` on the same port, so the preview host
  can trigger workflows without exposing port 4000.

### Scheduled (cron) triggers

Hasura Cron Triggers (metadata/cron_triggers.yaml) call the same
token-guarded `/webhook/trigger` endpoint on a schedule:

| Trigger | Schedule | Payload | Purpose |
|---------|----------|---------|---------|
| `scheduled_ai_release` | `0 * * * *` (hourly) | `{organization: "org-a", workflow: "AI Release", input: {risk: "low", scheduled: true}}` | Runs a low-risk release automatically every hour |

- The header `x-webhook-token` is populated from the engine's `WEBHOOK_TOKEN`
  env var, so the handler enforces the same secret as manual webhook calls.
- The handler unwraps the Hasura cron envelope (`body.payload`), so cron runs go
  through the identical create-and-execute path (`trigger_type = 'cron'`).
- Executed runs are visible in `hdb_cron_events` (engine system schema) and as
  normal `workflow_runs` rows; missed schedules respect the engine's retry
  config. Prefer a cadence that fits the org's `quota_monthly_runs`.

### Step JSON schema

A `workflows.steps` value is an array of step objects. Supported `type` values:

| Type | Fields | Behavior |
|------|--------|----------|
| `task` | `name`, `max_attempts`, `retry_delay_seconds`, `fail_first_n`, `force_fail`, `fail_rate` | Simulated work; retries up to `max_attempts`; `fail_first_n` fails the first N attempts; `force_fail` always fails (with `fail_message`) |
| `sleep` | `duration_seconds` | Pauses execution |
| `llm` | `prompt`, `model` | Calls a chat-completions endpoint (`USER_LLM_BASE_URL` + `USER_LLM_API_KEY`); with no key configured it runs a deterministic simulated classifier that returns `{ simulated, severity }` |
| `http` | `method`, `url`, `headers`, `body`, `timeout_seconds` | Outbound HTTP request (GET/POST/PUT/PATCH/DELETE); output is `{ status, body }`; only `http(s)` URLs allowed |
| `condition` | `expression` | Evaluates an expression against the run context; output is `{ result, expression }` |
| `approval` | `approver_roles` | Stops the run as `awaiting_approval`; `approveStep` resumes it |
| `db_write` | `table`, `event_type`, `data` | Inserts into an allow-listed table (`workflow_events`, `notifications`); org/run/workflow ids are forced server-side; restricted to `owner`-started runs |
| `notify` | `title`, `body` | Inserts a row into `notifications`; restricted to `owner`-started runs |

These types are the **canonical vocabulary** for this repository (migration
`20240809000800_org_roles_owner_editor_viewer` backfills every existing
workflow to it); earlier migrations' types are accepted only as aliases and
normalized on write.

**Conditional branches** — any step may carry a `when` expression. If it
evaluates falsy, the step is marked `skipped` and execution continues (e.g.
skip the approval gate for low-risk releases):

```json
{"type": "approval", "name": "Manager approval", "when": "steps[\"Requires approval?\"].result == true"}
```

**Templates** — string fields support `{{ expr }}` interpolation against the
run context: `input.<field>`, `steps["<step name>"].<output field>`,
`outputs[<index>].<field>`, `env.HANDLER_BASE_URL`, `env.USER_LLM_MODEL`, and
`prev.<field>` (last completed output). Examples:
`{"type":"notify","title":"Release {{input.app}} assessed","body":"Severity {{steps[\"Assess release risk\"].severity}}"}`.

Example:

```json
[
  {"type": "task", "name": "Prepare build", "max_attempts": 2},
  {"type": "sleep", "duration_seconds": 1},
  {"type": "condition", "name": "Requires approval?", "expression": "input.risk == \"critical\""},
  {"type": "approval", "name": "Manager approval", "when": "steps[\"Requires approval?\"].result == true"},
  {"type": "db_write", "table": "workflow_events", "event_type": "release.assessed", "data": {"app": "{{input.app}}", "severity": "{{input.risk}}"}},
  {"type": "notify", "title": "Release {{input.app}} assessed", "body": "Risk {{input.risk}}"}
]
```

### Quotas

`organizations.quota_concurrent_runs` (default 5) caps runs in
`queued`/`running`/`paused`/`awaiting_approval`; `quota_monthly_runs` (default
100) caps runs created in the current calendar month. Both are enforced inside a
transaction that locks the organization row, so concurrent triggers serialize
correctly. Violations surface as `quota_exceeded`.

### Example calls

```bash
# Trigger a workflow (as an editor or owner)
curl -X POST http://localhost:8080/v1/graphql \
  -H 'x-hasura-admin-secret: <secret>' \
  -H 'x-hasura-role: editor' \
  -H 'x-hasura-user-id: <uuid>' \
  -H 'x-hasura-organization-id: <uuid>' \
  -H 'content-type: application/json' \
  -d '{"query":"mutation { triggerWorkflowRun(input: {workflow_id: \"<uuid>\"}) { run_id status current_step_index message error } }"}'

# Approve an awaiting-approval gate (as an owner)
curl -X POST http://localhost:8080/v1/graphql \
  -H 'x-hasura-admin-secret: <secret>' \
  -H 'x-hasura-role: owner' \
  -H 'x-hasura-user-id: <uuid>' \
  -H 'x-hasura-organization-id: <uuid>' \
  -H 'content-type: application/json' \
  -d '{"query":"mutation { approveStep(input: {run_id: \"<uuid>\", step_index: 2, approved: true}) { run_id status } }"}'

# Trigger a workflow from an external system via the webhook
curl -X POST http://localhost:8080/webhook/trigger \
  -H 'content-type: application/json' \
  -H 'x-webhook-token: <WEBHOOK_TOKEN>' \
  -d '{"organization":"org-a","workflow":"AI Release","input":{"app":"checkout","risk":"critical"}}'
```

### Running the handler locally

The handler needs a `DATABASE_URL` and exposes the action endpoints
(`/actions/trigger-workflow-run`, `/actions/approve-step`), the webhook trigger
(`/webhook/trigger`), a demo endpoint (`/demo/status`) and `/healthz`:

```bash
cd actions-handler
npm install
DATABASE_URL="postgres://postgres:postgres@localhost:5432/app" \
WEBHOOK_TOKEN="dev-webhook-token" \
node src/index.js
```

Handler environment variables:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres connection string |
| `WEBHOOK_TOKEN` | Guards `POST /webhook/trigger`; endpoint disabled when unset |
| `HANDLER_BASE_URL` | Default `http://localhost:4000`; used by `{{env.HANDLER_BASE_URL}}` templates (e.g. the demo http step hitting `/demo/status`) |
| `USER_LLM_BASE_URL` / `USER_LLM_API_KEY` / `USER_LLM_MODEL` | Optional real chat-completions backend for `llm` steps; when unset the step runs a deterministic simulation |

Run the unit tests with `npm test` (`node --test test/*.test.js`).

## How to run

### 1. Start PostgreSQL, Hasura and the actions handler

```bash
docker compose up -d
```

The `actions` service (built from `actions-handler/`) is required by the two
Hasura Actions; `docker-compose.yml` wires it to the `postgres` database and
exposes it to Hasura via `ACTIONS_BASE_URL=http://actions:4000`. It also sets
`WEBHOOK_TOKEN`, `HANDLER_BASE_URL` and the optional `USER_LLM_*` variables. The
`web` service (built from `frontend/`) runs the Next app on `WEB_PORT` (default
`3000`) and proxies `/v1/graphql` and `/webhook/trigger`, so the whole app is
reachable on a single port.

### 2. Apply migrations (requires `hasura` CLI)

```bash
cp .env.example .env
hasura migrate apply --database-name default
```

### 3. Apply metadata

```bash
hasura metadata apply
```

The GraphQL console is available at `http://localhost:8080/console`.

## Frontend (`frontend/`)

A Next.js 14 app (login, organization dashboard, workflow builder, live run
panel) that talks to Hasura through a reverse proxy on the same port, so the
browser never needs the admin secret.

### Why a reverse proxy

The preview exposes a single port. `frontend/server.js` runs a Next custom
server on port 3000 that:

- serves the Next app, and
- proxies `GET/POST /v1/graphql` (HTTP) **and** `/v1/graphql` (WebSocket, for
  `graphql-ws` live run subscriptions) to the Hasura endpoint,
- proxies `POST /webhook/trigger` to the actions handler,
- forwards the client's `Authorization: Bearer <JWT>` untouched. It never
  injects the admin secret and never trusts client-supplied `X-Hasura-*`
  headers; Hasura validates the signed token and derives the session from it,
  so a browser cannot impersonate another user or organization.

Pages:

| Route | What it does |
|-------|-------------|
| `/login` | Sign in; stores the session in `localStorage` (`mc_session`) and an httpOnly cookie |
| `/dashboard` | Org members/quotas, workflow list, monthly/concurrent run usage, recent runs |
| `/workflows/new` | Create a workflow (steps JSON editor) |
| `/workflows/[id]` | View/update workflow, trigger a run, **live** step-by-step status subscription, approve/reject gates (admins only), webhook trigger example |

The login route resolves the role from `organization_members.role`
(`owner` → `owner`, `editor` → `editor`, otherwise `viewer`).

### Running the frontend

```bash
cd frontend
npm install

# Copy and adjust (see .env.example)
cp .env.example .env.local

# Development server (port 3000, proxies /v1/graphql to the endpoint below)
npm run dev
```

Environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `HASURA_GRAPHQL_ENDPOINT` | `http://localhost:8081` | Backend GraphQL endpoint proxied by `server.js` |
| `HASURA_GRAPHQL_ADMIN_SECRET` | `dev-admin-secret` | Admin secret used server-side only (login route, metadata) — never injected into proxied requests |
| `AUTH_JWT_SECRET` | `dev-jwt-secret` | Key used to sign the session JWT; **must match** `HASURA_GRAPHQL_JWT_SECRET` on the engine |
| `ACTIONS_ENDPOINT` | `http://localhost:4000` | Actions handler proxied for `/webhook/trigger` |
| `PORT` | `3000` | Frontend port |

Build and production run:

```bash
npm run build
npm start
```

Seeded users (Org A: `org-a`, Org B: `org-b`). The demo login is email-only
(sign in by email, no password):

| Email | Role | Project role (Org A: Project Alpha / Org B: Project Beta) |
|-------|------|---|
| `alice@org-a.test` | Org A owner | Project Alpha owner |
| `bob@org-a.test` | Org A editor | Project Alpha editor |
| `carol@org-b.test` | Org B owner | Project Beta owner |
| `dave@org-b.test` | Org B viewer | Project Beta viewer |

All GraphQL is client-side through the app's `lib/` helpers
(`gqlRequest`/`subscribeToRun`), so the same queries work against any Hasura
endpoint protected by these session variables.

### Applying from a clean database

```bash
hasura migrate apply --database-name default
hasura metadata apply
```

### Rolling back

```bash
hasura migrate apply --database-name default --down 2   # seed, then init
```

## How org isolation is enforced

1. **Database layer** — every tenant table has `organization_id`; composite FKs
   keep child rows consistent with their parent's org (see
   `migrations/default/20240809000000_init/up.sql`).
2. **GraphQL layer** — every select/update/delete permission filters on
   `organization_id _eq X-Hasura-Organization-Id` (or `_in` the allowed orgs for
   the `user` role); every insert presets `organization_id` from the session and
   re-checks it.
3. **Relationships** — object/array relationships are org-consistent (composite
   key mappings), so nested queries like `tasks { project { ... } }` cannot leak
   data across organizations either.
4. **Auth layer** — Hasura runs with `HASURA_GRAPHQL_JWT_SECRET`; the frontend
   proxy forwards only the client's `Authorization: Bearer` token and never
   injects the admin secret or trusts `X-Hasura-*` headers. Forged role/user/org
   headers are ignored, so an Org A user cannot read Org B data even by guessing
   ids.

## Verification

The migrations and metadata were verified against PostgreSQL 15 and Hasura
`v2.42.0`:

- `hasura migrate apply` from an empty database
- `hasura metadata apply` (metadata is consistent, no inconsistent objects)
- GraphQL queries as `user` / `viewer` / `editor` / `owner`
  confirming that Org A users only see Org A rows, cross-org inserts are
  rejected, and owner-only mutations are unavailable to editors/viewers
- Org role model (`owner` / `editor` / `viewer`): members see only their own
  org's rows; `editor` can create/edit workflows and trigger runs but cannot
  manage org settings, members, or invitations; `viewer` is read-only; the org
  creator is automatically inserted as `owner`
- Restricted-step guard: triggering a workflow with `db_write`/`notify` steps
  as an `editor` is rejected with `forbidden`, while the same workflow run by an
  `owner` completes and writes its
  `workflow_events`/`notifications` rows; GraphQL row mutation on those tables
  is denied for non-owners
- Canonical step vocabulary: existing workflows are backfilled to
  `task`/`sleep`/`llm`/`http`/`condition`/`approval`/`db_write`/`notify` on
  migration, and legacy aliases are normalized on save
- Hasura cron trigger `scheduled_ai_release`: the engine's scheduled event is
  delivered to `/webhook/trigger`, `hdb_cron_events` shows delivered runs, and
  the run executes the `AI Release` workflow end-to-end (`trigger_type = 'cron'`)
- JWT auth: login returns a signed token; `GET /v1/graphql` with forged
  `X-Hasura-*` headers (or no token) is rejected; valid tokens are scoped to
  the signed org and cannot be overridden by forged headers; WebSocket
  subscriptions authenticate via the same JWT
- End-to-end action tests (T1-T10) covering: approval-gate pause and
  approve/reject resume-or-cancel, retry with `fail_first_n`, `force_fail` and
  retry exhaustion, monthly and concurrent quota enforcement, cross-org workflow
  rejection, and role validation for both actions
- End-to-end webhook + demo workflow tests (`AI Release`): token auth
  (missing/wrong token -> 401), unknown org/workflow -> 404, the full
  `llm -> http -> condition -> approval -> db_write -> notify` chain pausing at
  the approval gate for `risk: critical`, the `when` branch skipping the gate
  for `risk: low`, `workflow_events`/`notifications` rows written with
  interpolated payloads, and cross-org isolation through the webhook
- 23 unit tests in `actions-handler/test/` (`npm test`) covering the expression
  evaluator, template rendering, and every step type (`task`, `sleep`,
  `condition`, `llm`, `http`, `db_write`, `notify`), plus a 24-assertion
  end-to-end script (`actions-handler/e2e_webhook.mjs`)
