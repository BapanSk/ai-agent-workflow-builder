import express from 'express';
import { handleTriggerWorkflowRun, handleApproveStep, handleWebhookTrigger } from './handlers.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

app.post('/actions/trigger-workflow-run', async (req, res) => {
  const out = await handleTriggerWorkflowRun(req.body);
  if (out.error) return res.status(400).json(out.error);
  res.json(out.data);
});

app.post('/actions/approve-step', async (req, res) => {
  const out = await handleApproveStep(req.body);
  if (out.error) return res.status(400).json(out.error);
  res.json(out.data);
});

// Webhook trigger: guarded by a shared token (x-webhook-token header).
app.post('/webhook/trigger', async (req, res) => {
  const out = await handleWebhookTrigger(req);
  if (out.error) {
    const status =
      out.error.code === 'unauthorized' ? 401
        : out.error.code === 'webhook_disabled' ? 503
          : out.error.code === 'bad_request' ? 400
            : out.error.code === 'not_found' ? 404
              : out.error.code === 'unprocessable' ? 422
                : out.error.code === 'quota_exceeded' ? 429 : 400;
    return res.status(status).json(out.error);
  }
  res.json(out.data);
});

// Demo endpoint used by the seeded "AI Release" workflow's http step, so the
// demo runs without external network access.
app.get('/demo/status', (_req, res) => {
  res.json({ status: 'ok', service: 'demo-api', version: '1.0.0' });
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  console.log(`[actions-handler] listening on :${port}`);
});
