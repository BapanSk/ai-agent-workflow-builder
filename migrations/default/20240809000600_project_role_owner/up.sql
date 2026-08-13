-- ----------------------------------------------------------------------------
-- Project-level roles: owner / editor / viewer
--
-- The original schema stored project membership roles as admin/editor/viewer.
-- This migration renames the `admin` project role to `owner` (the terminology
-- used by the assignment checklist) and updates the CHECK constraint. It is a
-- pure data-role rename: `admin` rows become `owner`, and the allowed values
-- become ('owner','editor','viewer'). Org-level roles (organization_members)
-- are untouched.
-- ----------------------------------------------------------------------------

-- Drop the old CHECK constraint (named by Postgres default).
ALTER TABLE public.project_members DROP CONSTRAINT project_members_role_check;

-- Rename existing `admin` project memberships to `owner`.
UPDATE public.project_members SET role = 'owner' WHERE role = 'admin';

-- Re-add the constraint with the owner/editor/viewer vocabulary.
ALTER TABLE public.project_members
    ADD CONSTRAINT project_members_role_check
    CHECK (role IN ('owner', 'editor', 'viewer'));

-- Default for new rows: viewer.
ALTER TABLE public.project_members ALTER COLUMN role SET DEFAULT 'viewer';
