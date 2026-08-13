-- ----------------------------------------------------------------------------
-- Auto-owner trigger for projects.
--
-- When a project is created, the creating user becomes an `owner` member of
-- the project automatically, so project-scoped permissions (owner/editor/
-- viewer) can be enforced uniformly for every project including new ones.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.make_project_creator_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.created_by IS NOT NULL THEN
        INSERT INTO public.project_members (organization_id, project_id, user_id, role)
        VALUES (NEW.organization_id, NEW.id, NEW.created_by, 'owner')
        ON CONFLICT (project_id, user_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER projects_make_creator_owner
    AFTER INSERT ON public.projects
    FOR EACH ROW
    EXECUTE FUNCTION public.make_project_creator_owner();
