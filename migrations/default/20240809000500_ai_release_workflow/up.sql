-- Seed the "AI Release" demo workflow demonstrating the full end-to-end chain:
--
--   LLM (assess risk) -> HTTP (fetch status) -> condition (branch) ->
--   approval gate (when risk critical) -> db_write (event) -> notify
--
-- The LLM step runs in simulated mode unless USER_LLM_BASE_URL / USER_LLM_API_KEY
-- are configured on the handler. The HTTP step targets the handler's own
-- /demo/status endpoint via {{env.HANDLER_BASE_URL}} so the demo needs no
-- external network access.
--
-- Triggering (webhook):
--   curl -X POST http://localhost:4000/webhook/trigger \
--     -H 'content-type: application/json' \
--     -H 'x-webhook-token: <WEBHOOK_TOKEN>' \
--     -d '{"organization":"org-a","workflow":"AI Release","input":{"app":"checkout","risk":"critical"}}'
--
-- With risk "critical" the run pauses at the approval gate; with risk "low"
-- the approval step is skipped (conditional branch).

INSERT INTO public.workflows (id, organization_id, name, description, steps, created_by) VALUES
    (
        '00000000-0000-0000-0000-000000000044',
        '00000000-0000-0000-0000-000000000001',
        'AI Release',
        'LLM risk assessment -> HTTP status check -> conditional branch -> approval gate -> DB write/notify',
        '[
          {"type":"llm","name":"Assess release risk","prompt":"Assess the release risk for app {{input.app}} with risk level {{input.risk}}.","model":"demo-classifier"},
          {"type":"http","name":"Check deployment status","method":"GET","url":"{{env.HANDLER_BASE_URL}}/demo/status"},
          {"type":"condition","name":"Requires approval?","expression":"steps[\"Assess release risk\"].severity == \"critical\""},
          {"type":"approval","name":"Manager approval","when":"steps[\"Requires approval?\"].result == true","approver_roles":["org_admin"]},
          {"type":"db_write","name":"Persist event","table":"workflow_events","event_type":"release.assessed","data":{"app":"{{input.app}}","risk":"{{input.risk}}","severity":"{{steps[\"Assess release risk\"].severity}}","service":"{{steps[\"Check deployment status\"].body.service}}","required_approval":"{{steps[\"Requires approval?\"].result}}"}},
          {"type":"notify","name":"Notify team","title":"Release {{input.app}} assessed","body":"Risk {{input.risk}} for {{input.app}} was assessed as {{steps[\"Assess release risk\"].severity}}."}
        ]'::jsonb,
        '00000000-0000-0000-0000-000000000011'
    );
