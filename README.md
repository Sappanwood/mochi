# Mochi

面向个人多个 Web app 的云端 Pi Agent 执行核心，部署目标为 Azure Container Apps。

## 当前状态

已建立 Node.js/TypeScript 服务基础、Entra app-only JWT 认证和本地测试入口。
已接入固定 Pi SDK 的无工具会话及 DeepSeek API key / OpenAI subscription 适配模块。
已实现 auth.json 持久凭据、排他所有权，以及独立的 Entra 个人认证管理页面；已部署独立 HTTPS 管理入口，用户已验证 DeepSeek key 保存和 OpenAI 登录。
管理地址：[Mochi 认证管理](https://mochiadmin.whitemeadow-6e32159b.eastus.azurecontainerapps.io)。
已实现统一管理/业务入口、持久会话/任务、Azure Queue 派发与事件恢复；本地真实 HTTP/Pi SDK 接缝已接通。
统一业务/管理服务已云发布，真实 Write Managed Identity 读取模型目录返回 200，伪造 app 绑定返回 403，本人管理登录正常。停机交接后认证与数据共享均由新实例持有，凭据内容保持不变。两个独立会话已通过真实 DeepSeek V4 Flash 调用与 Queue 正常任务链路，其中一份草稿采纳后刷新一致，另一任务排队时页面断开后恢复成功。执行中中断、进程恢复、跨应用身份隔离及业务故障恢复仍待 MOC-004 验收；发布与验收边界见 [管理服务](docs/ADMIN.md#统一服务云发布)。

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

## GitHub Actions 日常发布

main 的应用相关变更通过质量检查后自动构建和推送；发布由手动 workflow 触发。PR 执行质量检查，不请求 Azure OIDC。纯文档 push 不触发构建或部署。

`.github/workflows/ci.yml` 使用 Node.js 24.14.1、Dockerfile 和 linux/amd64，完成现有质量门禁后，
通过本 Repo main 的 OIDC 身份推送 `mochia4c005ba3f.azurecr.io/mochi`。Actions Summary 和 `image`
artifact 的 `image.json` 保存 commit、build run ID 和不可变 digest；镜像使用 commit tag，实际发布按 digest。

重新部署：在 Actions → **Deploy verified build** → **Run workflow** 选择 main，填写本 Repo 某次成功
**CI and image** 的 run ID。入口验证来源为本 Repo main push、workflow 与 commit 相符，再读取其 image artifact。
回到旧版本时，从上一次成功部署 Summary 找到 build run ID，使用同一入口；不会重新构建或修改 Terraform。
构建记录和成功部署记录保留 90 天，过期 artifact 不能通过此入口部署，需重新构建。部署失败保留失败日志，不自动回滚。

两个发布入口共用 Repo 内 `production-deploy` concurrency group，不取消正在运行的发布；GitHub 只保留一个 pending job，
更多排队请求可能替换此前 pending，且不保证排队次序。每次发布后核对 Summary 的 commit/digest/revision。
Mochi 由本人协调停止接单、在途任务、备份及旧 owner 释放，并先停止 ACA。发布入口核对 Stopped 后更新 image 并 start，不自动排空、停止或备份。readiness 由 ACA 探针和 latestReadyRevisionName 验证，公网检查管理页面与匿名 `/admin/providers` 返回 401；GitHub runner 不访问内部业务域名。公网检查对超时、连接错误及 502/503/504 最多尝试六次，间隔十秒；其他非预期状态立即失败。

CCP/Terraform 管理 ACA、身份权限、环境变量、挂载及缩放等非镜像配置；本 Repo 的 workflow 只传入目标容器和 image。
Terraform 精确忽略 `template[0].container[0].image`，避免基础设施更新回退已发布版本；基础设施操作期间由本人协调暂停应用发布。
Azure RBAC 的 Container App write 无法限制为单独 image 字段，image-only 是受信任 main workflow 的代码约束。

仓库使用已有 Variables：`AZURE_CLIENT_ID`、`AZURE_TENANT_ID`、`AZURE_SUBSCRIPTION_ID`、`ACR_NAME`。
不配置 GitHub environment（会改变现有 main OIDC subject），不使用 Azure client secret、跨仓库 PAT 或 GitHub App。
本地发布脚本行为检查：`python3 -m unittest discover -s scripts -p 'test_*.py'`。

2026-09-07 [运行 34120009601](https://github.com/Sappanwood/mochi/actions/runs/34120009601) 已完成真实质量检查、OIDC 和 ACR 推送，
提交 `3f28e0741bc7cfddb6e72d18092e280d54b41005`，构建 digest `sha256:2938fe6b19be1de720bba66e4b8f90bf9fc47704530345af772de52510f90376`。
新增 ACA 发布权限已部署并读回；首次手动生产发布尚未执行，不能用构建成功替代发布验收。
