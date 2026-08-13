-- ============================================================================
-- Multi-tenant SaaS foundation: initial schema
--
-- Design notes
-- ------------
-- * Every tenant-scoped table carries an `organization_id` column so that row
--   level security (in Hasura permissions) is a single-column filter and cannot
--   be bypassed through a relationship traversal.
-- * Child tables (project_members, tasks) carry `organization_id` denormalized
--   and are joined to their parent with a composite foreign key
--   (organization_id, parent_id) -> projects(organization_id, id). This keeps
--   the denormalized org id consistent: a row can never point at a project that
--   belongs to another organization.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS citext;

-- ----------------------------------------------------------------------------
-- Shared helper: keeps `updated_at` columns in sync on UPDATE.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- organizations
-- ----------------------------------------------------------------------------
CREATE TABLE public.organizations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    slug        citext NOT NULL UNIQUE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- users (global identity table, shared across all organizations)
-- ----------------------------------------------------------------------------
CREATE TABLE public.users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         citext NOT NULL UNIQUE,
    name          text NOT NULL,
    avatar_url    text,
    last_seen_at  timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- organization_members (membership + role inside an organization)
-- ----------------------------------------------------------------------------
CREATE TABLE public.organization_members (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    user_id          uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    role             text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, user_id)
);

-- ----------------------------------------------------------------------------
-- invitations
-- ----------------------------------------------------------------------------
CREATE TABLE public.invitations (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    email            citext NOT NULL,
    role             text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    token            text NOT NULL UNIQUE,
    invited_by       uuid REFERENCES public.users(id) ON DELETE SET NULL,
    status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
    expires_at       timestamptz NOT NULL,
    accepted_at      timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now()
);

-- At most one active (pending) invitation per email per organization.
CREATE UNIQUE INDEX invitations_active_unique
    ON public.invitations (organization_id, email)
    WHERE status = 'pending';

-- ----------------------------------------------------------------------------
-- projects (tenant-scoped)
-- ----------------------------------------------------------------------------
CREATE TABLE public.projects (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    name             text NOT NULL,
    description      text,
    status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_by       uuid REFERENCES public.users(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    -- Composite unique key required by the composite FK in child tables.
    UNIQUE (organization_id, id)
);

-- ----------------------------------------------------------------------------
-- project_members (tenant-scoped, child of projects)
-- ----------------------------------------------------------------------------
CREATE TABLE public.project_members (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL,
    project_id       uuid NOT NULL,
    user_id          uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    role             text NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'editor', 'viewer')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, user_id),
    CONSTRAINT project_members_project_fk
        FOREIGN KEY (organization_id, project_id)
        REFERENCES public.projects (organization_id, id)
        ON DELETE CASCADE
);

-- ----------------------------------------------------------------------------
-- tasks (tenant-scoped, child of projects)
-- ----------------------------------------------------------------------------
CREATE TABLE public.tasks (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL,
    project_id       uuid NOT NULL,
    title            text NOT NULL,
    description      text,
    status           text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'in_review', 'done', 'blocked')),
    priority         text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    assignee_id      uuid REFERENCES public.users(id) ON DELETE SET NULL,
    created_by       uuid REFERENCES public.users(id) ON DELETE SET NULL,
    due_date         date,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tasks_project_fk
        FOREIGN KEY (organization_id, project_id)
        REFERENCES public.projects (organization_id, id)
        ON DELETE CASCADE
);

-- ----------------------------------------------------------------------------
-- updated_at triggers
-- ----------------------------------------------------------------------------
CREATE TRIGGER set_organizations_updated_at
    BEFORE UPDATE ON public.organizations
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_users_updated_at
    BEFORE UPDATE ON public.users
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_projects_updated_at
    BEFORE UPDATE ON public.projects
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_tasks_updated_at
    BEFORE UPDATE ON public.tasks
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- indexes (FK lookups and org-scoped queries)
-- ----------------------------------------------------------------------------
CREATE INDEX organization_members_organization_idx ON public.organization_members (organization_id);
CREATE INDEX organization_members_user_idx          ON public.organization_members (user_id);
CREATE INDEX invitations_organization_idx           ON public.invitations (organization_id);
CREATE INDEX invitations_token_idx                  ON public.invitations (token);
CREATE INDEX projects_organization_idx              ON public.projects (organization_id);
CREATE INDEX projects_created_by_idx                ON public.projects (created_by);
CREATE INDEX project_members_organization_idx       ON public.project_members (organization_id);
CREATE INDEX project_members_project_idx            ON public.project_members (project_id);
CREATE INDEX project_members_user_idx               ON public.project_members (user_id);
CREATE INDEX tasks_organization_idx                 ON public.tasks (organization_id);
CREATE INDEX tasks_project_idx                      ON public.tasks (project_id);
CREATE INDEX tasks_assignee_idx                     ON public.tasks (assignee_id);
CREATE INDEX tasks_created_by_idx                   ON public.tasks (created_by);
