-- ============================================================================
-- Assignment-aligned organization roles + workflow step-type vocabulary.
--
--  * organization membership roles become owner / editor / viewer
--      - owner  : full workflow control, triggers, approval, manages members
--      - editor : create/edit workflows, trigger, approve (no member mgmt)
--      - viewer : read-only
--    Existing admin -> owner, member -> editor; a new viewer demo user (Eve)
--    is seeded into Org A for testing read-only behavior.
--  * workflow_run_steps.step_type is widened to the assignment vocabulary
--    (llm_call / http_request / conditional_branch / approval_gate) while
--    keeping the legacy engine names valid so existing rows stay readable.
--  * Approval gates default to approver roles ["owner","editor"] (viewer can
--    never approve); the seeded AI Release + Deploy Alpha gates are updated.
--  * The AI Release demo workflow is rewritten to the canonical step-type
--    names, keeping the LLM -> HTTP -> conditional -> approval -> DB write /
--    notify chain with the branch driven by the LLM output.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- organization_members.role -> owner / editor / viewer
-- ----------------------------------------------------------------------------
ALTER TABLE public.organization_members
    DROP CONSTRAINT IF EXISTS organization_members_role_check;

UPDATE public.organization_members
    SET role = 'owner'  WHERE role = 'admin';
UPDATE public.organization_members
    SET role = 'editor' WHERE role = 'member';

ALTER TABLE public.organization_members
    ADD CONSTRAINT organization_members_role_check
    CHECK (role IN ('owner', 'editor', 'viewer'));

-- ----------------------------------------------------------------------------
-- invitations.role follows the same vocabulary
-- ----------------------------------------------------------------------------
ALTER TABLE public.invitations
    DROP CONSTRAINT IF EXISTS invitations_role_check;

UPDATE public.invitations
    SET role = 'owner'  WHERE role = 'admin';
UPDATE public.invitations
    SET role = 'editor' WHERE role = 'member';

ALTER TABLE public.invitations
    ADD CONSTRAINT invitations_role_check
    CHECK (role IN ('owner', 'editor', 'viewer'));

-- ----------------------------------------------------------------------------
-- workflow_run_steps.step_type -> assignment vocabulary (canonical) plus
-- legacy engine names so historical rows remain valid.
-- ----------------------------------------------------------------------------
ALTER TABLE public.workflow_run_steps
    DROP CONSTRAINT IF EXISTS workflow_run_steps_step_type_check;
ALTER TABLE public.workflow_run_steps
    ADD CONSTRAINT workflow_run_steps_step_type_check
    CHECK (step_type IN (
        'task', 'sleep',
        'llm_call', 'http_request', 'conditional_branch', 'approval_gate',
        'db_write', 'notify',
        'llm', 'http', 'condition', 'approval'
    ));

-- ----------------------------------------------------------------------------
-- New viewer demo user (Org A)
-- ----------------------------------------------------------------------------
INSERT INTO public.users (id, email, name) VALUES
    ('00000000-0000-0000-0000-000000000015', 'eve@org-a.test', 'Eve A');

INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
    ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000015', 'viewer');

INSERT INTO public.project_members (organization_id, project_id, user_id, role) VALUES
    ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000015', 'viewer');

-- ----------------------------------------------------------------------------
-- Approval gates: approvable by owner + editor (assignment), never viewer.
-- Deploy Alpha ...041: approval step is index 2.
-- ----------------------------------------------------------------------------
UPDATE public.workflows
    SET steps = jsonb_set(
        steps,
        '{2,approver_roles}',
        '["owner","editor"]'::jsonb,
        false
    )
    WHERE id = '00000000-0000-0000-0000-000000000041';

-- ----------------------------------------------------------------------------
-- AI Release ...044: canonical step-type names + owner/editor approver roles.
-- ----------------------------------------------------------------------------
UPDATE public.workflows
    SET steps = $wf$
[
  {"type":"llm_call","name":"Assess release risk","prompt":"Assess the release risk for app {{input.app}} with risk level {{input.risk}}.","model":"demo-classifier"},
  {"type":"http_request","name":"Check deployment status","method":"GET","url":"{{env.HANDLER_BASE_URL}}/demo/status"},
  {"type":"conditional_branch","name":"Requires approval?","expression":"steps[\"Assess release risk\"].severity == \"critical\""},
  {"type":"approval_gate","name":"Manager approval","when":"steps[\"Requires approval?\"].result == true","approver_roles":["owner","editor"]},
  {"type":"db_write","name":"Persist event","table":"workflow_events","event_type":"release.assessed","data":{"app":"{{input.app}}","risk":"{{input.risk}}","severity":"{{steps[\"Assess release risk\"].severity}}","service":"{{steps[\"Check deployment status\"].body.service}}","required_approval":"{{steps[\"Requires approval?\"].result}}"}},
  {"type":"notify","name":"Notify team","title":"Release {{input.app}} assessed","body":"Risk {{input.risk}} for {{input.app}} was assessed as {{steps[\"Assess release risk\"].severity}}."}
]
$wf$::jsonb
    WHERE id = '00000000-0000-0000-0000-000000000044';

-- ----------------------------------------------------------------------------
-- Restricted-step save guard: workflows containing db_write / notify steps may
-- only be inserted or updated by the owner role. Hasura sets the `hasura.user`
-- session variable to the request's session variables as JSON, so the trigger
-- can read the acting role. When the setting is absent (migrations, direct SQL,
-- console admin) the guard is bypassed.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.workflows_restricted_steps_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    hasura_user text;
    role_key text;
    acting_role text;
    s jsonb;
    restricted boolean := false;
BEGIN
    hasura_user := NULLIF(current_setting('hasura.user', true), '');
    IF hasura_user IS NULL OR hasura_user = '' THEN
        RETURN NEW;
    END IF;

    role_key := NULLIF(hasura_user::jsonb ->> 'x-hasura-role', '');
    IF role_key IS NULL THEN
        role_key := hasura_user::jsonb ->> 'x-hasura-default-role';
    END IF;
    acting_role := COALESCE(role_key, 'editor');

    FOR s IN SELECT * FROM jsonb_array_elements(COALESCE(NEW.steps, '[]'::jsonb))
    LOOP
        IF s ->> 'type' IN ('db_write', 'notify') THEN
            restricted := true;
        END IF;
    END LOOP;

    IF restricted AND acting_role <> 'owner' THEN
        RAISE EXCEPTION 'Only the organization owner may save workflows with db_write/notify steps (acting role: %)', acting_role
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workflows_restricted_steps_guard ON public.workflows;
CREATE TRIGGER workflows_restricted_steps_guard
    BEFORE INSERT OR UPDATE ON public.workflows
    FOR EACH ROW EXECUTE FUNCTION public.workflows_restricted_steps_guard();
