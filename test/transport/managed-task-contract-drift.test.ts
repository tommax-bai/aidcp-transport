import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MANAGED_TASK_CONTRACT,
  type CreateManagedTaskInput,
  type ManagedTaskCommandPort,
  type ManagedTaskEnvelope,
} from 'aidcp-kernel/kernel/managed-task-port.js';
import {
  InternalHttpClient,
  InternalHttpError,
  InternalHttpServer,
} from '../../src/transport/internal-http.js';
import {
  MANAGED_TASK_CONTRACT as TRANSPORT_MANAGED_TASK_CONTRACT,
  MANAGED_TASK_ROUTES,
  ManagedTaskHttpClient,
  registerManagedTaskRoutes,
} from '../../src/transport/managed-task-http.js';

const TOKEN = 'managed-task-drift-token';

function request(): ManagedTaskEnvelope<CreateManagedTaskInput> {
  return {
    contract: MANAGED_TASK_CONTRACT,
    executionTarget: 'dev',
    correlationId: 'drift-correlation',
    causationId: null,
    input: {
      commandId: 'drift-create',
      payloadHash: 'drift-hash',
      actor: {
        kind: 'operator',
        actorId: 'operator-1',
        customerId: 'customer-1',
        authorizationRevision: 'auth-1',
      },
      accountId: 'account-1',
      envKey: 'env-1',
      platform: 'facebook',
      taskDefinition: { id: 'persona.research', version: 1 },
      parameters: { query: 'research' },
      capabilityScope: {
        allow: ['research.search', 'research.browse', 'research.assess', 'research.summarize'],
        deny: [],
      },
      budget: {
        maxBrowserMinutes: 5,
        maxSteps: 4,
        maxExecutionAttempts: 8,
        maxWaitMs: 60_000,
      },
      schedule: {
        scheduledAt: 1_000,
        latestStartAt: 2_000,
        missPolicy: 'skip',
      },
    },
  };
}

test('route version and kernel contract version advance as one explicit v1 boundary', () => {
  assert.deepEqual(MANAGED_TASK_CONTRACT, { name: 'managed-task', version: 1 });
  assert.equal(TRANSPORT_MANAGED_TASK_CONTRACT, MANAGED_TASK_CONTRACT);
  assert.deepEqual(Object.values(MANAGED_TASK_ROUTES), [
    'internal/managed-task/v1/create',
    'internal/managed-task/v1/cancel',
    'internal/managed-task/v1/query',
  ]);
});

test('Automation endpoint rejects unknown wire name/version before the owner port', async () => {
  let calls = 0;
  const owner: ManagedTaskCommandPort = {
    create: async () => {
      calls += 1;
      return { outcome: 'unavailable', reason: 'not_used' };
    },
    cancel: async () => ({ outcome: 'unavailable', reason: 'not_used' }),
    query: async () => ({ outcome: 'unavailable', reason: 'not_used' }),
  };
  const server = new InternalHttpServer();
  registerManagedTaskRoutes(server, owner, TOKEN, 'dev');
  const port = await server.listen(0);
  const raw = new InternalHttpClient(`http://127.0.0.1:${port}`);
  try {
    for (const contract of [
      { name: 'managed-task-next', version: 1 },
      { name: 'managed-task', version: 2 },
    ]) {
      const drifted = structuredClone(request()) as unknown as Record<string, unknown>;
      drifted.contract = contract;
      await assert.rejects(
        () => raw.callBearer(MANAGED_TASK_ROUTES.create, drifted, TOKEN),
        (error: unknown) => error instanceof InternalHttpError
          && error.code === 'protocol_version_mismatch',
      );
    }
    assert.equal(calls, 0);
  } finally {
    await server.close();
  }
});

test('unknown definition versions and capabilities cross the wire but remain explicit owner rejections', async () => {
  let calls = 0;
  const owner: ManagedTaskCommandPort = {
    create: async (envelope) => {
      calls += 1;
      const exactDefinition = envelope.input.taskDefinition.id === 'persona.research'
        && envelope.input.taskDefinition.version === 1;
      const exactCapabilities = envelope.input.capabilityScope.allow.every((capability) =>
        capability.startsWith('research.'));
      if (!exactDefinition || !exactCapabilities) {
        return {
          outcome: 'rejected',
          code: 'unsupported',
          message: 'definition or capability is not registered',
        };
      }
      return { outcome: 'unavailable', reason: 'not_used' };
    },
    cancel: async () => ({ outcome: 'unavailable', reason: 'not_used' }),
    query: async () => ({ outcome: 'unavailable', reason: 'not_used' }),
  };
  const server = new InternalHttpServer();
  registerManagedTaskRoutes(server, owner, TOKEN, 'dev');
  const port = await server.listen(0);
  const client = new ManagedTaskHttpClient(
    new InternalHttpClient(`http://127.0.0.1:${port}`),
    TOKEN,
    'dev',
  );
  try {
    const unknownVersion = request();
    unknownVersion.input.taskDefinition.version = 2;
    const unknownCapability = request();
    unknownCapability.input.commandId = 'drift-capability';
    unknownCapability.input.capabilityScope.allow.push('platform.publish');

    for (const drifted of [unknownVersion, unknownCapability]) {
      assert.deepEqual(await client.create(drifted), {
        outcome: 'rejected',
        code: 'unsupported',
        message: 'definition or capability is not registered',
      });
    }
    assert.equal(calls, 2);
  } finally {
    await server.close();
  }
});
