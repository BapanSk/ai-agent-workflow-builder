-- ============================================================================
-- Workflow engine v2: more step types + outbox tables for db_write/notify.
--
--  * widen workflow_run_steps.step_type to include condition / llm / http /
--    db_write / notify
--  * workflow_events   : append-only event log written by the db_write step
--  * notifications     : org-scoped notifications written by the notify step
-- ============================================================================

ALTER TABLE public.workflow_run_steps
    DROP CONSTRAINT IF EXISTS workflow_run_steps_step_type_check;

ALTER TABLE public.workflow_run_steps
    ADD CONSTRAINT workflow_run_steps_step_type_check
    CHECK (step_type IN ('task', 'sleep', 'approval', 'condition', 'llm', 'http', 'db_write', 'notify'));

CREATE TABLE public.workflow_events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    run_id          uuid NOT NULL,
    workflow_id     uuid NOT NULL,
    event_type      text NOT NULL,
    payload         jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, id),
    CONSTRAINT workflow_events_run_fk
        FOREIGN KEY (organization_id, run_id)
        REFERENCES public.workflow_runs (organization_id, id)
        ON DELETE CASCADE
);

CREATE TABLE public.notifications (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    run_id          uuid NOT NULL,
    workflow_id     uuid NOT NULL,
    title           text NOT NULL,
    body            text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, id),
    CONSTRAINT notifications_run_fk
        FOREIGN KEY (organization_id, run_id)
        REFERENCES public.workflow_runs (organization_id, id)
        ON DELETE CASCADE
);

CREATE INDEX workflow_events_org_idx  ON public.workflow_events (organization_id, created_at);
CREATE INDEX workflow_events_run_idx  ON public.workflow_events (run_id);
CREATE INDEX notifications_org_idx    ON public.notifications (organization_id, created_at);
CREATE INDEX notifications_run_idx    ON public.notifications (run_id);
