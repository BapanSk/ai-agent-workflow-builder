ALTER TABLE public.workflow_run_steps
    DROP CONSTRAINT IF EXISTS workflow_run_steps_step_type_check;

ALTER TABLE public.workflow_run_steps
    ADD CONSTRAINT workflow_run_steps_step_type_check
    CHECK (step_type IN ('task', 'sleep', 'approval'));

DROP TABLE IF EXISTS public.notifications;
DROP TABLE IF EXISTS public.workflow_events;
