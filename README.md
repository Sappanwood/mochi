# Mochi

面向个人多个 Web app 的云端 Pi Agent 执行核心，部署目标为 Azure Container Apps。

## 当前状态

已建立 Node.js/TypeScript 服务基础、Entra app-only JWT 认证和本地测试入口。
已接入固定 Pi SDK 的无工具会话及 DeepSeek API key / OpenAI subscription 适配模块。
已实现 auth.json 持久凭据、排他所有权，以及独立的 Entra 个人认证管理页面；已部署独立 HTTPS 管理入口，用户已验证 DeepSeek key 保存和 OpenAI 登录。
管理地址：[Mochi 认证管理](https://mochiadmin.whitemeadow-6e32159b.eastus.azurecontainerapps.io)。
已实现统一管理/业务入口、持久会话/任务、Azure Queue 派发与事件恢复；本地真实 HTTP/Pi SDK 接缝已接通。
当前云部署仍为已验收的管理版本；统一服务、真实 Queue/数据共享与模型联调留 MOC-004。

## 项目入口

- [产品规格](docs/PRODUCT_SPEC.md)：目标、范围与初期验收方向。
- [架构](docs/ARCHITECTURE.md)：组件职责与跨项目边界。
- [Agent 指引](AGENTS.md)：开发与 ProjectOps 操作入口。
- [Agent API](docs/API.md)：会话、幂等任务、事件恢复、预算与错误契约。
- [管理服务](docs/ADMIN.md)：Entra 配置、独立启动、认证文件与所有权交接。

## 项目管理

项目 ID 为 `mochi`。在所属 ProjectOps workspace 或 Repo 中执行：

```bash
pops project list --json
pops project doctor --json
pops backlog list mochi --json
pops docs check mochi --json
```

## 本地开发

使用 Node.js 24.14.1 或更新的 24.x、npm 与 lockfile：

```bash
npm ci --ignore-scripts
npm run check
```

`check` 执行无付费模型测试、类型检查和服务端/管理页构建。HTTP/JWKS 测试只监听 loopback 临时端口，
需要运行环境允许本地监听；测试 runner 显式关闭进程隔离以核对实际用例结果。

构建后 `npm start` 启动 `dist/main.js`，必须提供以下非敏感配置：

| 变量 | 值 |
|---|---|
| `MOCHI_AUTH_MODE` | `entra` |
| `MOCHI_ENTRA_ISSUER` | `https://login.microsoftonline.com/<tenant-id>/v2.0` |
| `MOCHI_ENTRA_AUDIENCE` | Mochi API app 的 client ID，GUID，不含 `api://` |
| `MOCHI_ENTRA_ROLE` | `Mochi.Invoke` |
| `MOCHI_ENTRA_CALLERS` | `{"my-app":{"client_id":"<caller-client-id>","principal_id":"<caller-object-id>"}}` |
| `MOCHI_DATA_DIR` | 已存在的独立可写绝对目录，容器 `/var/lib/mochi/data`，不得与 auth 目录重叠 |
| `MOCHI_QUEUE_ACCOUNT_URL` | `https://<account>.queue.core.windows.net` |
| `MOCHI_QUEUE_NAME` | 已创建的 Queue 名称 |
| `AZURE_CLIENT_ID` | 可选 user-assigned Managed Identity client ID；省略用 system-assigned |
| `PORT` | 容器默认 `8080`；本地长期服务须先登记独立端口 |

`MOCHI_AUTH_DIR` 是两种业务启动方式的必需配置。完全不提供 `MOCHI_ADMIN_*` 时保持 API-only；
提供任何管理变量时必须通过 [管理配置](docs/ADMIN.md) 的完整校验，启用同进程统一入口，共享凭据拥有者。
不完整管理配置不能退回 API-only。
Queue 使用 Managed Identity，不接受 SAS/连接串，不自动创建资源；最小权限为发送与处理消息。
GUID 使用小写。配置缺失或冲突时启动失败。生产 JWKS 地址由固定 Microsoft 域名与 tenant 派生，
不接受请求指定的 issuer、JWKS 地址或平台身份 header 作为认证依据。服务监听 `0.0.0.0`。
业务仅 `GET /health/live` 与 `GET /health/ready` 匿名；管理 shell/static/config 按管理契约公开。
readiness 要求两个目录所有权与 Queue 消费初始化有效，不调用模型或额外的 Queue 管理 API。
提供 `x-app-id` / `app_id` query 拒绝；管理请求使用独立 delegated 验证，不能用普通业务 token。

## 容器

```bash
docker build -t mochi:local .
```

Dockerfile 使用两阶段构建和非 root 用户，构建上下文仅包含源码及构建清单。
已使用 Podman 构建 linux/amd64 镜像并推送 ACR，验证非 root 管理启动、静态资源、匿名拒绝、凭据恢复与 SIGTERM 释放锁。
云端认证、SMB 与交接验收状态见管理服务文档。

## 首期对话范围

只做无工具对话，应用工具后续按 app 需求补充。provider 限定：

- DeepSeek：API key 模式，Pi provider ID 为 `deepseek`。
- OpenAI：ChatGPT subscription OAuth，Pi provider ID 为 `openai-codex`，不使用 OpenAI API key fallback。

`src/pi.ts` 复用 Pi 0.85.1 的 provider 登录、刷新、模型目录和 AgentSession。
模型 ID 由模块的 `models()` 返回，`status()` 仅表示存储中存在对应类型凭据，不证明账户当前有效。
无工具会话关闭 extensions、skills、prompt templates 和本地上下文发现。
独立管理入口使用 `npm run start:admin`，提供 key 保存和 OpenAI 设备码授权；所需 Entra 与目录配置见
[管理服务](docs/ADMIN.md)。测试使用临时/内存数据和 mock provider，不读取个人凭据。
