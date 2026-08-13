import { createClient } from 'graphql-ws';

const GRAPHQL_PATH = '/v1/graphql';

export async function gqlRequest(query, variables = {}, headers = {}) {
  const res = await fetch(GRAPHQL_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    const err = new Error(json.errors[0].message);
    err.errors = json.errors;
    throw err;
  }
  return json.data;
}

export function subscribeToRun(query, variables, headers, handlers) {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${window.location.host}${GRAPHQL_PATH}`;
  const client = createClient({
    url,
    connectionParams: { headers },
  });
  let unsubscribe = () => {};
  const subscription = client.subscribe(
    { query, variables },
    {
      next: (result) => {
        if (result.errors) {
          handlers.onError?.(result.errors[0]);
          return;
        }
        handlers.onData?.(result.data);
      },
      error: (err) => handlers.onError?.(err),
      complete: () => handlers.onComplete?.(),
    },
  );
  unsubscribe = subscription;
  return unsubscribe;
}
