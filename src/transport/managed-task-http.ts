import type { DeploymentTarget } from 'aidcp-kernel/deployment-target.js';
import {
  MANAGED_TASK_CONTRACT,
  type CancelManagedTaskInput,
  type CancelManagedTaskResult,
  type CreateManagedTaskInput,
  type CreateManagedTaskResult,
  type ManagedTaskActor,
  type ManagedTaskCommandPort,
  type ManagedTaskEnvelope,
  type ManagedTaskJson,
  type ManagedTaskProjection,
  type ManagedTaskProjectionState,
  type ManagedTaskRejection,
  type ManagedTaskRejectionCode,
  type QueryManagedTaskInput,
  type QueryManagedTaskResult,
} from 'aidcp-kernel/kernel/managed-task-port.js';
import type { PlatformId } from 'aidcp-kernel/kernel/platform-types.js';
import {
  InternalHttpError,
  type InternalHttpClient,
  type InternalHttpServer,
} from './internal-http.js';

/** Shared route names keep API clients and Automation route registration on one versioned wire. */
export const MANAGED_TASK_ROUTES = {
  create: 'internal/managed-task/v1/create',
  cancel: 'internal/managed-task/v1/cancel',
  query: 'internal/managed-task/v1/query',
} as const;

const REJECTION_CODES = new Set<ManagedTaskRejectionCode>([
  'account_not_authorized',
  'capability_scope_denied',
  'contract_invalid',
  'execution_target_mismatch',
  'feature_disabled',
  'idempotency_collision',
  'invalid_task_request',
  'platform_write_not_supported',
  'protocol_version_mismatch',
  'schema_not_ready',
  'unsupported',
]);

const PROJECTION_STATES = new Set<ManagedTaskProjectionState>([
  'queued',
  'waiting_for_lane',
  'waiting',
  'running',
  'cancelled',
  'completed',
  'partial',
  'failed',
  'submitted_unknown',
  'unsupported',
  'attention_required',
]);

const PLATFORMS = new Set<PlatformId>(['xiaohongshu', 'facebook', 'wechat_channels']);
const ACTOR_KINDS = new Set<ManagedTaskActor['kind']>(['customer', 'operator', 'agent']);

function wireError(code: ManagedTaskRejectionCode, message: string): never {
  throw new InternalHttpError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) wireError('contract_invalid', `${label} must be an object`);
  return value;
}

function exactKeys(value: Record<string, unknown>, label: string, keys: readonly string[]): void {
  const allowed = new Set(keys);
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = keys.filter((key) => !(key in value));
  if (missing.length > 0 || extras.length > 0) {
    wireError(
      'contract_invalid',
      `${label} fields do not match contract; missing=${missing.join(',') || 'none'} extra=${extras.join(',') || 'none'}`,
    );
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    wireError('contract_invalid', `${label} must be a non-empty string`);
  }
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    wireError('contract_invalid', `${label} must be a finite number`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isInteger(value) || Number(value) < minimum) {
    wireError('contract_invalid', `${label} must be an integer >= ${minimum}`);
  }
  return Number(value);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) wireError('contract_invalid', `${label} must be an array`);
  return value.map((item, index) => text(item, `${label}[${index}]`));
}

function jsonValue(value: unknown, label: string, depth = 0): ManagedTaskJson {
  if (depth > 32) wireError('contract_invalid', `${label} exceeds the maximum JSON depth`);
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => jsonValue(item, `${label}[${index}]`, depth + 1));
  }
  const source = record(value, label);
  return Object.fromEntries(
    Object.entries(source).map(([key, item]) => [key, jsonValue(item, `${label}.${key}`, depth + 1)]),
  );
}

function actor(value: unknown): ManagedTaskActor {
  const source = record(value, 'input.actor');
  exactKeys(source, 'input.actor', ['kind', 'actorId', 'customerId', 'authorizationRevision']);
  if (!ACTOR_KINDS.has(source.kind as ManagedTaskActor['kind'])) {
    wireError('contract_invalid', `unsupported actor kind=${String(source.kind)}`);
  }
  return {
    kind: source.kind as ManagedTaskActor['kind'],
    actorId: text(source.actorId, 'input.actor.actorId'),
    customerId: text(source.customerId, 'input.actor.customerId'),
    authorizationRevision: text(
      source.authorizationRevision,
      'input.actor.authorizationRevision',
    ),
  };
}

function createInput(value: unknown): CreateManagedTaskInput {
  const source = record(value, 'create input');
  exactKeys(source, 'create input', [
    'commandId',
    'payloadHash',
    'actor',
    'accountId',
    'envKey',
    'platform',
    'taskDefinition',
    'parameters',
    'capabilityScope',
    'budget',
    'schedule',
  ]);

  const definition = record(source.taskDefinition, 'input.taskDefinition');
  exactKeys(definition, 'input.taskDefinition', ['id', 'version']);
  const scope = record(source.capabilityScope, 'input.capabilityScope');
  exactKeys(scope, 'input.capabilityScope', ['allow', 'deny']);
  const budget = record(source.budget, 'input.budget');
  exactKeys(budget, 'input.budget', [
    'maxBrowserMinutes',
    'maxSteps',
    'maxExecutionAttempts',
    'maxWaitMs',
  ]);
  const schedule = record(source.schedule, 'input.schedule');
  exactKeys(schedule, 'input.schedule', [
    'scheduledAt',
    'latestStartAt',
    'missPolicy',
  ]);
  if (!PLATFORMS.has(source.platform as PlatformId)) {
    wireError('contract_invalid', `unsupported platform=${String(source.platform)}`);
  }
  if (
    schedule.missPolicy !== 'skip'
    && schedule.missPolicy !== 'execute_when_available'
  ) {
    wireError('contract_invalid', `unsupported missPolicy=${String(schedule.missPolicy)}`);
  }

  return {
    commandId: text(source.commandId, 'input.commandId'),
    payloadHash: text(source.payloadHash, 'input.payloadHash'),
    actor: actor(source.actor),
    accountId: text(source.accountId, 'input.accountId'),
    envKey: text(source.envKey, 'input.envKey'),
    platform: source.platform as PlatformId,
    taskDefinition: {
      id: text(definition.id, 'input.taskDefinition.id'),
      version: integer(definition.version, 'input.taskDefinition.version', 1),
    },
    parameters: jsonValue(source.parameters, 'input.parameters'),
    capabilityScope: {
      allow: stringArray(scope.allow, 'input.capabilityScope.allow'),
      deny: stringArray(scope.deny, 'input.capabilityScope.deny'),
    },
    budget: {
      maxBrowserMinutes: finiteNumber(budget.maxBrowserMinutes, 'input.budget.maxBrowserMinutes'),
      maxSteps: integer(budget.maxSteps, 'input.budget.maxSteps', 1),
      maxExecutionAttempts: integer(
        budget.maxExecutionAttempts,
        'input.budget.maxExecutionAttempts',
        1,
      ),
      maxWaitMs: integer(budget.maxWaitMs, 'input.budget.maxWaitMs'),
    },
    schedule: {
      scheduledAt: finiteNumber(schedule.scheduledAt, 'input.schedule.scheduledAt'),
      latestStartAt: finiteNumber(schedule.latestStartAt, 'input.schedule.latestStartAt'),
      missPolicy: schedule.missPolicy,
    },
  };
}

function cancelInput(value: unknown): CancelManagedTaskInput {
  const source = record(value, 'cancel input');
  exactKeys(source, 'cancel input', [
    'commandId',
    'payloadHash',
    'actor',
    'accountId',
    'taskId',
    'expectedAggregateVersion',
    'reason',
  ]);
  return {
    commandId: text(source.commandId, 'input.commandId'),
    payloadHash: text(source.payloadHash, 'input.payloadHash'),
    actor: actor(source.actor),
    accountId: text(source.accountId, 'input.accountId'),
    taskId: text(source.taskId, 'input.taskId'),
    expectedAggregateVersion: integer(
      source.expectedAggregateVersion,
      'input.expectedAggregateVersion',
    ),
    reason: text(source.reason, 'input.reason'),
  };
}

function queryInput(value: unknown): QueryManagedTaskInput {
  const source = record(value, 'query input');
  exactKeys(source, 'query input', ['requestId', 'actor', 'accountId', 'taskId']);
  return {
    requestId: text(source.requestId, 'input.requestId'),
    actor: actor(source.actor),
    accountId: text(source.accountId, 'input.accountId'),
    taskId: text(source.taskId, 'input.taskId'),
  };
}

function envelope<T>(
  value: unknown,
  expectedTarget: DeploymentTarget,
  parseInput: (input: unknown) => T,
): ManagedTaskEnvelope<T> {
  const source = record(value, 'managed task envelope');
  exactKeys(source, 'managed task envelope', [
    'contract',
    'executionTarget',
    'correlationId',
    'causationId',
    'input',
  ]);
  const contract = record(source.contract, 'managed task contract');
  exactKeys(contract, 'managed task contract', ['name', 'version']);
  if (
    contract.name !== MANAGED_TASK_CONTRACT.name
    || contract.version !== MANAGED_TASK_CONTRACT.version
  ) {
    wireError(
      'protocol_version_mismatch',
      `unsupported managed task contract=${String(contract.name)}@${String(contract.version)}`,
    );
  }
  if (source.executionTarget !== expectedTarget) {
    wireError(
      'execution_target_mismatch',
      `request target=${String(source.executionTarget)} does not match receiver target=${expectedTarget}`,
    );
  }
  return {
    contract: MANAGED_TASK_CONTRACT,
    executionTarget: expectedTarget,
    correlationId: text(source.correlationId, 'envelope.correlationId'),
    causationId: nullableText(source.causationId, 'envelope.causationId'),
    input: parseInput(source.input),
  };
}

export function parseCreateManagedTaskEnvelope(
  value: unknown,
  expectedTarget: DeploymentTarget,
): ManagedTaskEnvelope<CreateManagedTaskInput> {
  return envelope(value, expectedTarget, createInput);
}

export function parseCancelManagedTaskEnvelope(
  value: unknown,
  expectedTarget: DeploymentTarget,
): ManagedTaskEnvelope<CancelManagedTaskInput> {
  return envelope(value, expectedTarget, cancelInput);
}

export function parseQueryManagedTaskEnvelope(
  value: unknown,
  expectedTarget: DeploymentTarget,
): ManagedTaskEnvelope<QueryManagedTaskInput> {
  return envelope(value, expectedTarget, queryInput);
}

function rejection(value: unknown): ManagedTaskRejection | null {
  if (!isRecord(value) || value.outcome !== 'rejected') return null;
  responseExactKeys(value, 'managed task rejection', ['outcome', 'code', 'message']);
  if (!REJECTION_CODES.has(value.code as ManagedTaskRejectionCode)) {
    throw new InternalHttpError('bad_response', `unknown rejection code=${String(value.code)}`);
  }
  return {
    outcome: 'rejected',
    code: value.code as ManagedTaskRejectionCode,
    message: responseText(value.message, 'rejection.message'),
  };
}

function responseText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InternalHttpError('bad_response', `${label} must be a non-empty string`);
  }
  return value;
}

function responseInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new InternalHttpError('bad_response', `${label} must be a non-negative integer`);
  }
  return Number(value);
}

function unavailable(value: unknown): { outcome: 'unavailable'; reason: string } | null {
  if (!isRecord(value) || value.outcome !== 'unavailable') return null;
  responseExactKeys(value, 'managed task unavailable result', ['outcome', 'reason']);
  return { outcome: 'unavailable', reason: responseText(value.reason, 'unavailable.reason') };
}

function collision(value: unknown, commandId: string): { outcome: 'collision'; commandId: string } | null {
  if (!isRecord(value) || value.outcome !== 'collision') return null;
  responseExactKeys(value, 'managed task collision result', ['outcome', 'commandId']);
  if (value.commandId !== commandId) {
    throw new InternalHttpError('bad_response', 'collision commandId does not match request');
  }
  return { outcome: 'collision', commandId };
}

function unknownResult(
  value: unknown,
  commandId: string,
): { outcome: 'result_unknown'; commandId: string; lookupRequired: true } | null {
  if (!isRecord(value) || value.outcome !== 'result_unknown') return null;
  responseExactKeys(value, 'managed task unknown result', ['outcome', 'commandId', 'lookupRequired']);
  if (value.commandId !== commandId || value.lookupRequired !== true) {
    throw new InternalHttpError('bad_response', 'result_unknown identity is invalid');
  }
  return { outcome: 'result_unknown', commandId, lookupRequired: true };
}

function parseCreateResult(value: unknown, commandId: string): CreateManagedTaskResult {
  const known = rejection(value) ?? unavailable(value) ?? collision(value, commandId)
    ?? unknownResult(value, commandId);
  if (known) return known;
  if (!isRecord(value) || (value.outcome !== 'applied' && value.outcome !== 'duplicate')) {
    throw new InternalHttpError('bad_response', 'unknown create managed task outcome');
  }
  responseExactKeys(value, 'create managed task receipt', [
    'outcome',
    'commandId',
    'taskId',
    'runId',
    'aggregateVersion',
  ]);
  if (value.commandId !== commandId) {
    throw new InternalHttpError('bad_response', 'create receipt commandId does not match request');
  }
  const runId = value.runId === null ? null : responseText(value.runId, 'receipt.runId');
  return {
    outcome: value.outcome,
    commandId,
    taskId: responseText(value.taskId, 'receipt.taskId'),
    runId,
    aggregateVersion: responseInteger(value.aggregateVersion, 'receipt.aggregateVersion'),
  };
}

function parseCancelResult(value: unknown, commandId: string): CancelManagedTaskResult {
  const known = rejection(value) ?? unavailable(value) ?? collision(value, commandId)
    ?? unknownResult(value, commandId);
  if (known) return known;
  if (!isRecord(value) || (value.outcome !== 'applied' && value.outcome !== 'duplicate')) {
    throw new InternalHttpError('bad_response', 'unknown cancel managed task outcome');
  }
  responseExactKeys(value, 'cancel managed task receipt', [
    'outcome',
    'commandId',
    'taskId',
    'aggregateVersion',
    'dispatchedAttemptReconciliationContinues',
  ]);
  if (value.commandId !== commandId || typeof value.dispatchedAttemptReconciliationContinues !== 'boolean') {
    throw new InternalHttpError('bad_response', 'cancel receipt identity or reconciliation state is invalid');
  }
  return {
    outcome: value.outcome,
    commandId,
    taskId: responseText(value.taskId, 'receipt.taskId'),
    aggregateVersion: responseInteger(value.aggregateVersion, 'receipt.aggregateVersion'),
    dispatchedAttemptReconciliationContinues: value.dispatchedAttemptReconciliationContinues,
  };
}

function projectionTrace(value: unknown): ManagedTaskProjection['trace'][number] {
  const source = responseRecord(value, 'projection trace');
  responseExactKeys(source, 'projection trace', [
    'decisionType',
    'outcome',
    'reasonCode',
    'createdAt',
  ]);
  return {
    decisionType: responseText(source.decisionType, 'trace.decisionType'),
    outcome: responseText(source.outcome, 'trace.outcome'),
    reasonCode: responseText(source.reasonCode, 'trace.reasonCode'),
    createdAt: responseInteger(source.createdAt, 'trace.createdAt'),
  };
}

function responseRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new InternalHttpError('bad_response', `${label} must be an object`);
  return value;
}

function responseExactKeys(
  value: Record<string, unknown>,
  label: string,
  keys: readonly string[],
): void {
  const allowed = new Set(keys);
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = keys.filter((key) => !(key in value));
  if (missing.length > 0 || extras.length > 0) {
    throw new InternalHttpError(
      'bad_response',
      `${label} fields do not match contract; missing=${missing.join(',') || 'none'} extra=${extras.join(',') || 'none'}`,
    );
  }
}

function parseProjection(value: unknown, input: QueryManagedTaskInput): ManagedTaskProjection {
  const source = responseRecord(value, 'managed task projection');
  responseExactKeys(source, 'managed task projection', [
    'taskId',
    'accountId',
    'taskDefinitionId',
    'taskDefinitionVersion',
    'state',
    'reasonCode',
    'confirmedUnits',
    'targetUnits',
    'createdAt',
    'updatedAt',
    'trace',
  ]);
  if (source.taskId !== input.taskId || source.accountId !== input.accountId) {
    throw new InternalHttpError('bad_response', 'query projection identity does not match request');
  }
  if (!PROJECTION_STATES.has(source.state as ManagedTaskProjectionState)) {
    throw new InternalHttpError('bad_response', `unknown projection state=${String(source.state)}`);
  }
  if (!Array.isArray(source.trace)) {
    throw new InternalHttpError('bad_response', 'projection.trace must be an array');
  }
  return {
    taskId: input.taskId,
    accountId: input.accountId,
    taskDefinitionId: responseText(source.taskDefinitionId, 'projection.taskDefinitionId'),
    taskDefinitionVersion: responseInteger(
      source.taskDefinitionVersion,
      'projection.taskDefinitionVersion',
    ),
    state: source.state as ManagedTaskProjectionState,
    reasonCode: source.reasonCode === null
      ? null
      : responseText(source.reasonCode, 'projection.reasonCode'),
    confirmedUnits: responseInteger(source.confirmedUnits, 'projection.confirmedUnits'),
    targetUnits: source.targetUnits === null
      ? null
      : responseInteger(source.targetUnits, 'projection.targetUnits'),
    createdAt: responseInteger(source.createdAt, 'projection.createdAt'),
    updatedAt: responseInteger(source.updatedAt, 'projection.updatedAt'),
    trace: source.trace.map(projectionTrace),
  };
}

function parseQueryResult(value: unknown, input: QueryManagedTaskInput): QueryManagedTaskResult {
  const known = rejection(value) ?? unavailable(value);
  if (known) return known;
  const source = responseRecord(value, 'query managed task result');
  if (source.outcome === 'not_found') {
    responseExactKeys(source, 'query not-found result', ['outcome']);
    return { outcome: 'not_found' };
  }
  if (source.outcome !== 'found') {
    throw new InternalHttpError('bad_response', 'unknown query managed task outcome');
  }
  responseExactKeys(source, 'query found result', ['outcome', 'task']);
  return { outcome: 'found', task: parseProjection(source.task, input) };
}

function wireRejection(error: unknown): ManagedTaskRejection | null {
  if (!(error instanceof InternalHttpError)) return null;
  if (!REJECTION_CODES.has(error.code as ManagedTaskRejectionCode)) return null;
  return {
    outcome: 'rejected',
    code: error.code as ManagedTaskRejectionCode,
    message: error.message,
  };
}

function transportUnavailable(error: unknown): { outcome: 'unavailable'; reason: string } {
  if (!(error instanceof InternalHttpError)) {
    return { outcome: 'unavailable', reason: 'managed_task_transport_unavailable' };
  }
  switch (error.code) {
    case 'route_not_found':
      return { outcome: 'unavailable', reason: 'managed_task_route_unavailable' };
    case 'internal_http_unauthorized':
      return { outcome: 'unavailable', reason: 'managed_task_transport_unauthorized' };
    case 'internal_http_auth_config_invalid':
      return { outcome: 'unavailable', reason: 'managed_task_transport_auth_invalid' };
    case 'timeout':
      return { outcome: 'unavailable', reason: 'managed_task_query_timeout' };
    case 'bad_response':
      return { outcome: 'unavailable', reason: 'managed_task_bad_response' };
    default:
      return { outcome: 'unavailable', reason: 'managed_task_transport_unavailable' };
  }
}

function isKnownNoWrite(error: unknown): boolean {
  return error instanceof InternalHttpError && (
    error.code === 'route_not_found'
    || error.code === 'internal_http_unauthorized'
    || error.code === 'internal_http_auth_config_invalid'
  );
}

export function registerManagedTaskRoutes(
  server: InternalHttpServer,
  local: ManagedTaskCommandPort,
  callerToken: string,
  executionTarget: DeploymentTarget,
): void {
  server.registerBearer(MANAGED_TASK_ROUTES.create, callerToken, (args) =>
    local.create(parseCreateManagedTaskEnvelope(args, executionTarget)));
  server.registerBearer(MANAGED_TASK_ROUTES.cancel, callerToken, (args) =>
    local.cancel(parseCancelManagedTaskEnvelope(args, executionTarget)));
  server.registerBearer(MANAGED_TASK_ROUTES.query, callerToken, (args) =>
    local.query(parseQueryManagedTaskEnvelope(args, executionTarget)));
}

export class ManagedTaskHttpClient implements ManagedTaskCommandPort {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly callerToken: string,
    private readonly executionTarget: DeploymentTarget,
  ) {}

  async create(
    value: ManagedTaskEnvelope<CreateManagedTaskInput>,
  ): Promise<CreateManagedTaskResult> {
    let request: ManagedTaskEnvelope<CreateManagedTaskInput>;
    try {
      request = parseCreateManagedTaskEnvelope(value, this.executionTarget);
    } catch (error) {
      return wireRejection(error) ?? transportUnavailable(error);
    }
    try {
      const result = await this.http.callBearer<unknown>(
        MANAGED_TASK_ROUTES.create,
        request,
        this.callerToken,
      );
      return parseCreateResult(result, request.input.commandId);
    } catch (error) {
      const rejected = wireRejection(error);
      if (rejected) return rejected;
      if (isKnownNoWrite(error)) return transportUnavailable(error);
      return {
        outcome: 'result_unknown',
        commandId: request.input.commandId,
        lookupRequired: true,
      };
    }
  }

  async cancel(
    value: ManagedTaskEnvelope<CancelManagedTaskInput>,
  ): Promise<CancelManagedTaskResult> {
    let request: ManagedTaskEnvelope<CancelManagedTaskInput>;
    try {
      request = parseCancelManagedTaskEnvelope(value, this.executionTarget);
    } catch (error) {
      return wireRejection(error) ?? transportUnavailable(error);
    }
    try {
      const result = await this.http.callBearer<unknown>(
        MANAGED_TASK_ROUTES.cancel,
        request,
        this.callerToken,
      );
      return parseCancelResult(result, request.input.commandId);
    } catch (error) {
      const rejected = wireRejection(error);
      if (rejected) return rejected;
      if (isKnownNoWrite(error)) return transportUnavailable(error);
      return {
        outcome: 'result_unknown',
        commandId: request.input.commandId,
        lookupRequired: true,
      };
    }
  }

  async query(
    value: ManagedTaskEnvelope<QueryManagedTaskInput>,
  ): Promise<QueryManagedTaskResult> {
    let request: ManagedTaskEnvelope<QueryManagedTaskInput>;
    try {
      request = parseQueryManagedTaskEnvelope(value, this.executionTarget);
    } catch (error) {
      return wireRejection(error) ?? transportUnavailable(error);
    }
    try {
      const result = await this.http.callBearer<unknown>(
        MANAGED_TASK_ROUTES.query,
        request,
        this.callerToken,
      );
      return parseQueryResult(result, request.input);
    } catch (error) {
      return wireRejection(error) ?? transportUnavailable(error);
    }
  }
}
