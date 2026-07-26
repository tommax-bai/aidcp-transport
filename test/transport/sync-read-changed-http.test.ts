import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  registerSyncReadChangedRoute,
  SyncReadChangedHttpClient,
} from '../../src/transport/sync-read-changed-http.js';
import {
  InternalHttpClient,
  InternalHttpServer,
} from '../../src/transport/internal-http.js';

test('changed signal is target-injected and acknowledged after the handler', async () => {
  const handled: unknown[] = [];
  const server = new InternalHttpServer();
  registerSyncReadChangedRoute(
    server,
    {
      async handle(signal) {
        handled.push(signal);
      },
    },
    { executionTarget: 'dev', bearerToken: 'secret' },
  );
  const port = await server.listen(0);
  try {
    const client = new SyncReadChangedHttpClient(
      new InternalHttpClient(`http://127.0.0.1:${port}`),
      { executionTarget: 'dev', bearerToken: 'secret' },
    );
    await client.deliver({ stream: 'edge_presence', generation: '3' });
    assert.deepEqual(handled, [
      {
        contractVersion: 1,
        executionTarget: 'dev',
        stream: 'edge_presence',
        generation: '3',
      },
    ]);
  } finally {
    await server.close();
  }
});

test('handler failure is returned to the relay caller without an acknowledgement', async () => {
  const server = new InternalHttpServer();
  registerSyncReadChangedRoute(
    server,
    {
      async handle() {
        throw new Error('checkpoint_failed');
      },
    },
    { executionTarget: 'dev', bearerToken: 'secret' },
  );
  const port = await server.listen(0);
  try {
    const client = new SyncReadChangedHttpClient(
      new InternalHttpClient(`http://127.0.0.1:${port}`),
      { executionTarget: 'dev', bearerToken: 'secret' },
    );
    await assert.rejects(
      client.deliver({ stream: 'publish_in_flight', generation: '4' }),
      /checkpoint_failed/,
    );
  } finally {
    await server.close();
  }
});
