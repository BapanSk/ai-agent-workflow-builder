-- ============================================================================
-- Workflow engine tables + organization quotas
--
-- workflows        : org-scoped workflow definitions; `steps` is a jsonb array
--                    of step definitions (see README for the step schema).
-- workflow_runs    : one row per execution; status machine:
--                    queued -> running -> completed
--                                   -> awaiting_approval (paused) -> running
--                                   -> failed
--                                   -> cancelled
-- workflow_run_steps: per-step state, including attempts (retries), output,
--                    and approval bookkeeping.
--
-- Quotas live on `organizations`:
--   quota_concurrent_runs  - max runs in an active state at the same time
--   quota_monthly_runs     - max runs started per calendar month
-- ============================================================================

ALTER TABLE public.organizations
    ADD COLUMN quota_concurrent_runs integer NOT NULL DEFAULT 5,
    ADD COLUMN quota_monthly_runs integer NOT NULL DEFAULT 100;

CREATE TABLE public.workflows (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    name             text NOT NULL,
    description      text,
    steps            jsonb NOT NULL DEFAULT '[]'::jsonb,
    is_active        boolean NOT NULL DEFAULT true,
    created_by       uuid REFERENCES public.users(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, id)
);

CREATE TABLE public.workflow_runs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    workflow_id         uuid NOT NULL,
    status              text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'paused', 'awaiting_approval', 'completed', 'failed', 'cancelled')),
    trigger_type        text NOT NULL DEFAULT 'manual',
    triggered_by        uuid REFERENCES public.users(id) ON DELETE SET NULL,
    input               jsonb NOT NULL DEFAULT '{}'::jsonb,
    current_step_index  integer NOT NULL DEFAULT 0,
    error               text,
    started_at          timestamptz NOT NULL DEFAULT now(),
    completed_at        timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, id),
    CONSTRAINT workflow_runs_workflow_fk
        FOREIGN KEY (organization_id, workflow_id)
        REFERENCES public.workflows (organization_id, id)
        ON DELETE CASCADE
);

CREATE TABLE public.workflow_run_steps (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    run_id           uuid NOT NULL,
    workflow_id      uuid NOT NULL,
    step_index       integer NOT NULL,
    name             text NOT NULL,
    step_type        text NOT NULL CHECK (step_type IN ('task', 'sleep', 'approval')),
    status           text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'awaiting_approval', 'completed', 'failed', 'skipped')),
    attempts         integer NOT NULL DEFAULT 0,
    max_attempts     integer NOT NULL DEFAULT 1,
    output           jsonb,
    error            text,
    approved_by      uuid REFERENCES public.users(id) ON DELETE SET NULL,
    approved_at      timestamptz,
    started_at       timestamptz,
    completed_at     timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (run_id, step_index),
    CONSTRAINT workflow_run_steps_run_fk
        FOREIGN KEY (organization_id, run_id)
        REFERENCES public.workflow_runs (organization_id, id)
        ON DELETE CASCADE
);

CREATE TRIGGER set_workflows_updated_at
    BEFORE UPDATE ON public.workflows
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_workflow_runs_updated_at
    BEFORE UPDATE ON public.workflow_runs
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_workflow_run_steps_updated_at
    BEFORE UPDATE ON public.workflow_run_steps
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX workflow_runs_org_status_idx ON public.workflow_runs (organization_id, status);
CREATE INDEX workflow_runs_org_created_idx ON public.workflow_runs (organization_id, created_at);
CREATE INDEX workflow_run_steps_run_idx    ON public.workflow_run_steps (run_id);
CREATE INDEX workflow_run_steps_org_idx    ON public.workflow_run_steps (organization_id);
