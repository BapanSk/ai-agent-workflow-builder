const http = require('http');
const next = require('next');
const { createProxyMiddleware } = require('http-proxy-middleware');

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = Number(process.env.PORT || 3000);

const hasuraTarget = process.env.HASURA_GRAPHQL_ENDPOINT || 'http://localhost:8081';
const handlerTarget = process.env.ACTIONS_ENDPOINT || 'http://localhost:4000';

// Authentication model (Nhost-style): the client presents `Authorization:
// Bearer <JWT>` minted by /api/auth/login. Hasura validates the token against
// HASURA_GRAPHQL_JWT_SECRET and derives the x-hasura-* session variables from
// its signed claims. The proxy therefore never injects the admin secret and
// never trusts client-supplied X-Hasura-* headers, so a client cannot guess
// another user's or organization's id.

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const graphqlProxy = createProxyMiddleware({
  target: hasuraTarget,
  changeOrigin: true,
  ws: true,
  pathFilter: '/v1/graphql',
  logLevel: 'error',
});

// Webhook trigger lives on the actions handler; expose it on the same port so
// the preview host can POST /webhook/trigger with x-webhook-token.
const webhookProxy = createProxyMiddleware({
  target: handlerTarget,
  changeOrigin: true,
  pathFilter: '/webhook',
  logLevel: 'error',
});

app.prepare().then(() => {
  const server = http.createServer((req, res) => {
    if (req.url && req.url.startsWith('/v1/graphql')) {
      return graphqlProxy(req, res);
    }
    if (req.url && req.url.startsWith('/webhook')) {
      return webhookProxy(req, res);
    }
    return handle(req, res);
  });

  server.on('upgrade', (req, socket, head) => {
    if (req.url && req.url.startsWith('/v1/graphql')) {
      graphqlProxy.upgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });

  server.listen(port, hostname, () => {
    console.log(`[frontend] ready on http://${hostname}:${port}`);
    console.log(`[frontend] proxying /v1/graphql -> ${hasuraTarget}`);
    console.log(`[frontend] proxying /webhook -> ${handlerTarget}`);
  });
});
