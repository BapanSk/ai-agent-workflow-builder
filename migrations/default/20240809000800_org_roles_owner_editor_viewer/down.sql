DROP TRIGGER IF EXISTS workflows_restricted_steps_guard ON public.workflows;
DROP FUNCTION IF EXISTS public.workflows_restricted_steps_guard();

DELETE FROM public.project_members
    WHERE organization_id = '00000000-0000-0000-0000-000000000001'
      AND project_id = '00000000-0000-0000-0000-000000000021'
      AND user_id = '00000000-0000-0000-0000-000000000015';

DELETE FROM public.organization_members
    WHERE organization_id = '00000000-0000-0000-0000-000000000001'
      AND user_id = '00000000-0000-0000-0000-000000000015';

DELETE FROM public.users WHERE id = '00000000-0000-0000-0000-000000000015';

UPDATE public.organization_members
    SET role = 'admin'  WHERE role = 'owner';
UPDATE public.organization_members
    SET role = 'member' WHERE role = 'editor';

ALTER TABLE public.workflow_run_steps
    DROP CONSTRAINT IF EXISTS workflow_run_steps_step_type_check;
ALTER TABLE public.workflow_run_steps
    ADD CONSTRAINT workflow_run_steps_step_type_check
    CHECK (step_type IN ('task', 'sleep', 'approval', 'condition', 'llm', 'http', 'db_write', 'notify'));

ALTER TABLE public.invitations
    DROP CONSTRAINT IF EXISTS invitations_role_check;
ALTER TABLE public.invitations
    ADD CONSTRAINT invitations_role_check
    CHECK (role IN ('admin', 'member'));

ALTER TABLE public.organization_members
    DROP CONSTRAINT IF EXISTS organization_members_role_check;
ALTER TABLE public.organization_members
    ADD CONSTRAINT organization_members_role_check
    CHECK (role IN ('admin', 'member'));
