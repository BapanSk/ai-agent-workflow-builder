DROP TABLE IF EXISTS public.workflow_run_steps CASCADE;
DROP TABLE IF EXISTS public.workflow_runs CASCADE;
DROP TABLE IF EXISTS public.workflows CASCADE;

ALTER TABLE public.organizations
    DROP COLUMN IF EXISTS quota_concurrent_runs,
    DROP COLUMN IF EXISTS quota_monthly_runs;
