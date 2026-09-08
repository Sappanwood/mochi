# Mochi Agent API

## 工具扩展

[应用工具契约](APP_TOOLS.md)定义会话工具快照、run scope/预算、callback、完整 Pi 历史和收据核实；既有扩展已发布，
新增初始化工具的运行时支持已完成本地验证，消费者接入和云发布另行验收。
本文其余部分描述默认无工具 API；扩展不改变旧会话和客户端的响应形状。工具会话 opt-in 的 history?format=pi-v1
返回完整消息；POST /v1/runs/:id/operations/verify 核实终态未知业务 OP，保持模型终态及原始证据。
初始化 run 的 operations.receipt 为严格 story_initialized / first_chapter_saved union；artifacts 和 artifact_created
增加 artifact_kind:story_initialization 与 includes_chapter。核实时从持久 invocation 和原 session 工具快照核对工具版本、story/OP
和精确 draft 引用；旧 create_chapter 收据及草稿不补新字段。新会话可从创建时固定完整生命周期工具集合，按新 run scope 继续写作。
参数 schema 新增有界 array（maxItems 必填且最多 16），完整契约和示例见上述文档。

## 范围与认证

`/v1` 由 Web app 后端调用；生产用 Managed Identity 获取 `api://<MOCHI_ENTRA_AUDIENCE>/.default`。
服务器完整验证原始 Entra app-only JWT，并由 `azp/oid` 映射唯一 `app_id`；不接受调用者指定 app 身份。
业务 token 不能进入个人管理 API；公开管理 shell 与管理认证契约见 [ADMIN.md](ADMIN.md)。
provider 只有 DeepSeek API key 与 OpenAI subscription (`openai-codex`)；默认无工具，不允许扩展、本地文件发现或自动重试。
本文与应用工具契约描述已实现接口；各项生产发布状态以 [管理服务](ADMIN.md) 为准。真实 Write Managed Identity 经 Queue/Pi 调用 DeepSeek V4 Flash 的两个独立会话任务已成功；其中一个任务在 queued 时页面断开，重开后通过原 run 恢复成功而未重发。该证据不覆盖 running 中断、进程恢复、两个 app_id 隔离或缩容故障；完整验收边界见 [管理服务](ADMIN.md#真实写作调用验收)。

请求/响应 JSON 使用 snake_case，写请求必须为 `application/json`，拒绝未知字段；请求体上限 128 KiB。
响应 `Cache-Control: no-store`，错误为 `{ "error": "code" }`，日志只记录请求 ID、状态与耗时，不记录内容、token 或 provider 原始错误。
未知对象返回 404 `not_found`；其他应用的已存在对象返回 403 `forbidden`。仅已登记同用户应用可调用。

## 会话与模型

| 方法 / 路径 | 输入 | 响应 |
|---|---|---|
| `GET /v1/models` | 无 | `{models:[{provider,id,name,auth,context_window,max_output_tokens}]}` |
| `POST /v1/sessions` | `{system_prompt?:string,thinking_level?:"off"}` | 201 `{session_id,created_at,system_prompt,thinking_level?:"off"}` |
| `GET /v1/sessions/:id` | 无 | `{session_id,created_at,system_prompt,thinking_level?:"off"}` |
| `GET /v1/sessions/:id/history` | 无 | `{messages:[{role,content,run_id}]}` |

`session_id` 由服务器生成 UUID。`system_prompt` 非空、最多 64 KiB UTF-8；省略使用无工具对话默认提示。
创建后不可修改；需要改变固定前缀时创建新会话。模型请求使用该精确前缀与持久 session ID，不附加临时工作目录。
`thinking_level` 只接受可选值 `"off"`，其他值（包括 null）返回 400 `invalid_request`。
它是创建时固定、持久恢复的 session 设置，所有后续 run 都向 Pi SDK 请求同一 thinking level，run 不接受覆盖。
省略时不补字段，沿用 SDK 默认；不根据提示文本或是否有工具决定 thinking。
当前 Pi 0.85.1 的 DeepSeek 模型支持 off，并投影为 `thinking:{type:"disabled"}`；省略时 SDK 默认 medium 调整为 high。
模型不支持的 level 仍按 SDK 能力调整：当前 `openai-codex/gpt-6-astra` 的 off 会调整为 minimal，因此此字段不保证所有模型均能关闭 thinking。
参数不改变工具快照、业务授权、输出预算或完整输出判定；独立意图解释可显式使用，创作和旧 session 保持原配置。
消费者发送新字段前须先发布支持它的 Mochi，旧 runtime 会拒绝未知字段。
模型目录是固定 Pi 版本的能力目录，`auth` 为 `api_key` 或 `oauth`；不证明账户已授权某模型或凭据可用。
历史仅包含成功完整回合，以 user/assistant 文本成对返回；失败或取消的 partial 输出不进入下轮上下文。
同一会话只接受一个未结束任务（其余提交 409 `session_busy`），不同会话可排队，服务全局串行执行。

## 任务与幂等

`POST /v1/sessions/:id/runs`：

```json
{"idempotency_key":"application-request-uuid","provider":"deepseek","model":"<catalog-id>","prompt":"本轮输入","max_output_tokens":4096}
```

`idempotency_key` 为应用范围非空字符串，最多 128 UTF-8 字节；prompt 最多 64 KiB。
provider/model 必须由目录选择，不设默认模型。`max_output_tokens` 可省略，取 `min(4096, model.max_output_tokens)`；
显式值必须为正整数且不超过目录限制。服务保守按 UTF-8 字节估计输入 token，计算固定前缀、成功历史、本轮输入、
消息开销及输出预算；超过 context_window 返回 400 `context_budget_exceeded`，不自动截断、compaction 或增加模型调用。
这是保守准入上界估计，不是 provider tokenizer 的精确计量。

相同应用 key 与相同规范化输入/会话始终返回同一 run；异 payload 或会话返回 409 `idempotency_conflict`。
先持久落任务，再入 Queue，两者成功才返回 202。入队失败返回 503 `queue_unavailable`；已持久任务仍可按 key 查询，
以原 key 重试会补发，不创建新任务；服务的运行期 outbox 也会在下一次空闲消费轮次补发未确认派发的 queued 任务。网络响应丢失时先按 key 查询或原请求重试，不自动换 key。
同一 key 的终态结果不可重跑；用户明确重试需新 key。

| 方法 / 路径 | 输入 / 响应 |
|---|---|
| `GET /v1/runs/by-key?key=...` | 当前应用 key 的 run；无记录 404 |
| `GET /v1/runs/:id` | run |
| `POST /v1/runs/:id/cancel` | 空 JSON `{}`；返回 run，可重复 |

run 固定形状：

```json
{"run_id":"uuid","session_id":"uuid","status":"succeeded","created_at":"UTC ISO-8601","updated_at":"UTC ISO-8601","result":{"text":"完整输出"},"error":null,"usage":{"input":10,"output":2,"cache_read":4,"cache_write":0,"total_tokens":16}}
```

状态为 `queued`、`running`、`succeeded`、`failed`、`cancelled`、`interrupted`。
仅 `succeeded` 的 `result.text` 是可采纳完整输出；其他状态 result 为 null。length 截断、工具调用或缺少完整
assistant stop 结果视为 `failed/incomplete_output`。缓存与 token 使用量来自 provider 实际 usage，不推算命中；未知为 null。
取消先保存终态再发 abort，晚到 provider 结果不覆盖取消状态；远端是否已经产生计费无法由取消响应保证。
进程恢复时 `running` 如实标为 `interrupted/process_interrupted`，queued 可重新派发；终态消息重复不重新执行。

主要错误 code：401 认证失败；403 `forbidden`；400 `invalid_request`、`unsupported_model`、
`output_budget_exceeded`、`context_budget_exceeded`、`invalid_cursor`；409 `session_busy`、`idempotency_conflict`；
413 `request_too_large`；415 `json_required`；503 `queue_unavailable`、`not_ready`。
任务失败安全 code 为 `authentication_required`、`unsupported_model`、`incomplete_output`、`output_limit`、
`provider_failed`、`process_interrupted` 或 `execution_interrupted`；不返回 provider 原始异常或凭据。

## 事件与断线恢复

`GET /v1/runs/:id/events?after=0` 返回：

```json
{"events":[{"cursor":1,"type":"status","data":{"status":"queued"},"created_at":"UTC ISO-8601"}],"next_cursor":1}
```

cursor 从 1 递增，after 为已收到的 cursor（默认 0）；每页最多 100 条，返回不足 100 时读完当前事件。
事件为 `status` 或 `text_delta`（data 为 `{text:string}`）；只发送已经持久落盘的事件。
不存在/负值/越界 cursor 返回 400，不默默跳过。每个 run 最多 10,000 个流事件、partial/full 文本各最多 1 MiB，
超过限制停止该次执行。失败/取消/中断的 partial text 仍可从事件恢复，但不作为完整 result。

同一路径 `Accept: text/event-stream` 启用 SSE，支持 `Last-Event-ID`（显式 after 优先）：

```text
id: 3
event: text_delta
data: {"text":"输出片段"}

```

SSE 断线不会取消任务。服务最多维持 25 秒连接，之后客户端带 cursor 与有效 token 重连，避免无限延用过期认证。
终态后关闭流；应用应通过 run 查询确认最终状态与完整 result，不能以 EOF 判定成功。
