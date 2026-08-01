import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MANAGED_TASK_CONTRACT,
  type CancelManagedTaskInput,
  type CreateManagedTaskInput,
  type ManagedTaskCommandPort,
  type ManagedTaskEnvelope,
  type QueryManagedTaskInput,
} from 'aidcp-kernel/kernel/managed-task-port.js';
import {
  InternalHttpClient,
  InternalHttpError,
  InternalHttpServer,
} from '../../src/transport/internal-http.js';
import {
  MANAGED_TASK_ROUTES,
  ManagedTaskHttpClient,
  registerManagedTaskRoutes,
} from '../../src/transport/managed-task-http.js';

const TOKEN = 'managed-task-test-token';

const actor = {
  kind: 'operator' as const,
  actorId: 'operator-1',
  customerId: 'customer-1',
  authorizationRevision: 'auth-1',
};

function createInput(commandId = 'create-1'): CreateManagedTaskInput {
  return {
    commandId,
    payloadHash: `hash-${commandId}`,
    actor,
    accountId: 'account-1',
    envKey: 'env-1',
    platform: 'facebook',
    taskDefinition: { id: 'persona.research', version: 1 },
    parameters: { query: 'market research' },
    capabilityScope: {
      allow: ['research.search', 'research.browse', 'research.assess', 'research.summarize'],
      deny: ['platform.write'],
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
  };
}

function cancelInput(commandId = 'cancel-1'): CancelManagedTaskInput {
  return {
    commandId,
    payloadHash: `hash-${commandId}`,
    actor,
    accountId: 'account-1',
    taskId: 'task-1',
    expectedAggregateVersion: 1,
    reason: 'operator requested cancellation',
  };
}

function queryInput(): QueryManagedTaskInput {
  return {
    requestId: 'query-1',
    actor,
    accountId: 'account-1',
    taskId: 'task-1',
  };
}

function envelope<T>(input: T): ManagedTaskEnvelope<T> {
  return {
    contract: MANAGED_TASK_CONTRACT,
    executionTarget: 'dev',
    correlationId: 'correlation-1',
    causationId: null,
    input,
  };
}

function ownerPort() {
  const calls: Array<{ method: string; envelope: ManagedTaskEnvelope<unknown> }> = [];
  const port: ManagedTaskCommandPort = {
    create: async (request) => {
      calls.push({ method: 'create', envelope: request });
      if (request.input.taskDefinition.id !== 'persona.research'
        || request.input.taskDefinition.version !== 1) {
        return {
          outcome: 'rejected',
          code: 'unsupported',
          message: 'task definition is not registered',
        };
      }
      return {
        outcome: request.input.commandId.includes('duplicate') ? 'duplicate' : 'applied',
        commandId: request.input.commandId,
        taskId: 'task-1',
        runId: 'run-1',
        aggregateVersion: 1,
      };
    },
    cancel: async (request) => {
      calls.push({ method: 'cancel', envelope: request });
      if (request.input.commandId.includes('collision')) {
        return { outcome: 'collision', commandId: request.input.commandId };
      }
      return {
        outcome: 'applied',
        commandId: request.input.commandId,
        taskId: request.input.taskId,
        aggregateVersion: 2,
        dispatchedAttemptReconciliationContinues: true,
      };
    },
    query: async (request) => {
      calls.push({ method: 'query', envelope: request });
      return {
        outcome: 'found',
        task: {
          taskId: request.input.taskId,
          accountId: request.input.accountId,
          taskDefinitionId: 'persona.research',
          taskDefinitionVersion: 1,
          state: 'queued',
          reasonCode: null,
          confirmedUnits: 0,
          targetUnits: 4,
          createdAt: 1_000,
          updatedAt: 1_001,
          trace: [{
            decisionType: 'admission',
            outcome: 'selected',
            reasonCode: 'task_admitted',
            createdAt: 1_000,
          }],
        },
      };
    },
  };
  return { calls, port };
}

async function withManagedTaskServer(
  run: (context: {
    raw: InternalHttpClient;
    client: ManagedTaskHttpClient;
    calls: ReturnType<typeof ownerPort>['calls'];
  }) => Promise<void>,
): Promise<void> {
  const server = new InternalHttpServer();
  const { calls, port } = ownerPort();
  registerManagedTaskRoutes(server, port, TOKEN, 'dev');
  const portNumber = await server.listen(0);
  const raw = new InternalHttpClient(`http://127.0.0.1:${portNumber}`);
  try {
    await run({ raw, client: new ManagedTaskHttpClient(raw, TOKEN, 'dev'), calls });
  } finally {
    await server.close();
  }
}

test('authenticated v1 routes preserve target, command receipts, and safe query projection', async () => {
  await withManagedTaskServer(async ({ client, calls }) => {
    const created = await client.create(envelope(createInput()));
    const cancelled = await client.cancel(envelope(cancelInput()));
    const queried = await client.query(envelope(queryInput()));

    assert.deepEqual(created, {
      outcome: 'applied',
      commandId: 'create-1',
      taskId: 'task-1',
      runId: 'run-1',
      aggregateVersion: 1,
    });
    assert.deepEqual(cancelled, {
      outcome: 'applied',
      commandId: 'cancel-1',
      taskId: 'task-1',
      aggregateVersion: 2,
      dispatchedAttemptReconciliationContinues: true,
    });
    assert.equal(queried.outcome, 'found');
    assert.deepEqual(calls.map((call) => call.method), ['create', 'cancel', 'query']);
    assert.ok(calls.every((call) => call.envelope.executionTarget === 'dev'));
    assert.ok(calls.every((call) => call.envelope.contract === MANAGED_TASK_CONTRACT));
  });
});

test('duplicate, collision, and owner rejection remain distinguishable across HTTP', async () => {
  await withManagedTaskServer(async ({ client }) => {
    const duplicate = await client.create(envelope(createInput('create-duplicate')));
    const collisionResult = await client.cancel(envelope(cancelInput('cancel-collision')));
    const unsupported = createInput('create-unsupported');
    unsupported.taskDefinition = { id: 'persona.unknown', version: 1 };
    const rejected = await client.create(envelope(unsupported));

    assert.equal(duplicate.outcome, 'duplicate');
    assert.deepEqual(collisionResult, {
      outcome: 'collision',
      commandId: 'cancel-collision',
    });
    assert.deepEqual(rejected, {
      outcome: 'rejected',
      code: 'unsupported',
      message: 'task definition is not registered',
    });
  });
});

test('Bearer rejection and disabled routes are named unavailable outcomes with zero owner calls', async () => {
  await withManagedTaskServer(async ({ raw, calls }) => {
    const unauthorized = new ManagedTaskHttpClient(raw, 'wrong-token', 'dev');
    assert.deepEqual(await unauthorized.create(envelope(createInput())), {
      outcome: 'unavailable',
      reason: 'managed_task_transport_unauthorized',
    });
    assert.equal(calls.length, 0);
  });

  const server = new InternalHttpServer();
  const portNumber = await server.listen(0);
  try {
    const client = new ManagedTaskHttpClient(
      new InternalHttpClient(`http://127.0.0.1:${portNumber}`),
      TOKEN,
      'dev',
    );
    assert.deepEqual(await client.create(envelope(createInput())), {
      outcome: 'unavailable',
      reason: 'managed_task_route_unavailable',
    });
    assert.deepEqual(await client.query(envelope(queryInput())), {
      outcome: 'unavailable',
      reason: 'managed_task_route_unavailable',
    });
  } finally {
    await server.close();
  }
});

test('server rejects contract version, target, and shape drift before calling the owner', async () => {
  await withManagedTaskServer(async ({ raw, calls }) => {
    const valid = envelope(createInput()) as unknown as Record<string, unknown>;
    const badVersion = structuredClone(valid) as Record<string, unknown>;
    badVersion.contract = { name: 'managed-task', version: 2 };
    const badTarget = structuredClone(valid) as Record<string, unknown>;
    badTarget.executionTarget = 'ol';
    const extraField = structuredClone(valid) as Record<string, unknown>;
    extraField.unexpected = true;

    for (const [value, expectedCode] of [
      [badVersion, 'protocol_version_mismatch'],
      [badTarget, 'execution_target_mismatch'],
      [extraField, 'contract_invalid'],
    ] as const) {
      await assert.rejects(
        () => raw.callBearer(MANAGED_TASK_ROUTES.create, value, TOKEN),
        (error: unknown) => error instanceof InternalHttpError && error.code === expectedCode,
      );
    }
    assert.equal(calls.length, 0);
  });
});

test('client rejects local target and input drift without sending a request', async () => {
  let calls = 0;
  const http = {
    callBearer: async () => {
      calls += 1;
      throw new Error('must not send');
    },
  } as unknown as InternalHttpClient;
  const client = new ManagedTaskHttpClient(http, TOKEN, 'dev');
  const wrongTarget = envelope(createInput());
  wrongTarget.executionTarget = 'ol';
  const badInput = envelope(createInput()) as unknown as Record<string, unknown>;
  (badInput.input as Record<string, unknown>).unexpected = true;

  assert.deepEqual(await client.create(wrongTarget), {
    outcome: 'rejected',
    code: 'execution_target_mismatch',
    message: 'request target=ol does not match receiver target=dev',
  });
  const invalid = await client.create(
    badInput as unknown as ManagedTaskEnvelope<CreateManagedTaskInput>,
  );
  assert.equal(invalid.outcome, 'rejected');
  assert.equal(invalid.outcome === 'rejected' && invalid.code, 'contract_invalid');
  assert.equal(calls, 0);
});

test('ambiguous write failures become stable result_unknown once and queries stay unavailable', async () => {
  let calls = 0;
  const http = {
    callBearer: async () => {
      calls += 1;
      throw new InternalHttpError('timeout', 'response timed out after dispatch');
    },
  } as unknown as InternalHttpClient;
  const client = new ManagedTaskHttpClient(http, TOKEN, 'dev');

  assert.deepEqual(await client.create(envelope(createInput('create-timeout'))), {
    outcome: 'result_unknown',
    commandId: 'create-timeout',
    lookupRequired: true,
  });
  assert.deepEqual(await client.cancel(envelope(cancelInput('cancel-timeout'))), {
    outcome: 'result_unknown',
    commandId: 'cancel-timeout',
    lookupRequired: true,
  });
  assert.deepEqual(await client.query(envelope(queryInput())), {
    outcome: 'unavailable',
    reason: 'managed_task_query_timeout',
  });
  assert.equal(calls, 3, 'the client must not retry with a new or repeated command id');
});

test('malformed or identity-mismatched responses never become business success', async () => {
  const malformed = {
    callBearer: async (route: string) => {
      if (route === MANAGED_TASK_ROUTES.create) {
        return { outcome: 'applied', commandId: 'wrong-command' };
      }
      if (route === MANAGED_TASK_ROUTES.cancel) {
        return { outcome: 'collision', commandId: 'wrong-command' };
      }
      return {
        outcome: 'found',
        task: {
          taskId: 'task-1',
          accountId: 'another-account',
        },
      };
    },
  } as unknown as InternalHttpClient;
  const client = new ManagedTaskHttpClient(malformed, TOKEN, 'dev');

  assert.deepEqual(await client.create(envelope(createInput('create-malformed'))), {
    outcome: 'result_unknown',
    commandId: 'create-malformed',
    lookupRequired: true,
  });
  assert.deepEqual(await client.cancel(envelope(cancelInput('cancel-malformed'))), {
    outcome: 'result_unknown',
    commandId: 'cancel-malformed',
    lookupRequired: true,
  });
  assert.deepEqual(await client.query(envelope(queryInput())), {
    outcome: 'unavailable',
    reason: 'managed_task_bad_response',
  });
});
