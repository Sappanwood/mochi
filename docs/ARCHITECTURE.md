# Mochi 架构

## 当前状态

已实现 Node.js HTTP 服务、配置校验、Entra JWT 认证及 Pi 无工具会话/provider 适配模块；
应用工具运行时、消息持久化及收据核实已于 2026-09-08 云发布，Write 反向身份和工具配置已部署。
已补充 `FileCredentials` 与独立 Entra 管理入口。统一业务/管理服务已云发布，Files 认证与数据目录由同一活动实例分别持有。真实 Write Managed Identity 已通过业务模型目录认证，本人管理登录正常；两个独立会话已通过真实 Queue/Pi/DeepSeek V4 Flash 正常执行链路，排队时页面断开后原任务可恢复；实际故障、执行中断与跨应用身份隔离仍待验收。

## 已实现服务基础

- `src/config.ts` 校验单租户 issuer、GUID audience、固定角色和一对一调用方映射；无配置时拒绝启动。
- `src/auth.ts` 使用固定 `jose@6.2.12` 验证 RS256、issuer、audience、exp/nbf/iat、tenant 与 v2 版本，
  再验证角色、无 delegated scope 和登记的 azp/oid 对。可选 idtyp 出现时必须为 app；
  未提供 idtyp 时仍要求匹配已登记的 service principal oid，不采用仅 azp 授权。
- `src/server.ts` 在任何非健康路由前验证原始 Bearer token，拒绝重复 Authorization header、
  外部指定 app ID 和普通调用者的管理入口访问。`/v1` 进入应用归属校验和任务控制，管理路由由独立 delegated 验证处理。
- `src/main.ts` 提供配置失败退出、监听与关闭入口。结构化日志只含事件、服务端 request ID、
  状态码、耗时或启动/关闭信息，不记录 URL、headers、token、异常详情或模型内容。
- `GET /health/live` 返回 200；`GET /health/ready` 只有认证/数据拥有者有效且 Queue 首次 receive 成功才返回 200。
  生产没有跳过认证或强制 readiness 的环境开关。

固定工具链为 Node.js 24.x（最低 24.14.1）、TypeScript 7.0.2 和 npm lockfile。
测试使用本地 RSA 签名、两个应用身份与 loopback JWKS，不访问真实 Entra 或模型。
Dockerfile 已提供两阶段非 root 镜像定义，已通过 Podman 构建及非 root 容器 smoke 验证。

## Pi 适配

固定 `@earendil-works/pi-coding-agent@0.85.1` 与 `@earendil-works/pi-ai@0.85.1`。
`src/pi.ts` 的 `createPi(CredentialStore)` 只开放 DeepSeek 的 `api_key` 和 `openai-codex` 的 `oauth`，
后者为 Pi 内置 subscription provider。启动使用内置模型目录和内存模型缓存，禁用远程目录更新与 models.json 发现。
模块依赖调用方提供 store；管理和业务共享同一个 `FileCredentials`，测试同时覆盖内存与真实本地文件。

登录复用 provider 原生交互，在 store 的 `modify` 内完成并保存；不把返回凭据交给业务调用方。
登录 deadline 为五分钟，交互实现必须响应 abort signal。退出使用 store 的串行 delete。
请求认证和 OAuth 刷新继续由 Pi ModelRuntime 执行，刷新全过程依赖同一 store 的 modify 锁。
无凭据、认证类型错误或带命令前缀的 API key 明确拒绝，不能回退到环境凭据。
OAuth 刷新失败或取消时在同一 mutation 内持久写入重新登录标记，阻止并发请求及重启后盲目重试旧 token；
重新登录覆盖该标记，退出删除凭据。该增量已通过真实 SMB 隔离探针并完成维护发布。
个人管理 POST 可显式调用 `refreshOpenAI`，十五秒内由 Pi 原生 refresh 更新并持久保存；不暴露 token、不调用模型。
`status()` 只给出 provider、认证类型和 configured，不刷新 token，也不证明凭据有效。

`openConversation` 创建独立的内存 SessionManager，显式设置空工具列表并禁用所有工具、扩展、skills、
templates、themes 与本地 context files。关闭自动 compaction 和 provider/agent 自动重试，
避免隐式增加模型请求。每次执行由 Files 中成功历史重建内存会话，不让 Pi 直接写 SMB 会话文件。
服务持久 session ID 与固定 system prompt 在该会话的 SDK streamFunction 边界固定，剔除 Pi 自动附加的临时工作目录；
同时透传最大输出 token，保留 SDK 原有认证和流实现，不复制 agent loop。
session 可选的 `thinking_level`（off/minimal/low/medium/high/xhigh/max）从 `Tasks` 持久化，经
`piExecutor` 传入 `createAgentSession.thinkingLevel`。`createPi.models()` 使用 Pi 的
`getSupportedThinkingLevels` 将各模型实际支持档位返回消费者，不自行维护模型到档位的映射；
只改变显式选择它的会话，旧 session 不补字段，也不通过提示文本或空工具集合推断意图。
固定 Pi 0.85.1 将 DeepSeek off 投影为 `thinking:{type:"disabled"}`，省略时继续由 SDK 默认 medium 调整为 high。
不重写 provider 能力处理；不支持 off 的 `openai-codex/gpt-6-astra` 仍由 SDK 调整为 minimal。
HTTP 测试覆盖各档位创建、参数拒绝、持久恢复和后续 run；真实 Pi 与本地假 DeepSeek HTTP 服务验证
off/low/high/max 投影及普通会话默认不变。
该设置不改变 Write 的有限授权校验、截断失败判定或重试策略，Mochi 必须先于 opt-in 消费者发布。
无工具与历史隔离测试使用真实 AgentSession，仅替换 provider stream；认证刷新测试替换 OAuth 网络行为。
这些本地测试不证明 Azure Files SMB 锁、跨进程 fencing、真实 subscription 登录或账户可用性。

Pi 发布包的部分 `.d.ts` 缺少 NodeNext JSON import attributes，传递依赖还引用未声明的可选 MCP 类型；
启用 `skipLibCheck` 跳过依赖声明自身检查，项目源码与测试继续严格类型检查，并运行真实 SDK 测试。

## 组件方向

管理入口为 `admin-main.ts → admin-server.ts → AdminControl → Pi → FileCredentials`。
独立维护入口仍可启动；`main.ts` 在同一进程组合管理 handler 与业务路由，共享认证拥有者、Pi 与 AdminControl。
两个入口不得同时持有相同认证目录；业务入口还要求不与认证目录重叠的数据目录及 Queue 配置。
`main.ts` 完全未配置 `MOCHI_ADMIN_*` 时保持原 API-only 模式，不挂管理 handler；任何部分管理配置均拒绝启动，
不降级绕过认证。统一模式同时验证业务配置与完整管理配置，仍只有一个凭据拥有者。
Entra 个人 delegated scope 与本人 oid 白名单独立于应用 `Mochi.Invoke` 认证。
管理端 bootstrap 静态资源可匿名，管理 API 必须重新验证 Bearer token、Origin 与短期管理会话。
独立 HTTPS 地址通过 ACA 托管路径路由只公开管理资源；Container App 保持内部 ingress，业务路径不进入公网路由。
具体接口、安全边界、文件恢复和部署验收契约见 [管理服务](ADMIN.md)。

浏览器 → Web app 后端 → Mochi 内部应用认证与 Agent API → Pi runtime → 模型 provider。
Mochi 统一持有 provider 认证，不同应用使用独立 AgentSession、工具配置与工作目录。
首期采用单一活动认证拥有者，多个消费者不要求复制多份 OAuth 凭据。

## 认证与持久化

保留 Pi 的 provider catalog、登录和自动刷新能力。首期认证持久化已选择 Mochi 专属 Azure Files，
采用 Standard LRS 按量付费与 SMB 挂载方向，优先验证原生可写 auth.json 的适配；不为 provider 认证引入 Key Vault。
认证挂载 /var/lib/mochi/auth（MOCHI_AUTH_DIR），会话与任务使用独立数据共享 /var/lib/mochi/data（MOCHI_DATA_DIR）；缓存放 /tmp/mochi。
固定 SDK 已验证 provider/AgentSession 接口。原生文件 backend 直接覆盖文件且有 stale-lock 接管机制，
当前采用兼容 auth.json 布局的 FileCredentials adapter，以原子替换和不自动抢占的拥有者落实维护交接。
持久介质仍为已选 Azure Files；已通过实际 ACA SMB 隔离文件/模拟刷新竞争/发布前故障探针，以及停机跨 revision 交接和 Azure Backup 隔离凭据恢复；真实 OAuth 刷新已由本人管理页验证成功。
认证共享不挂载给 Web app，也不暴露给应用工具；备份同样作为敏感凭据保护。
API key 的持久化保存与 runtime override 必须区分；OAuth 刷新后的凭据必须写回持久存储。
配置、认证、模型目录缓存和各应用会话分别识别，禁止把凭据写入镜像或日志。

各 provider 的设备码、回调或手工授权输入分别适配；浏览器 localhost 不指向 ACA 容器。
不保证认证永不失效，必须处理撤销和重新登录。

## 并发与权限边界

部署交接和维护也可能引入实例重叠，不能用 maxReplicas=1 代替认证所有权协调。
需要多个执行实例时，明确刷新全过程的串行化和最新凭据读取策略。
默认不注册应用工具；显式工具会话遵循文末应用工具运行时契约。不向 Agent 开放任意 shell 或模型生成代码执行能力，不部署独立工具执行容器。
后续应用工具采用服务端明确配置的 allowlist；按已认证应用校验资源归属，模型参数不得扩大命令、目标地址或文件访问范围。
未来若引入任意代码执行，需要独立于凭据拥有者的执行环境，另行设计权限、文件交付和生命周期。
认证所有权采用排他 `.owner/` 与实例 ID，无超时抢占；正常关闭等待 mutation 完成，失权或存储故障停止操作。
异常锁仅在确认旧实例停止后恢复，不预设对抗恶意同用户 ancestor 替换。实测边界与恢复步骤见管理服务文档。

## 数据所有权与部署

Mochi 拥有执行会话、任务状态和 provider 认证；消费者拥有正文、角色等 canonical 业务数据。
共享资源由 `ccp` 提供，Mochi 定义镜像、配置、健康检查和存储需求。
首期长任务在 Mochi 服务边界内处理，不部署 ACA Jobs 或独立工具执行器；具体持久状态与事件契约见 [Agent API](API.md)。
初始资源为 0.5 vCPU / 1 GiB；允许空闲缩容至零、接受冷启动等待，须验证运行中任务的保护机制。
容器监听 0.0.0.0:8080（PORT=8080），/health/live 检查进程，/health/ready 检查初始化、存储和认证所有权；探针不调用付费模型。
每个应用后端使用独立 Managed Identity 获取 Mochi API 的 Entra app-only token，由已验证身份决定 app_id；管理入口独立校验个人登录和管理员身份。Mochi Actions 构建并推送 ACR、手动发布自身 digest；CCP 管理非镜像基础设施。

## 应用访问认证契约

CCP 配置单租户 Entra API app registration、Application-only 的 `Mochi.Invoke` 角色、调用方 Managed Identity 的角色授予和 ACA Easy Auth；不为应用间调用创建静态 API Key 或 client secret。API 采用 v2 access token，客户端通过 ManagedIdentityCredential 请求 `api://<mochi-api-client-id>/.default`。
Mochi 从 `MOCHI_AUTH_MODE=entra`、`MOCHI_ENTRA_ISSUER`、`MOCHI_ENTRA_AUDIENCE`、`MOCHI_ENTRA_ROLE=Mochi.Invoke`、`MOCHI_ENTRA_CALLERS` 读取非敏感配置。CALLERS 是 app_id 到 client_id/principal_id 的 JSON 映射；配置缺失或冲突时默认拒绝业务请求。
使用成熟 JWT 库验证原始 Authorization Bearer token 的签名、允许算法、issuer、audience、有效期、tenant 和角色，并按调用方 `azp` 与 `oid` 的对应关系映射 app_id。拒绝 delegated 用户 token、无角色、未登记身份和请求伪造 app_id；随后检查 run/session 和工具归属。不能仅解码 JWT 或只信任客户端身份 header。
应用从启动起执行认证，因为 Container App 和 Easy Auth 是分步创建的资源，不能假设平台认证已经启用。只有 /health/live、/health/ready 可匿名，且只返回最小健康状态；其他接口在无认证时返回 401，有效身份越权时返回 403。
普通调用角色不允许管理 provider；个人登录和管理员授权仍由独立管理入口实现。OAuth token、provider API key 和应用访问 token 分别管理，不把访问 token 写入 Files 或日志。移除调用方要同时更新目录角色和服务端/平台 allowlist；不能承诺已签发 token 因角色撤销立即失效。
本地使用 mock issuer/JWKS 验证签名与拒绝路径；真实 token、首次部署窗口、Easy Auth 被禁用时的应用保护及两应用隔离由部署阶段与 CCP 联合验证，不调用付费模型。

## 技术方向与官方入口

运行时以 Pi SDK 为核心，已固定 TypeScript 与 Pi 0.85.1；统一云服务与首个 app 的 Managed Identity 接入已验证。真实 DeepSeek V4 Flash 的两个会话任务已成功；执行中断、故障恢复与跨应用身份隔离仍待 MOC-004。当前发布证据见 [管理服务](ADMIN.md#统一服务云发布)。

- [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [Pi providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md)
- [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)
- [OpenAI subscription 与 API key 认证](https://learn.chatgpt.com/docs/auth)
- [Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/overview)
- [ACA Entra 服务间认证](https://learn.microsoft.com/en-us/azure/container-apps/authentication-entra#daemon-client-application-service-to-service-calls)

## Queue 试用方向

首期引入 Azure Storage Queue 试用，由现有 Mochi 服务负责消费，不新增独立 worker 容器或 ACA Jobs；资源、权限与缩容规则由 ccp 提供。
验证持久排队、从零唤醒、执行中消息续期及缩容协调。任务状态与消息派发职责分开，持久化状态与入队失败的边界须处理。
消息重复或超时重新出现不授权自动重放有副作用的任务；按任务 ID 去重，结果不确定时记录中断并允许明确重试。
实际平台上的缩容行为尚未验证。会话、任务状态与事件采用 Azure Files 文件存储，按 app_id/session_id/run_id 隔离；单一活动写入者负责落盘与恢复，不在 SMB 上运行 SQLite。
首期串行执行 Agent 任务；提交请求支持应用范围内幂等键，先保存任务再入队，两者成功后才确认接受。入队失败可按应用幂等 key 查询或原请求补发，终态消息不重跑。

## 验证方向

覆盖认证恢复、刷新持久化、凭据失效、并发刷新、应用会话隔离和敏感信息不进入客户端。
在实际 Azure Files SMB 挂载上验证锁定、文件替换、写失败和备份恢复；本地文件锁测试不能代替该证据。
验证工具 allowlist、越权参数拒绝及默认 shell/代码执行工具未启用。
真实 subscription 登录及模型调用按实际账户与授权范围验证，不能用 mock 宣称兼容全部 provider。


## 持久任务实现与恢复

`TaskStore → Tasks → AzureQueue → piExecutor` 分别负责文件所有权、状态/应用授权、消息租约与 Pi 执行。
固定 `@azure/storage-queue@12.31.0` 与 `@azure/identity@4.13.2`。沿用 CCP 的
`MOCHI_QUEUE_ACCOUNT_URL`、`MOCHI_QUEUE_NAME`、可选 `AZURE_CLIENT_ID`，仅 Managed Identity，
不创建 Queue、不读取管理属性，不扩大既定消息发送/处理权限。
消息为 base64 编码 JSON `{schema_version:1,app_id,run_id}`，TTL 为 -1；不包含 prompt 或 token。
每轮消费前核对 queued/dispatched=false 的持久 outbox，仅补发这些未开始任务；暂时发送失败停止就绪并按一秒间隔重试，
不需要进程重启或应用再次 POST，关闭过程不派发。receive visibility 60 秒，20 秒续期并使用最新 pop receipt。服务首期全局只有一个消费者/执行者；
续期失败立即 abort 并记录 interrupted，消息不删除，后续根据终态去重。Queue 故障停止就绪并关闭服务，
不能把进程存活当作队列健康。未知/错误消息形状或 app/run 不匹配不会执行模型，停止服务等待维护核对。

数据共享是已存在、受信任的 Linux/容器目录；沿路径验证静态 symlink，文件拒绝 symlink、hardlink 和非普通文件。
数据有独立 `.owner/id` 排他拥有者，每秒核对且每次读写重新核对，无过期抢占。目录结构为
`<data>/<app_id>/<session_id>/session.json` 和 `<run_id>.json`；session 固定前缀，run 保存输入、状态、
输出、usage 与单调 events。文件先以 wx 创建同目录临时文件，fsync 后 rename，再 fsync 目录；
任务/状态与事件写在同一 JSON，避免半条 append 事件。正常并发由单拥有者和进程内串行写协调；不承诺恶意 ancestor-swap 防护，
不使用 native helper。全局队列派发顺序不承诺跨会话 FIFO；同会话只允许一个未完成 run。

运行时缓存文件投影，重启只在取得所有权后加载；格式损坏/半建会话目录使启动失败，不猜测修复、不丢弃文件。
异常退出留下 `.owner` 必须确认旧进程/旧 revision 停止后，由维护流程移除 exact `.owner/id` 与空目录。
先备份并核对半写/损坏记录，再恢复，不递归清空数据；已持久 running 转 interrupted，queued 重新派发，终态不重放。
运行停止先断队列和模型、等待任务终态与管理 mutation，再释放 data/auth 所有者；45 秒未结束则失败退出并保留锁。
本地测试覆盖此文件模型；Azure Files/Queue 实际故障、从零唤醒、执行中缩容和备份恢复必须由 MOC-004 实测。

应用请求预算保守使用 UTF-8 字节上界与目录 context window，不自动截断/压缩；完整输出仅接受 provider stop。
返回 usage 来自 provider，缺失或零占位为 null；重建历史所需的内部零 usage 占位不汇总为当前调用计量。
每次执行用随机隔离临时工作目录，不发现本地文件，结束清理。持久历史仍按 app/session 隔离。

官方 SDK 参考：[Azure QueueClient](https://learn.microsoft.com/javascript/api/@azure/storage-queue/queueclient?view=azure-node-latest)、
[Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)。

## 镜像发布所有权

应用 GitHub Actions 在本仓库 main 通过 OIDC 构建、推送并发布 image digest。CCP 的两个 ACA 资源仅忽略 image 字段，其余配置仍受 Terraform 管理。发布不读取 Terraform state，不调用 CCP workflow；触发与维护边界见 [README](../README.md#github-actions-日常发布)。

## 应用工具运行时

[应用工具契约](APP_TOOLS.md)是双方接入接口：按已认证 app 静态绑定回调地址、反向 Entra audience 和工具 allowlist，
会话固定 system prompt/schema/version 快照，run 固定业务 scope 与有限预算。Pi 0.85.1 注册 customTools 并显式传入 tools 名单；
仅 provider 参数投影为根 oneOf 补充等价的 `type:object`；持久快照/hash 和后端严格分支校验不变，
避免 DeepSeek 将缺少根类型的工具参数判为无效 schema。
保留默认无工具，禁用 built-in 工具与本地资源发现，不复制 Agent loop。

Write 经独立无工具 Mochi 会话解释原始用户消息；Write 后端校验有限授权并拥有草稿、章节、原子幂等收据和撤回顺序。
Mochi 不决定业务授权，也不让应用接触 provider 凭据。正式业务 OP 在 run 提交前固定；完整消息和调用记录先持久再派发，
工具成功后先持久收据再继续模型。未知结果经固定认证 endpoint 核实，进程恢复不重放副作用。

第一切片为已有故事取材、独立草稿与最多一章新建，采用独立意图解释的语义误判剩余风险已接受。
`src/app-tools.ts` 校验静态配置/schema并通过 Managed Identity 调用固定 endpoint；`src/tool-execution.ts` 将快照映射为
sequential customTools，等待消息、调用和收据持久屏障。`Tasks` 保存完整 Pi 消息、调用、产物、累计 usage 和业务收据，
终态 POST operations/verify 可更新核实证据而不改变模型终态。Pi agent.subscribe 的 await listener 负责消息屏障。
回调生产身份和角色由 CCP 配置，2026-09-08 已完成反向 MI 角色与两端环境配置部署。
运行版本、真实业务验收及其边界见 [创作工具云发布](ADMIN.md#创作工具云发布)。


### 同会话作品初始化

新增 initialize_story v1 支持带有界数组的根 oneOf 参数，canonical 快照/hash 仍不可变；provider 投影继续仅补根 type:object。
Write 拥有预留 story、完整初始化包、人物来源版本、授权和单分区业务事务；Mochi 持久区分初始化草稿和普通章节草稿，
校验 story_initialized / first_chapter_saved 收据及精确包引用，不通过伪造 chapter_id 表示零章作品。
固定 OP 只接受一种工具版本和精确 draft 引用，重试不扩写入槽；同一 run 先建作品后写另一正式章被拒绝，下一轮新授权可继续原 session。
未知 OP 从原 invocation 和不可变工具快照核实，响应丢失、取消、模型失败及重启不抹去已保存业务成果。
运行时本地确定性 Pi/HTTP 验证覆盖这些边界；应用事务、真实回调身份和生产发布仍由跨项目交付验收。
