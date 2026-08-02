import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  API_DIRECT_PORT_INVENTORY,
  API_DIRECT_TOKEN_ENV,
  AUTOMATION_COMMAND_TOKEN_ENV,
  CONTENT_COMMAND_TOKEN_ENV,
} from 'aidcp-kernel/kernel/api-direct-port.js';
import { API_DIRECT_ROUTE_INVENTORY } from '../../src/transport/api-direct-http.js';

test('4a transport exports exactly the admitted 21-group/58-slot route surface', () => {
  const contractGroups = Object.keys(API_DIRECT_PORT_INVENTORY);
  const routeGroups = Object.keys(API_DIRECT_ROUTE_INVENTORY);
  assert.deepEqual(routeGroups, contractGroups);
  assert.equal(
    Object.values(API_DIRECT_PORT_INVENTORY).reduce(
      (total, methods) => total + methods.length,
      0,
    ),
    58,
  );
  for (const group of contractGroups) {
    const methods = API_DIRECT_PORT_INVENTORY[group as keyof typeof API_DIRECT_PORT_INVENTORY];
    const routes = API_DIRECT_ROUTE_INVENTORY[group as keyof typeof API_DIRECT_ROUTE_INVENTORY];
    assert.deepEqual(Object.keys(routes), [...methods], `${group} route/client parity`);
  }
});

test('4a transport keeps direction-specific bearer token authorities distinct', () => {
  assert.equal(API_DIRECT_TOKEN_ENV, 'AIDCP_API_INTERNAL_TOKEN');
  assert.equal(AUTOMATION_COMMAND_TOKEN_ENV, 'AIDCP_AUTOMATION_INTERNAL_TOKEN');
  assert.equal(CONTENT_COMMAND_TOKEN_ENV, 'AIDCP_CONTENT_INTERNAL_TOKEN');
  assert.equal(new Set([
    API_DIRECT_TOKEN_ENV,
    AUTOMATION_COMMAND_TOKEN_ENV,
    CONTENT_COMMAND_TOKEN_ENV,
  ]).size, 3);
});

test('4a transport excludes owner-local and earlier/later batch methods', () => {
  const admitted = JSON.stringify(API_DIRECT_PORT_INVENTORY);
  for (const excluded of [
    'listPendingApprovalIds',
    'pendingPublishPreviewForRecord',
    'claimExecutionTarget',
    'resolveCardChatId',
    'resolveAccountChatId',
    'bindBotChat',
    'recordDecision',
    'weekActiveMask',
  ]) {
    assert.doesNotMatch(admitted, new RegExp(excluded));
  }
});
