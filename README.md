# Mochi

面向个人多个 Web app 的云端 Pi Agent 执行核心，部署目标为 Azure Container Apps。

## 当前状态

已建立 Node.js/TypeScript 服务基础、Entra app-only JWT 认证和本地测试入口。
已接入固定 Pi SDK 的无工具会话及 DeepSeek API key / OpenAI subscription 适配模块。
已实现 auth.json 持久凭据、排他所有权，以及独立的 Entra 个人认证管理页面；已部署独立 HTTPS 管理入口，用户已验证 DeepSeek key 保存和 OpenAI 登录。
管理地址：[Mochi 认证管理](https://mochiadmin.whitemeadow-6e32159b.eastus.azurecontainerapps.io)。
业务 HTTP 路由、持久任务和 Queue 留待首个 app 联调。业务入口 `/health/ready` 仍固定 503；
管理入口独立检查认证目录与所有权。

## 项目入口

- [产品规格](docs/PRODUCT_SPEC.md)：目标、范围与初期验收方向。
- [架构](docs/ARCHITECTURE.md)：组件职责与跨项目边界。
- [Agent 指引](AGENTS.md)：开发与 ProjectOps 操作入口。
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
| `PORT` | 容器默认 `8080`；本地长期服务须先登记独立端口 |

GUID 使用小写。配置缺失或冲突时启动失败。生产 JWKS 地址由固定 Microsoft 域名与 tenant 派生，
不接受请求指定的 issuer、JWKS 地址或平台身份 header 作为认证依据。服务监听 `0.0.0.0`。
目前只有 `GET /health/live` 与 `GET /health/ready` 匿名；其他请求先认证，未实现路由返回 404，
普通调用者访问 `/admin` 或提供 `x-app-id` / `app_id` query 返回 403。

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
