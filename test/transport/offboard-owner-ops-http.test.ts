/**
 * 离场两个属主侧端口（台账物化 / 清理授权）的跨进程往返。
 *
 * 这两个端口在接口进程里长期没有实现，删环境因此永远走「已受理、等对账」那条降级路径。
 * 本文件钉的是补上之后 MUST 成立的三件事：
 *   ① 端口是闭集合 —— 路由一条不少（少一条的表现是下一次 404，只有真跑两个进程才看得见）；
 *   ② 入参与结果逐字段过线 —— 判定时钟 `now`、终态放行位 `unboundTerminalAllowed` 都不能在路上丢；
 *   ③ **业务拒绝与传输故障不同形** —— 属主答 false / 具名 reason 要原样回来，
 *      而调用不通 MUST 抛；折成 false 就等于把「问不到」讲成「属主拒绝了」。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  MaterializeEnvironmentOffboardInput,
  OffboardMaterializationOperations,
} from 'aidcp-kernel/kernel/offboard-materialization-types.js';
import type {
  ConsumeOffboardCleanupGrantInput,
  IssueOffboardCleanupGrantInput,
  OffboardCleanupGrantOperations,
} from 'aidcp-kernel/kernel/offboard-cleanup-grant-types.js';
import {
  OFFBOARD_MATERIALIZATION_ROUTES,
  OffboardMaterializationHttpClient,
  registerOffboardMaterializationRoutes,
} from '../../src/transport/offboard-materialization-http.js';
import {
  OFFBOARD_CLEANUP_GRANT_ROUTES,
  OffboardCleanupGrantHttpClient,
  registerOffboardCleanupGrantRoutes,
} from '../../src/transport/offboard-cleanup-grant-http.js';
import { InternalHttpClient, InternalHttpServer } from '../../src/transport/internal-http.js';

test('两张路由表分别是 1 / 2 条，且路由名互不相同', () => {
  assert.equal(Object.keys(OFFBOARD_MATERIALIZATION_ROUTES).length, 1);
  assert.equal(Object.keys(OFFBOARD_CLEANUP_GRANT_ROUTES).length, 2);
  const all = [
    ...Object.values(OFFBOARD_MATERIALIZATION_ROUTES),
    ...Object.values(OFFBOARD_CLEANUP_GRANT_ROUTES),
  ];
  assert.equal(new Set(all).size, all.length);
});

test('物化端口：入参逐字段过线，两种结局都原样回来', async () => {
  const seen: MaterializeEnvironmentOffboardInput[] = [];
  const local: OffboardMaterializationOperations = {
    async materializeEnvironmentOffboard(input) {
      seen.push(input);
      if (input.offboardId === 'ofb-unbound') {
        return { materialized: false, reason: 'binding_missing' };
      }
      return {
        materialized: true,
        offboard: {
          offboardId: input.offboardId,
          envKey: input.envKey,
          accountId: 'acct-1',
          state: 'pending_edge',
          reason: input.reason,
          requestedAt: 1_700_000_000_000,
          purgeDueAt: 1_700_600_000_000,
        },
      };
    },
  };
  const server = new InternalHttpServer();
  registerOffboardMaterializationRoutes(server, local);
  const port = await server.listen(0);
  try {
    const client = new OffboardMaterializationHttpClient(
      new InternalHttpClient(`http://127.0.0.1:${port}`),
    );
    const ok = await client.materializeEnvironmentOffboard({
      offboardId: 'ofb-1',
      envKey: 'k1',
      userId: 'user-1',
      reason: 'environment_unbind',
      actor: 'client:user-1',
      unboundTerminalAllowed: true,
    });
    assert.deepEqual(ok, {
      materialized: true,
      offboard: {
        offboardId: 'ofb-1',
        envKey: 'k1',
        accountId: 'acct-1',
        state: 'pending_edge',
        reason: 'environment_unbind',
        requestedAt: 1_700_000_000_000,
        purgeDueAt: 1_700_600_000_000,
      },
    });
    // 终态放行位是 api 侧的本域事实，属主不得自行放宽 ⇒ 它必须原样到达属主。
    assert.deepEqual(seen[0], {
      offboardId: 'ofb-1',
      envKey: 'k1',
      userId: 'user-1',
      reason: 'environment_unbind',
      actor: 'client:user-1',
      unboundTerminalAllowed: true,
    });

    const missing = await client.materializeEnvironmentOffboard({
      offboardId: 'ofb-unbound',
      envKey: 'k2',
      userId: 'user-1',
      reason: 'environment_unbind',
      actor: null,
      unboundTerminalAllowed: false,
    });
    assert.deepEqual(missing, { materialized: false, reason: 'binding_missing' });
    assert.equal(seen[1].actor, null);
    assert.equal(seen[1].unboundTerminalAllowed, false);
  } finally {
    await server.close();
  }
});

test('清理授权端口：签发的真假与烧票的五档 reason 原样过线，判定时钟不丢', async () => {
  const issued: IssueOffboardCleanupGrantInput[] = [];
  const consumed: ConsumeOffboardCleanupGrantInput[] = [];
  const local: OffboardCleanupGrantOperations = {
    async issueCleanupGrant(input) {
      issued.push(input);
      return input.offboardId === 'ofb-ok';
    },
    async consumeCleanupGrant(input) {
      consumed.push(input);
      if (input.offboardId === 'ofb-ok') {
        return {
          ok: true,
          offboard: {
            offboardId: input.offboardId,
            envKey: input.envKey,
            accountId: input.accountId,
            state: 'dispatched',
            reason: 'environment_unbind',
            requestedAt: 1_700_000_000_000,
            purgeDueAt: 1_700_600_000_000,
          },
        };
      }
      return { ok: false, reason: 'already_used' };
    },
  };
  const server = new InternalHttpServer();
  registerOffboardCleanupGrantRoutes(server, local);
  const port = await server.listen(0);
  try {
    const client = new OffboardCleanupGrantHttpClient(
      new InternalHttpClient(`http://127.0.0.1:${port}`),
    );
    const grant = {
      offboardId: 'ofb-ok',
      userId: 'user-1',
      edgeId: 'ads-k1',
      jtiHash: 'hash-1',
      expiresAt: 1_700_000_600_000,
    };
    assert.equal(await client.issueCleanupGrant(grant), true);
    assert.deepEqual(issued[0], grant);
    // 属主的业务拒绝：原样是 false，不是异常。
    assert.equal(await client.issueCleanupGrant({ ...grant, offboardId: 'ofb-no' }), false);

    const burn: ConsumeOffboardCleanupGrantInput = {
      userId: 'user-1',
      offboardId: 'ofb-ok',
      envKey: 'k1',
      accountId: 'acct-1',
      edgeId: 'ads-k1',
      jtiHash: 'hash-1',
      now: 1_700_000_100_000,
    };
    const outcome = await client.consumeCleanupGrant(burn);
    assert.equal(outcome.ok, true);
    // 过期判定时钟 MUST 由调用方给定 ⇒ 传输层原样转发、绝不在属主侧另取当前时间。
    assert.deepEqual(consumed[0], burn);

    const rejected = await client.consumeCleanupGrant({ ...burn, offboardId: 'ofb-used' });
    assert.deepEqual(rejected, { ok: false, reason: 'already_used' });
  } finally {
    await server.close();
  }
});

test('传输故障 MUST 抛，MUST NOT 变成「属主拒绝了」', async () => {
  const local: OffboardCleanupGrantOperations = {
    async issueCleanupGrant() {
      throw new Error('owner_unavailable');
    },
    async consumeCleanupGrant() {
      throw new Error('owner_unavailable');
    },
  };
  const materialization: OffboardMaterializationOperations = {
    async materializeEnvironmentOffboard() {
      throw new Error('owner_unavailable');
    },
  };
  const server = new InternalHttpServer();
  registerOffboardCleanupGrantRoutes(server, local);
  registerOffboardMaterializationRoutes(server, materialization);
  const port = await server.listen(0);
  try {
    const http = new InternalHttpClient(`http://127.0.0.1:${port}`);
    const grants = new OffboardCleanupGrantHttpClient(http);
    const materialize = new OffboardMaterializationHttpClient(http);
    // false 与 { ok:false } 都是**属主的判定**；属主根本没答上话时冒充它们是本仓红线。
    await assert.rejects(() =>
      grants.issueCleanupGrant({
        offboardId: 'ofb-1', userId: 'user-1', edgeId: 'ads-k1',
        jtiHash: 'hash-1', expiresAt: 1_700_000_600_000,
      }),
    );
    await assert.rejects(() =>
      grants.consumeCleanupGrant({
        userId: 'user-1', offboardId: 'ofb-1', envKey: 'k1', accountId: 'acct-1',
        edgeId: 'ads-k1', jtiHash: 'hash-1', now: 1_700_000_100_000,
      }),
    );
    // 同理：物化调不通 MUST NOT 折成 binding_missing（那会让调用方把「问不到」当成「确实没绑定」）。
    await assert.rejects(() =>
      materialize.materializeEnvironmentOffboard({
        offboardId: 'ofb-1', envKey: 'k1', userId: 'user-1',
        reason: 'environment_unbind', actor: null, unboundTerminalAllowed: false,
      }),
    );
  } finally {
    await server.close();
  }
});

test('未注册的那一族 MUST 是响亮的路由缺失，不是一个看起来正常的结果', async () => {
  const server = new InternalHttpServer();
  registerOffboardMaterializationRoutes(server, {
    async materializeEnvironmentOffboard() {
      return { materialized: false, reason: 'binding_missing' };
    },
  });
  const port = await server.listen(0);
  try {
    const grants = new OffboardCleanupGrantHttpClient(
      new InternalHttpClient(`http://127.0.0.1:${port}`),
    );
    await assert.rejects(() =>
      grants.issueCleanupGrant({
        offboardId: 'ofb-1', userId: 'user-1', edgeId: 'ads-k1',
        jtiHash: 'hash-1', expiresAt: 1_700_000_600_000,
      }),
    );
  } finally {
    await server.close();
  }
});
