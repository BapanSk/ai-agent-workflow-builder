export const DASHBOARD_QUERY = `
  query Dashboard($orgId: uuid!, $monthStart: timestamptz!) {
    organizations_by_pk(id: $orgId) {
      id
      name
      slug
      quota_concurrent_runs
      quota_monthly_runs
      members {
        id
        role
        user {
          id
          name
        }
      }
    }
    workflows: workflows(order_by: { created_at: asc }) {
      id
      name
      description
      is_active
      steps
      runs_aggregate {
        aggregate {
          count
        }
      }
    }
    concurrent: workflow_runs_aggregate(
      where: {
        organization_id: { _eq: $orgId }
        status: { _in: ["queued", "running", "paused", "awaiting_approval"] }
      }
    ) {
      aggregate {
        count
      }
    }
    monthly: workflow_runs_aggregate(
      where: {
        organization_id: { _eq: $orgId }
        created_at: { _gte: $monthStart }
      }
    ) {
      aggregate {
        count
      }
    }
    recentRuns: workflow_runs(
      order_by: { created_at: desc }
      limit: 10
    ) {
      id
      status
      current_step_index
      error
      created_at
      workflow {
        name
      }
    }
  }
`;

export const WORKFLOW_DETAIL_QUERY = `
  query WorkflowDetail($id: uuid!) {
    workflows_by_pk(id: $id) {
      id
      name
      description
      steps
      is_active
      created_at
      runs(order_by: { created_at: desc }) {
        id
        status
        current_step_index
        error
        created_at
        triggerer {
          name
        }
      }
    }
  }
`;

export const RUN_LIVE_SUBSCRIPTION = `
  subscription RunLive($runId: uuid!) {
    workflow_run_steps(
      where: { run_id: { _eq: $runId } }
      order_by: { step_index: asc }
    ) {
      id
      step_index
      name
      step_type
      status
      attempts
      max_attempts
      output
      error
      approved_by
      approved_at
      run {
        status
        current_step_index
        error
        started_at
        completed_at
      }
    }
  }
`;

export const TRIGGER_RUN_MUTATION = `
  mutation TriggerRun($input: TriggerWorkflowRunInput!) {
    triggerWorkflowRun(input: $input) {
      run_id
      status
      current_step_index
      message
      error
    }
  }
`;

export const APPROVE_STEP_MUTATION = `
  mutation ApproveStep($input: ApproveStepInput!) {
    approveStep(input: $input) {
      run_id
      status
      current_step_index
      message
      error
    }
  }
`;

export const INSERT_WORKFLOW_MUTATION = `
  mutation InsertWorkflow($name: String!, $description: String, $steps: jsonb!, $is_active: Boolean!) {
    insert_workflows_one(
      object: {
        name: $name
        description: $description
        steps: $steps
        is_active: $is_active
      }
    ) {
      id
    }
  }
`;

export const UPDATE_WORKFLOW_MUTATION = `
  mutation UpdateWorkflow(
    $id: uuid!
    $name: String!
    $description: String
    $steps: jsonb!
    $is_active: Boolean!
  ) {
    update_workflows_by_pk(
      pk_columns: { id: $id }
      _set: {
        name: $name
        description: $description
        steps: $steps
        is_active: $is_active
      }
    ) {
      id
    }
  }
`;

export const DELETE_WORKFLOW_MUTATION = `
  mutation DeleteWorkflow($id: uuid!) {
    delete_workflows_by_pk(id: $id) {
      id
    }
  }
`;
