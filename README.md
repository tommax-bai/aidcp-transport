# aidcp-transport

`aidcp-api` / `aidcp-automation` / `aidcp-content` 三个服务共享的**跨进程传输层**。

## 为什么它必须是一个包，而不是复制三份

包里的 7 个能力文件各自同时导出三样东西：

- `registerXxxRoutes(server, impl)` —— **服务端**注册；
- `XxxHttpClient` —— **客户端**；
- `XXX_ROUTES` —— 夹在两者中间的**路径常量表**。

一个仓用服务端、另一个仓用客户端。**复制成两份，两端的路径就会悄悄对不上**，
而且**没有任何机械手段看得见**：两侧各自编译通过、各自测试通过，只有真跑起来才 404。

这与本项目「两份边云协议文件必须逐字一致」是同一个问题，区别只在协议那边有穷举类型兜着、
这边什么都没有。**一个包 = 一份定义 = 不可能漂。**

## 与 `aidcp-kernel` 的分工

| | kernel | transport（本包） |
| --- | --- | --- |
| 装什么 | 零副作用的类型 / 接口 / 常量 / 纯函数 | **有副作用**但三家都要的运行时原语 |
| 准入 | 禁 SQL / HTTP / 供应商标识符 / 模块级 Set·Map | 允许 HTTP；**禁任何属主表的 SQL** |
| 典型 | 契约、DTO、纯判定 | 内部 HTTP 骨架、路由注册与客户端 |

`internal-http.ts` 是本包存在的直接原因：它 `createServer(...)`，**永远进不了 kernel**，
但三个服务都要用它起自己的内部端点。

## 不在本包里的（有意的）

带**属主表 SQL** 或只有一家用的，一律随属主留在业务仓：
事件 outbox、账号投影存储、风控命令 outbox、outbox 桥接 / 健康 / 通知监听。
判据是「**三家都可能调用 + 不含任何属主表的 SQL**」——比 kernel 宽，比复制三份严。

## 同步方式

本包**不手工维护**：内容由控制仓 `aidcp` 的 `scripts/sync-split-repos` 从
`aidcp-cloud` 的属主清单重放。要改这里的代码，改 `aidcp-cloud/src/transport/` 再同步。
