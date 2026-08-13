const STEP_TYPES = [
  { value: 'task', label: 'Task (simulated work)' },
  { value: 'sleep', label: 'Sleep (pause)' },
  { value: 'llm_call', label: 'LLM (assess/classify)' },
  { value: 'http_request', label: 'HTTP request' },
  { value: 'conditional_branch', label: 'Conditional branch' },
  { value: 'approval_gate', label: 'Approval gate' },
  { value: 'db_write', label: 'DB write (event)' },
  { value: 'notify', label: 'Notify (notification)' },
];

// db_write / notify are restricted step types: only the organization owner may
// include them in a workflow (enforced here in the UI and by a Postgres
// trigger / handler checks on the backend).
const OWNER_ONLY_TYPES = new Set(['db_write', 'notify']);

function field(
  label,
  value,
  onChange,
  { type = 'text', options, placeholder, min, step } = {},
) {
  const input =
    type === 'select' ? (
      <select value={value} onChange={onChange}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    ) : type === 'textarea' ? (
      <textarea
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        rows={2}
      />
    ) : (
      <input
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        min={min}
        step={step}
      />
    );
  return (
    <label className="field" key={label}>
      <span>{label}</span>
      {input}
    </label>
  );
}

export default function StepEditor({ steps, onChange, isOwner = true }) {
  const availableTypes = isOwner
    ? STEP_TYPES
    : STEP_TYPES.filter((t) => !OWNER_ONLY_TYPES.has(t.value));
  function updateStep(i, patch) {
    const next = steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s));
    onChange(next);
  }

  function addStep() {
    onChange([...steps, { type: 'task', name: '' }]);
  }

  function removeStep(i) {
    onChange(steps.filter((_, idx) => idx !== i));
  }

  function moveStep(i, dir) {
    const next = [...steps];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  }

  return (
    <div>
      {steps.map((step, i) => (
        <div
          key={`${i}-${step.type}`}
          className="card"
          style={{ padding: '14px 16px' }}
        >
          <div className="spread">
            <strong>Step {i + 1}</strong>
            <div className="row">
              <button
                className="btn sm"
                type="button"
                disabled={i === 0}
                onClick={() => moveStep(i, -1)}
              >
                ↑
              </button>
              <button
                className="btn sm"
                type="button"
                disabled={i === steps.length - 1}
                onClick={() => moveStep(i, 1)}
              >
                ↓
              </button>
              <button
                className="btn sm danger"
                type="button"
                onClick={() => removeStep(i)}
              >
                Remove
              </button>
            </div>
          </div>

          <div className="grid">
            {field(
              'Type',
              step.type,
              (e) => updateStep(i, { type: e.target.value }),
              {
                type: 'select',
                options: availableTypes,
              },
            )}
            {field('Name', step.name || '', (e) =>
              updateStep(i, { name: e.target.value }),
            )}
          </div>

          {field(
            'Run when (condition)',
            step.when || '',
            (e) => updateStep(i, { when: e.target.value }),
            {
              placeholder:
                'e.g. steps["Requires approval?"].result == true (leave empty to always run)',
            },
          )}

          {step.type === 'task' && (
            <div className="grid">
              {field('Max attempts', String(step.max_attempts ?? 1), (e) =>
                updateStep(i, {
                  max_attempts: Math.max(1, Number(e.target.value) || 1),
                }),
              )}
              {field('Retry delay (s)', String(step.retry_delay_seconds ?? 0), (e) =>
                updateStep(i, { retry_delay_seconds: Number(e.target.value) }),
              )}
              {field('Fail first N attempts', String(step.fail_first_n ?? 0), (e) =>
                updateStep(i, { fail_first_n: Number(e.target.value) }),
              )}
              {field('Fail rate (0-1)', String(step.fail_rate ?? 0), (e) =>
                updateStep(i, { fail_rate: Number(e.target.value) }),
              )}
              {field(
                'Force fail',
                String(step.force_fail ?? false),
                (e) => updateStep(i, { force_fail: e.target.value === 'true' }),
                {
                  type: 'select',
                  options: [
                    { value: 'false', label: 'No' },
                    { value: 'true', label: 'Yes' },
                  ],
                },
              )}
            </div>
          )}

          {step.type === 'sleep' && (
            <div className="grid">
              {field('Duration (s)', String(step.duration_seconds ?? 1), (e) =>
                updateStep(i, {
                  duration_seconds: Math.max(1, Number(e.target.value) || 1),
                }),
              )}
            </div>
          )}

          {step.type === 'llm_call' && (
            <div className="grid">
              {field('Prompt', step.prompt || '', (e) =>
                updateStep(i, { prompt: e.target.value }),
              )}
              {field('Model', step.model || '', (e) =>
                updateStep(i, { model: e.target.value }),
              )}
            </div>
          )}

          {step.type === 'http_request' && (
            <div className="grid">
              {field('Method', step.method || 'GET', (e) =>
                updateStep(i, { method: e.target.value }),
              )}
              {field('URL', step.url || '', (e) =>
                updateStep(i, { url: e.target.value }),
              )}
              {field('Timeout (s)', String(step.timeout_seconds ?? 10), (e) =>
                updateStep(i, { timeout_seconds: Number(e.target.value) }),
              )}
            </div>
          )}

          {step.type === 'conditional_branch' && (
            <div className="grid">
              {field('Expression', step.expression || '', (e) =>
                updateStep(i, { expression: e.target.value }),
              )}
            </div>
          )}

          {step.type === 'approval_gate' && (
            <div className="grid">
              {field(
                'Approver roles (comma separated)',
                (step.approver_roles || []).join(', '),
                (e) =>
                  updateStep(i, {
                    approver_roles: e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  }),
              )}
            </div>
          )}

          {step.type === 'db_write' && (
            <div className="grid">
              {field(
                'Table',
                step.table || 'workflow_events',
                (e) => updateStep(i, { table: e.target.value }),
                {
                  type: 'select',
                  options: [
                    { value: 'workflow_events', label: 'workflow_events' },
                    { value: 'notifications', label: 'notifications' },
                  ],
                },
              )}
              {field('Event type', step.event_type || '', (e) =>
                updateStep(i, { event_type: e.target.value }),
              )}
              {field('Data (JSON)', JSON.stringify(step.data ?? {}), (e) => {
                try {
                  updateStep(i, { data: JSON.parse(e.target.value) });
                } catch {
                  /* keep last valid */
                }
              })}
            </div>
          )}

          {step.type === 'notify' && (
            <div className="grid">
              {field('Title', step.title || '', (e) =>
                updateStep(i, { title: e.target.value }),
              )}
              {field('Body', step.body || '', (e) =>
                updateStep(i, { body: e.target.value }),
              )}
            </div>
          )}
        </div>
      ))}

      {!isOwner && (
        <p className="muted">
          DB write and Notify step types are restricted to the organization owner.
        </p>
      )}

      {steps.length === 0 && (
        <p className="muted">No steps yet — add one below.</p>
      )}

      <button className="btn" type="button" onClick={addStep}>
        + Add step
      </button>
    </div>
  );
}
