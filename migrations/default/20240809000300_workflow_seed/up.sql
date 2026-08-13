-- Seed workflows for local development and action testing.
--
-- Step definition schema (jsonb array on workflows.steps):
--   { "type": "task" | "sleep" | "approval",
--     "name": string,
--     "max_attempts": int,          // retries + 1 (default 1)
--     "retry_delay_seconds": int,   // pause between attempts (default 0)
--     // task-only simulation knobs:
--     "fail_first_n": int,          // fail first N attempts deterministically
--     "force_fail": bool            // always fail
--   }
-- sleep-only: "duration_seconds": int
-- approval-only: "approver_roles": [string] (informational; handler requires org_admin)

INSERT INTO public.workflows (id, organization_id, name, description, steps, created_by) VALUES
    (
        '00000000-0000-0000-0000-000000000041',
        '00000000-0000-0000-0000-000000000001',
        'Deploy Alpha',
        'Deployment pipeline with a manager approval gate',
        '[{"type":"task","name":"Prepare build","max_attempts":2,"retry_delay_seconds":0},{"type":"sleep","name":"Wait for build","duration_seconds":1,"max_attempts":1},{"type":"approval","name":"Manager approval","approver_roles":["org_admin"]},{"type":"task","name":"Deploy","max_attempts":3,"retry_delay_seconds":0}]'::jsonb,
        '00000000-0000-0000-0000-000000000011'
    ),
    (
        '00000000-0000-0000-0000-000000000042',
        '00000000-0000-0000-0000-000000000001',
        'Flaky Build',
        'Step that fails once and succeeds on retry',
        '[{"type":"task","name":"Flaky step","max_attempts":3,"retry_delay_seconds":0,"fail_first_n":1}]'::jsonb,
        '00000000-0000-0000-0000-000000000011'
    ),
    (
        '00000000-0000-0000-0000-000000000043',
        '00000000-0000-0000-0000-000000000002',
        'Deploy Beta',
        'Simple deployment pipeline without approval',
        '[{"type":"task","name":"Prepare build","max_attempts":2,"retry_delay_seconds":0},{"type":"task","name":"Deploy","max_attempts":3,"retry_delay_seconds":0}]'::jsonb,
        '00000000-0000-0000-0000-000000000013'
    );
