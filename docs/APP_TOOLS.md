# 应用工具与有限授权契约

## 状态与范围

本契约于 2026-09-08 接受。Mochi 运行时已实现工具快照、固定认证回调、有限预算、完整 Pi 历史与收据核实，
通过真实 Pi AgentSession 和隔离 HTTP/provider 测试，并于 2026-09-08 发布到云端。应用侧授权策略和业务工具由消费者接入；
本文同时固定其必须遵循的契约，不把 Mochi 单仓库测试当成消费者或云端验收。无工具接口见 [Agent API](API.md)。第一消费者为 mochi-write：
既有 create_chapter v1 支持在故事中取材、创建草稿和新建一章。新增 initialize_story v1 的运行时支持已在本地验证，
消费者业务接入和云发布另行验收；允许仅作品资料初始化或首章关联保存，具体范围由 Write 授权和原子事务校验。
v2 自由会话运行时支持已完成本地实现，接入契约见文末；消费者业务、配置登记与云发布尚未验收。
不开放 shell、文件工具、扩展发现、任意地址访问或多 Agent。真实模型与本地隔离工具联调不等于云回调认证验收。

Mochi 拥有模型凭据、运行会话、工具传输和执行证据；应用拥有用户意图解释策略、授权、草稿、正式章节和业务收据。
自然语言授权采用独立无工具意图解释及后端有限授权，接受语义分类可能误判的剩余风险；
后端保证对象、动作、数量和精确版本约束，不能声称模型分类证明了用户意愿。

## 配置与身份

服务端配置 `MOCHI_APP_TOOLS` 是按已认证 app_id 索引的 JSON object。每项固定为：

```json
{"endpoint":"https://write.example/api/agent/tools","operations_endpoint":"https://write.example/api/agent/operations","audience":"api://<write-client-id>","tools":[{"name":"search_assets","version":"1","effect":"read"},{"name":"read_asset","version":"1","effect":"read"},{"name":"create_chapter","version":"1","effect":"write"}]}
```

缺省配置只允许无工具会话。endpoint 是完整 HTTPS URL；operations_endpoint 是固定查询根。
两者必须同 origin，不能包含 username、password、query 或 fragment；不跟随 HTTP 重定向。
请求或模型不得传入地址、认证方式或访问 token。工具版本与 effect 必须匹配静态登记；未知配置字段拒绝。
仅测试构造器可注入 loopback HTTP 和测试认证，生产环境变量不提供免认证或 HTTP 放行开关。

Mochi 使用 Managed Identity 为固定 audience 的 `/.default` scope 取得 app-only token。
Write 校验 JWT 签名、RS256、issuer、audience、tenant、有效期、v2、azp/oid 对及 `Write.Tools.Invoke` 角色，
拒绝 delegated scopes，并映射为固定 Mochi 服务身份。调用 body 中的 app_id 仅用于一致性核对，不决定身份。
个人浏览器 token 不能调用工具 callback；Mochi callback 身份不因此获得普通资产编辑 API 权限。
实际 audience/client/principal GUID 由部署提供。2026-09-08 已部署既有 Mochi runtime MI 的
Application-only `Write.Tools.Invoke` 授予、两端身份 allowlist 与上述三个工具的固定 HTTPS 配置；
云端执行证据与未验收边界见 [创作工具云发布](ADMIN.md#创作工具云发布)。
认证 token、provider key 不进入工具参数、prompt、Pi 历史、事件、日志或收据。

## 会话与版本快照

`POST /v1/sessions` 新增可选 `tools`；省略或空数组保持现有无工具会话和响应。
非空 tools 要求显式 system_prompt，并创建工具会话。工具定义固定为：

```json
{"name":"read_asset","version":"1","description":"读取当前故事中明确版本的素材","effect":"read","parameters":{"type":"object","properties":{"asset_id":{"type":"string","minLength":1,"maxLength":128},"revision":{"type":"string","minLength":1,"maxLength":128}},"required":["asset_id","revision"],"additionalProperties":false}}
```

最多 16 个唯一工具，定义总共最多 32 KiB；description 最多 2048 UTF-8 字节。
parameters 只接受 object、array、string、integer、boolean、enum、properties、required、additionalProperties:false、
minLength/maxLength、minimum/maximum 和可判别 oneOf；array 仅支持 items/minItems/maxItems，maxItems 必填且为 0–16 的整数，
minItems 可省略（默认 0），不得超过 maxItems；items 递归遵守相同 schema、最大深度 8 和定义字节预算，不支持 tuple 或任意 schema。
根 oneOf 分支必须有唯一 mode 单值字符串 enum；嵌套 oneOf 分支必须为 object，按必填 type 的唯一单值字符串 enum 判别。两者保持 2–8 分支、最大深度 8 与相同关键字限制，拒绝缺失、重复或多值判别字段；不支持任意联合、anyOf 或 $ref。
所有 object 禁止额外属性；字符串 schema 长度按 Unicode 字符数，整个协议另检查 UTF-8 字节大小。
Mochi 及应用均校验参数，不能用模型受限采样替代后端校验。

工具会话响应在现有字段外加入 `tools` 与 `tool_snapshot_hash`；hash 为完整工具定义 JSON 的稳定键排序序列化 SHA-256，
表示为 `sha256:<64位小写hex>`。工具数组顺序保留。system_prompt、工具 schema、描述、effect 和版本创建后不可改。
模型不能改变会话快照；改配置需新建会话。每次提交与执行 run 均核对静态登记仍支持该快照的 name/version/effect，
否则拒绝 `tool_version_unavailable`，不默默升级旧工具。快照与端点配置职责分开，凭据和网络地址不写入会话。

传给 Pi/provider 的参数投影会为根 `oneOf` 补充 `type:"object"`，满足 DeepSeek 工具参数根对象要求；
各分支原本均限定 object，故不改变可接受参数集合。canonical 工具定义、已持久快照及 hash 保持原样，
后端仍以原始 `oneOf` 严格校验，禁止 draft/commit 混合字段。不启用 DeepSeek strict beta 或改变 endpoint。

## Run 输入与有界执行

工具会话在原 run 输入上必须增加 scope，budget 可省略使用下表默认值：

```json
{"idempotency_key":"request-uuid","provider":"deepseek","model":"deepseek-v4-flash","prompt":"根据当前故事写下一章并保存","max_output_tokens":4096,"scope":{"task_id":"T","story_id":"ST","source_message_id":"M","operation_id":"OP","authorization_id":"A"},"budget":{"max_model_calls":8,"max_tool_calls":20,"max_write_operations":1,"timeout_ms":300000}}
```

scope 的 ID 均为 1–128 UTF-8 字节的不透明字符串，仅 authorization_id 可省略。Write 在提交前生成并持久
任务、原始用户消息、operation_id 和授权，再构造 scope；Mochi 不允许模型改变这些字段。
无工具会话拒绝非空 scope/tools 扩展；现有幂等规范化输入新增 scope、预算和快照 hash，原 key 异 payload 仍冲突。

| 限额 | 默认及硬上限 | 计数规则 |
|---|---|---|
| max_model_calls | 8 | 创作 run 的每次真实 provider 调用，重建历史不计；显式值为 1–8 |
| max_tool_calls | 20 | 每个模型发出的工具调用，包括参数/权限拒绝；显式值为 1–20 |
| max_write_operations | 1 | 首次派发正式 commit 的唯一 operation；显式值为 0 或 1，同 OP 核实/幂等重试不增加槽 |
| timeout_ms | 300000 | queued 不计，从 running 起计；显式值为 1000–300000 |
| 单次模型 deadline | 120000 ms | 同时受 run 剩余时间限制 |
| 单次工具或核实 deadline | 15000 ms | 同时受 run 剩余时间限制 |
| callback 请求 / 响应 | 128 / 64 KiB | 检查真实 UTF-8 body，不信任 Content-Length；超限失败，不截断正文 |
| 草稿正文 | 48 KiB | 正文原始 UTF-8，title 最多 512 UTF-8 字节 |

create_chapter v1 和 initialize_story v1 的 effect:write 表示持久副作用；mode:draft 不消耗正式写入槽，只消耗工具与产物预算。
mode:commit 没有授权仍由应用拒绝；预算绝不授予权限。运行时只支持这两个 v1 工具的正式 commit，
其他已登记 write 工具的 commit 在 callback 前拒绝。首次正式派发绑定工具版本与 draft ID/revision/hash，
同 OP 同引用可幂等重试，改变工具或引用返回 write_operation_limit；一轮不能先建作品再保存另一章。所有工具 sequential 执行。
每次下一个模型调用前，等待持久事件队列并检查完整 prompt、历史、schema、工具结果、消息开销及 max_output_tokens
的上下文预算；沿用 UTF-8 保守准入估计，不自动 compaction、裁剪或重试。max_output_tokens 是单次模型上限。
超限停止后续派发，分别记录 model_call_limit、tool_call_limit、write_operation_limit、run_timeout 或 context_budget_exceeded。
独立意图解释通过另一无工具会话最多调用一次模型，沿用无工具输出/context 限制，计入应用任务成本。

## Callback wire v1

Mochi 向固定 endpoint POST application/json：

```json
{"protocol_version":1,"app_id":"mochi-write","session_id":"S","run_id":"R","task_id":"T","scope":{"story_id":"ST","source_message_id":"M","operation_id":"OP","authorization_id":"A"},"tool":{"name":"create_chapter","version":"1"},"tool_call_id":"pi-call-2","invocation_id":"runtime-uuid","arguments":{"mode":"commit","draft_id":"D","draft_revision":"1","draft_hash":"sha256:..."}}
```

除 authorization_id 可缺省外字段均必需，拒绝未知字段。task_id 从 run.scope 提升到顶层，不由工具参数生成。
Mochi 分配 invocation_id；Pi 的 tool_call_id 用于模型消息配对，两者都不是业务幂等键。
Write 核对已持久 task/session/story/source_message/operation/authorization 绑定，首个可信 callback 原子绑定 run_id；
重复不同 run 不自动接管任务。明确跨 run 重试由应用先核实并建立新任务绑定，保留原 operation 槽，禁止并行接管。

成功 HTTP 200：

```json
{"protocol_version":1,"invocation_id":"runtime-uuid","outcome":"ok","data":{"chapter_id":"C","revision":"1","content_hash":"sha256:..."},"receipt":{"operation_id":"OP","status":"committed","story_id":"ST","chapter_id":"C","revision":"1","content_hash":"sha256:..."}}
```

只有正式 commit 带 receipt。业务拒绝 HTTP 200，固定形状：

```json
{"protocol_version":1,"invocation_id":"runtime-uuid","outcome":"error","error":{"code":"authorization_required","retryable":false}}
```

错误 code 为 invalid_arguments、forbidden_scope、authorization_required、authorization_revoked、draft_conflict、
operation_conflict、revision_conflict、invalid_cursor、not_found、result_too_large。operation_conflict 是业务 409 语义，
callback 用上述 envelope 传给 Pi；普通应用业务 API 可用 HTTP 409。其他字段不混入错误 envelope。
HTTP 401/403、非 JSON、版本或 invocation 不匹配、网络异常、超限响应属于传输失败，不当成业务拒绝。
返回给 Agent 的工具结果为 text 类型的该业务 JSON，details 保留结构化副本；工具错误对应 isError。
错误仅返回稳定 code，不透传数据库、provider、HTTP 原文或 token。

## 既有逻辑工具

### search_assets v1（read）

参数为 `{query:string,kind?:"setting"|"outline"|"snapshot"|"chapter",limit?:integer,cursor?:string}`。
query 可为空，最多 256 字符；limit 为 1–20，默认 10；cursor 是最长 4096 字节的后端不透明令牌。
查询仅覆盖 scope 故事中的 setting、outline、snapshot 和 chapter，沿用应用已有对象类型；人物和世界观以故事独立 snapshot 取材，不依赖母版仍然存在。排除全局母版、其他故事和删除对象。
文本搜索按大小写不敏感子串匹配标题、摘要和文本内容；空 query 浏览范围内所有对象。
结果按 kind、asset_id 升序，固定返回：

```json
{"items":[{"asset_id":"asset-1","kind":"snapshot","title":"角色","summary":"最多512字符摘要","revision":"3"}],"next_cursor":null}
```

cursor 绑定 story/query/kind/limit 和查询时的数据 revision；翻页不能改变条件，令牌非法或不匹配返回 invalid_cursor。
其间故事相关数据变化返回 revision_conflict，客户端重新从第一页检索，不以旧页继续造成静默遗漏。
没有匹配返回空数组与 null；结果只有发现元数据，不宣称已读取全文。无向量库或全局素材注入。

### read_asset v1（read）

参数固定 `{asset_id:string,revision:string}`，均为 1–128 字节；revision 必填且必须来自实际发现结果或 draft 引用。
返回 `{asset_id,kind,title,revision,content}`，kind 包含上述类型及 draft，content 为精确文本。
仅允许当前故事对象，及应用明确绑定当前 task/session 的草稿。跨故事返回 forbidden_scope；
不存在或已删除返回 not_found；对象当前 revision 与请求不同返回 revision_conflict，不静默读取新版或旧版。
无需为这一接口新建历史版本读取能力；draft 是持久不可变版本，新稿使用新 ID。
结果超限返回 result_too_large，Agent 可调整检索目标，不能把截断文字当完整正文。
应用记录真实读取 ID/revision，UI 可据此显示本轮引用。

### create_chapter v1（write）

参数使用两分支 oneOf，禁止跨分支混入字段：

```json
{"mode":"draft","title":"第一章","body":"完整 Markdown 正文"}
```

Write 根据当前任务保存不可变 draft，分配 draft_id、draft_revision 和 draft_hash；返回
`{draft_id,draft_revision,draft_hash,title,body}`。草稿 hash 是正文精确 UTF-8 字节的 SHA-256，
不 trim、不规范化换行或重写 Markdown。title/body 都非空；无需正式写入授权，但必须满足有效任务及故事绑定。
同 invocation 重试返回同 draft；新的 draft 调用可以产生新稿。草稿与正式章必须在 UI 和事件分开标识。

```json
{"mode":"commit","draft_id":"D","draft_revision":"1","draft_hash":"sha256:..."}
```

commit 不接收 body/title、chapter_id、operation_id 或 authorized。Write 从 task.scope 找 OP 与预分配 chapter_id，
从存储读取所指 draft 的精确正文和标题，校验归属、版本、hash、授权、暂停/撤回状态与未消费槽。
“保存这个版本”的授权在创建时固定 draft ID/revision/hash，不能用新稿替换；直接创作保存的授权允许当前任务第一份
有效 commit 草稿，首次 commit 将 OP 与 draft/title/body payload hash 原子固定。不同 payload 使用同 OP 返回 operation_conflict。
已有 committed OP 的同 payload 重试返回原 receipt，不再创建章节；这在授权已被消费或之后撤回时仍是只读核实，不能改写。
未知 OP 不得换 key、换 task 或换 tool_call_id 绕过。draft 缺失/变化返回 draft_conflict，目标章节已占用返回 operation_conflict。
同故事分区原子提交新章节、版本、业务收据及授权槽消费；不能先写正文再另写收据。

## 新会话的作品初始化工具

新生命周期 session 可显式登记七个 v1 工具：search_assets、read_asset、create_chapter、library_vocabulary、search_library、read_library、initialize_story。
前三个及旧会话快照原样保留；Mochi 不自动迁移或为旧 session 添加工具。后三个 read 工具由 Write 实施词表 → 有界元数据筛选 → 精确全文读取，
Mochi 只传输经 schema 校验的参数和有界结果，不读取私人资产库或赋予跨故事权限。每轮使用应用持久生成的 task/story/source_message/OP/authorization scope，
callback 的 app/session/run/task 与 scope 始终由 runtime 注入，模型参数不得指定或替换。

### initialize_story v1（write）

根 oneOf 两个 mode 分支，所有 object 禁止额外字段：

```ts
type DraftInput = {
  mode: "draft"; title: string; body?: string;
  assets: { kind: "setting" | "outline" | "snapshot"; title?: string; body?: string;
    asset_id?: string; base_revision?: string; source_id?: string; source_version?: number; source_hash?: string }[];
  chapter?: { title: string; body: string };
};
type CommitInput = { mode: "commit"; draft_id: string; draft_revision: string; draft_hash: string };
```

Write 检查生成资料、更新现有初始资料和复制已读母版三个互斥来源模式，固定完整 Content、基础版本和来源，保存不可变草稿。
至多 8 个资料、1 个 setting 和 1 个 outline；资料/描述每项 8 KiB，首章正文 48 KiB，title 至多 200 Unicode 字符及 512 UTF-8 字节。
初始化参数 JSON 至多 120 KiB；完整 callback 仍至多 128 KiB。应用展开包 JSON 至多 256 KiB，不通过工具返回全文包。
草稿 response.data 为 `{draft_id,draft_revision,draft_hash,title,artifact_kind:"story_initialization",includes_chapter}` 及有界资料摘要。
Mochi 校验精确引用、类型和 includes_chapter 与输入是否含 chapter 一致，并保存 artifact 与事件；完整包由应用本人 API 阅读。
read_asset 读取初始化草稿时也只返回有界清单/摘要，仍受 64 KiB 完整 callback 响应上限约束。

无 chapter 候选可建立零章作品；含 chapter 候选可建立并保存首章，或为已建但未写章的作品保存首章及关联初始资料更新。
这些业务状态和授权由 Write 校验并以单分区事务提交；已有章后不能用此工具作通用多资产修改。
只建立作品后需下一轮新授权才能保存首章；首章后原 session 可继续 create_chapter v1。用户自行管理换 session 与上下文，
运行时沿用预算和超限停止，不增加自动摘要、压缩、工具快照变更或第二正式 OP。

### 初始化收据

initialize_story v1 commit 必须返回以下严格 union；旧无 kind 的 chapter receipt 只属于 create_chapter v1：

```ts
type InitializationReceipt = {
  operation_id: string; status: "committed"; story_id: string;
  kind: "story_initialized" | "first_chapter_saved";
  revision: string; content_hash: string;
  draft_id: string; draft_revision: string; draft_hash: string;
  assets: { asset_id: string; kind: "setting" | "outline" | "snapshot"; revision: string; content_hash: string }[];
  chapter?: { chapter_id: string; revision: string; content_hash: string };
};
```

story_initialized 禁止 chapter；first_chapter_saved 必须含 chapter。所有对象拒绝未知字段，ID/revision 为 1–128 UTF-8 字节，
hash 为 sha256 加 64 位小写 hex；content_hash 等于 draft_hash（规范初始化包 hash）。assets 最多 8 个且 ID 唯一，setting/outline 各最多一个。
同步 callback 和原 OP 核实都绑定 initialize_story v1、原 story/OP 和 draft_id/revision/hash，不能用章节收据或另一草稿替代。
草稿、read 或任意其他工具不得返回正式 receipt。取消、模型失败和进程中断保留已提交作品/首章的真实收据；unknown 仍查询原 OP，不重发业务写入。

## 收据核实、取消与进程恢复

operation_id 在首次提交 run 前已交给 Mochi 持久保存；即使首次 callback 响应丢失也能核实。
工具记录按 prepared → dispatched → succeeded/rejected/unknown 保存；只有持久 dispatched 后才发出 callback，
因此崩溃后 dispatched 可能尚未实际发送，仍保守为 unknown。
网络超时、abort、协议错误或进程中断发生在 mutation 派发后均为 unknown，不等于写失败。

`GET <operations_endpoint>/<encodeURIComponent(operation_id)>` 使用相同 app-only 认证，路径恰好一个编码 ID segment。
返回 HTTP 200：`{protocol_version:1,operation_id,status:"committed",receipt}`、
`{protocol_version:1,operation_id,status:"rejected",error:{code}}` 或
`{protocol_version:1,operation_id,status:"not_found"}`。查询不调用模型，不消耗工具调用或正式写预算，仍有 deadline。
应用必须检查 operation 所属 app/story；未知返回 not_found，越权拒绝。不接受模型选择查询 URL。
Mochi 在运行中响应丢失后仅核实原 OP 一次；仍不确定则以 tool_result_unknown 失败，不自动重发业务保存。
应用可调用 `POST /v1/runs/:id/operations/verify`，JSON body 为 `{}`，核实终态 run 的 unknown OP 并返回更新后的 run。
该接口逐个查询原 OP，从已持久派发记录及原 session 不可变快照取得工具版本和参数，
核对 receipt 的工具类型、story 和初始化精确草稿引用，保留原 run 终态；其他 app 被拒绝，运行中或无工具 run 返回 409 run_not_terminal。
not_found 保持 unknown，查询传输失败返回通用 internal_error，原证据不变；没有 unknown 的工具终态查询可重复。
not_found 仅表示查询时没有收据，不能证明在途 callback 以后不提交；unknown 保持待核实，
只能在旧请求已结束且应用已封闭/核实该槽后明确重试同 OP，不自动换 OP。
草稿派发结果不确定保留工具 unknown，但不伪造正式章节 mutation；草稿仅可经其 invocation/task 核对。

取消先保存终态、停止后续派发，再 abort provider/callback；取消无法撤销已经提交的章节。
恢复 running run 为 interrupted，不自动重放 Pi 或 mutation。prepared 未派发记录可判定未执行；
dispatched 缺少结果必须保留 unknown 并允许核实。任何已保存收据不被较晚模型失败、取消或进程恢复覆盖。

## 授权解释与撤回

Write 后端持有解释策略，通过 Mochi 独立无工具会话调用同一用户选定 provider/model。
输入只含当前原始用户消息与后端生成的可信故事/草稿元数据，不包含小说正文、检索材料、工具输出或创作 Agent 的授权推断。
固定输出为 `{intent,evidence:{start,end,text}}`；intent 枚举 discuss、draft、save_current、create_and_save、revoke、unclear。
start/end 是原始 JavaScript 字符串 UTF-16 offset，后端校验整数边界与原始 substring 精确一致。
这证明证据来自用户消息，不证明语义正确。解释失败、引用/否定/讨论、目标不唯一、超出一章或混合越权动作均不授权。
应用依据选中的可信对象创建目标绑定，模型不填 ID 或 URL；含糊时澄清，明确时不重复要求采纳。

授权记录至少保存 id、原始 source_message_id/hash、task_id、session_id、story_id、operation_id、
action:create_chapter、max_creates:1、draft_ref（精确保存时）、revision 及 active/paused/revoked/consumed 状态。
只有已认证用户消息处理路径能创建授权，创作工具不能创建；Mochi wrapper 只注入服务端 scope 引用，
Write 每次 commit 读取当前授权并做确定性校验，不接受 authorized:true 或授权关键词。

停止/撤回按钮直接调用 Write 后端。新用户消息到达时，先原子暂停 session 未来 commit，再做意图解释，
避免解释“别保存”期间旧请求继续写。第一切片不在旧运行中 steer；旧任务取消/核实后再发新任务。
撤回与 commit 以同故事事务提交顺序决定：撤回先提交则拒绝；commit 先提交则保留已保存收据，撤回只影响后续操作。
正文版本恢复沿用应用版本能力，不把撤回或模型取消描述为回滚。

## Pi 历史、事件与终态

Mochi 保存完整 Pi 0.85.1 user、assistant、toolResult 消息，包括 assistant 的 thinking/toolCall/stopReason/usage、
以及 toolResult 的 toolCallId/toolName/content/details/isError；assistant.errorMessage 规范化为 provider_failed，避免泄露上游原始异常。
只接受 runtime 产生的消息，不开放应用任意历史导入。
内部记录 `{run_id,sequence,message}`，sequence 在 session 内单调递增。失败/取消/中断的已结束消息也保留审计。

`GET /v1/sessions/:id/history?format=pi-v1` 返回 `{format:"pi-v1",messages:[{run_id,sequence,message}]}`。
无 format 的旧接口继续只返回成功 user/assistant 文本投影；工具会话的 assistant 文本是最终回复，不把工具结果拼成聊天正文。
模型 replay 使用成功 run 的完整消息；失败 run 不伪造成功历史，应用下一次提交必须附上核实的已保存/待核实事实，
作为业务恢复上下文。unknown OP 未核实前不允许新保存槽。审计历史与 replay 历史不得混称。

每次 message_end 落盘。工具适配器必须等待对应 assistant toolCall 与 invocation 持久 barrier 后才进行外部副作用，
回调结果与 receipt 先落盘再返回 Pi；下一次模型调用前等待全部消息/事件持久队列。
实现使用 Pi 0.85.1 agent.subscribe 的被 await listener 保存 message_end；工具 wrapper 等待 invocation/receipt 落盘，
不用不被 await 的 session.subscribe 推断顺序。SessionManager.appendMessage 原样恢复成功历史；不复制 Agent loop。
所有实际 assistant usage 按 run 累加；工具 run 新增 usage_complete:boolean，有缺失调用则为 false，历史占位不计。

工具 run 保留现有 status/result/error 字段，并新增 `operations:[{operation_id,status:"committed"|"rejected"|"unknown",receipt?,error?}]`、
`artifacts:[{draft_id,draft_revision,draft_hash,title,artifact_kind?,includes_chapter?}]`、usage_complete。
仅 initialize_story v1 草稿增加 artifact_kind:story_initialization 和 includes_chapter:boolean；旧草稿不补字段。无工具 run 保持原固定形状。
succeeded 要求最后完整 assistant stop 且无待核实正式 mutation；否则 failed/tool_result_unknown。
failed/cancelled/interrupted 仍可带 committed 收据；业务保存成功和模型执行成功分别呈现。

事件仍用已有持久 cursor/SSE。工具会话新增：

| type | data |
|---|---|
| message | `{sequence,message}`，只在完整 message_end 后发出 |
| tool_started | `{invocation_id,tool_call_id,name}`，已持久 dispatched |
| tool_finished | `{invocation_id,tool_call_id,name,status,error?}` |
| artifact_created | `{draft_id,draft_revision,draft_hash,title}`，初始化草稿另带 `artifact_kind:story_initialization,includes_chapter:boolean` |
| operation_updated | `{operation_id,status,receipt?,error?}` |

旧无工具 session 不产生新事件。text_delta 可包含中间讨论，不能作为最终草稿或“已保存”依据；
草稿以持久 artifact 为准，保存以 Write 收据及实际章节核实为准。事件沿用 10000 条与原文本大小上限，超限停止后续执行。

## 场景验收矩阵

| 场景 | 请求与调用顺序 | 可验收结果 |
|---|---|---|
| 直接创作保存 | M“写一章并保存”→有限授权 A/OP→run scope→search/read→draft D/1/H→commit D/1/H | 一章及 committed 收据；最终 stop 后 succeeded；不要求重复采纳 |
| 先草稿后保存 | M1“给我看看”→无授权 run 产 D/1/H；M2“保存这个版本”+展示引用→授权 exact D/1/H→commit | 保存精确原稿；换 D/revision/hash 拒绝，不能重生成后声称同稿 |
| 越权 | 无授权、跨故事、撤回授权、旧章覆盖、资产修改或第 2 保存槽 | 拒绝且 canonical 数据不变，不允许 Agent 自签授权 |
| 写入成功响应丢失 | 持久 invocation/OP→应用原子写章与 receipt→网络失败→unknown→GET OP | 核实 committed；模型失败也保留已保存事实；换 tool_call_id 不重复写 |
| 进程中断 | 持久 dispatched→崩溃→running 转 interrupted→查询 OP | 不自动重放，保留原消息、unknown/committed、收据与后续核实路径 |
| 数据分页/版本变化 | search 第 1 页→相关数据变化→第 2 页；read 旧 revision | revision_conflict，无静默跳页或读新版；不存在/删除 not_found |

验收包括真实 Pi AgentSession 配合假 provider 的确定性测试、应用存储原子幂等测试、
协议失败/取消与受控响应丢失测试，以及独立的真实模型体验 smoke。测试身份、临时端口和隔离数据不证明生产 MI 或云故障恢复。
本地持久边界为受信任 Linux/容器目录、静态 symlink containment 与正常并发冲突；无恶意 ancestor-swap 防护、native helper 或新增跨平台承诺。

## 固定版本官方依据

- [Pi 0.85.1 SDK](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/sdk.md)：customTools 与显式 tools allowlist；默认无工具发现继续关闭。
- [Pi 工具类型](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/extensions/types.ts)：execute 的取消信号与 sequential 模式。
- [Pi Agent](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/agent.ts)：agent.subscribe listener 被 await，支持消息持久屏障。
- [Pi Agent loop](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/agent-loop.ts)：执行前参数校验与错误 toolResult；不替代业务授权。
- [Microsoft Entra 服务间认证](https://learn.microsoft.com/en-us/azure/container-apps/authentication-entra#daemon-client-application-service-to-service-calls)：app-only 调用与服务身份配置。

## 自由会话 protocol v2

新 session 显式提交 `tool_protocol_version:2`，字段与 system prompt、工具快照一起持久固定。
省略仍是 v1；无工具、三工具、七工具的响应、canonical hash 和记录不增加字段。
服务端 allowlist 按 `(name,version)` 唯一，可同时登记 v1/v2；单 session 不可混用以下集合之外的工具，
且必须按此顺序提交十项（description、parameters 仍由应用提供并参与 canonical snapshot hash）：

| 顺序 | name/version/effect |
|---|---|
| 1 | library_vocabulary/1/read |
| 2 | search_library/1/read |
| 3 | read_library/1/read |
| 4 | search_assets/2/read |
| 5 | read_asset/2/read |
| 6 | discover_artifacts/2/read |
| 7 | read_artifact/2/read |
| 8 | save_character/2/write |
| 9 | initialize_story/2/write |
| 10 | create_chapter/2/write |

schema 只接受严格 object、根 mode oneOf、嵌套 type oneOf、有界 array 和既有基本类型，最大深度 8。嵌套联合用于准确传达资产／候选引用形状，不增加工具权限；旧已保存工具快照保持不可变，新 session 才取得修正后的 schema。
v2 的 array maxItems 上限扩为 30，以承载角色最多 30 个 genres；v1 创建时仍最多 16。
所有 callback 的实际请求最多 128 KiB、响应最多 64 KiB，不截断。工具自身更小的字节/Unicode、候选完整包、
来源及业务字段范围由 Write 严格校验；Mochi 不把合法 schema 当成用户授权。

### 输入与两阶段

v2 run 的 `scope` 为以下严格对象，不接受 v1 story scope：

```ts
type ScopeV2 = {
  protocol_version: 2;
  conversation_id: string; task_id: string; source_message_id: string; operation_id: string;
  phase: "resolve" | "execute"; refs_digest: string;
  binding_digest?: string; authorization_id?: string;
  target?: {kind:"character"; asset_id:string} | {kind:"story"; story_id:string};
  action?: "create_character" | "update_character" | "initialize_story" | "save_first_chapter" | "create_chapter";
};
```

ID 是 1–128 UTF-8 bytes；digest 为 `sha256:` 加 64 小写 hex。`binding_digest/authorization_id/target/action`
四者必须同时存在或同时省略，resolve 必须省略且预算 `max_write_operations:0`。仅执行正式绑定时携带它们。
角色 action 只配 character target，故事 action 只配 story target，拒绝未知字段与 null。
`action` 是应用后端已核验的实际绑定动作：用户的 `save_current` 等解释意图必须由 Write 按冻结候选归约，
不直接把创作模型输出作为该字段。

候选预览上下文单独使用 run 顶层可选 `draft_context_digest`（仅 v2 execute、同 sha256 格式），
其摘要来自 Write 在派发前持久冻结的 draftContext。此字段参与幂等，不能授予 commit；完整 draftContext、
固定 refs、允许读取的 story 范围与 binding 由 Write 后端保存并在 callback 按 app/session/run/task/phase 核对。
Mochi 不查询资料、推断目标或修改这些身份。目标证据不充分时 Write 澄清，不提交授权 run。

需要检索时，Write 先提交 `<taskId>:resolve:1`：包括 draft 在内的所有 write 均在业务 callback 前拒绝。
Write 独立核验解析结果并持久 binding/draftContext 后，再提交同一 session 的 `<taskId>:execute:1`。
后一个 run 保留原 task/source message/OP/conversation/refs digest；新 prompt 可包含可信 continuation 摘要。
Mochi 自动将此回合登记为 `customType:mochi-task-continuation` 的 Pi custom 消息，而非第二条用户消息。
无需解析时直接一个 execute；无正式 binding 的 execute 可生成候选，commit 返回 authorization_required。

每个 app/task 最多一个 resolve 和一个 execute，execute 只可接续 succeeded resolve，cancelled/failed/interrupted
resolve 不可后绑定。换 key 不允许重做同一 phase，返回 409 task_phase_conflict；原 key 同输入始终返回原 run，
同 key 异完整 scope、prompt、预算或候选上下文摘要返回 409 idempotency_conflict。
候选不是正式业务成果：v2 最多八份成功候选，达到上限后不再派发 draft callback；业务拒绝仍消耗工具预算但不占候选名额。事件保留 group_id、ordinal、parent_ref 和
artifact_kind（character/story_initialization/chapter），支持多个组和版本；正式 commit 仍只允许一个工具及精确 draft 身份。

两阶段模型调用总计最多 8、工具总计最多 20、执行时间总计 300000 ms（不含 queued）。Mochi 持久计数，
execute 准入自动取调用方预算与总额度减去 resolve 实际消耗后的较小值；resolve 的单 run 更小限制不减少总任务上限。
不足以再调用模型、工具或运行 1000 ms 时返回 409 task_budget_exhausted。应用不能通过新 key 重置该任务预算。
公开 run 增加 `execution_usage:{model_calls,tool_calls,duration_ms}`，用于 Write 扣除阶段消耗和展示。
进程在 running 中断时按该 run 时间上限保守计量，不能据此自动续跑。独立无工具解释器的单次调用及其成本由 Write 另记，
Write 还负责 epoch/取消、迟到解析结果、前一业务 OP 未终止的新消息 gate；Mochi cancel 只停止模型。

### v2 callback 与核实

沿用原固定 HTTPS/MI endpoint。请求的 `protocol_version:2`，其余 app_id/session_id/run_id/task_id/
invocation_id/tool_call_id/tool/arguments 保持旧 envelope，scope 是上述 ScopeV2 去掉 task_id（仍含 protocol_version）。
成功/错误 envelope 也明确为 2；拒绝 v1/v2 混搭。新增稳定业务错误 reference_unavailable/reference_changed。
commit 仅接受 `{mode:"commit",draft_id,draft_revision:"1",draft_hash}`，拒绝模型追加 target、OP、正文或授权。
具体写工具必须与绑定动作匹配；反向 callback 返回的收据和 GET 原 operations endpoint 核实同样遵循：

| scope.action | tool/version | 唯一 receipt.kind |
|---|---|---|
| create_character | save_character/2 | character_created |
| update_character | save_character/2 | character_updated |
| initialize_story | initialize_story/2 | story_initialized |
| save_first_chapter | initialize_story/2 | first_chapter_saved |
| create_chapter | create_chapter/2 | chapter_created |

ReceiptV2 是 `{protocol_version:2,operation_id,status:"committed",conversation_id,task_id,kind,target,
 draft_id,draft_revision,draft_hash,content_hash,revision,assets?,chapter?}`。上述身份、target、动作、工具和精确稿
全部匹配原 run/invocation。角色禁止 assets/chapter；仅初始化禁止 chapter，首章必须 chapter，初始化必须 assets
（最多八项、ID 不重复、setting/outline 各最多一项），content_hash=draft_hash。
chapter_created 必须 chapter、禁止 assets，顶层 revision/content_hash 必须等于章的 revision/content_hash。
角色 content_hash 是 Write 冻结完整 Content 的 hash；Mochi 不将角色成果塞入旧 ChapterReceipt。

GET `operations_endpoint/<original_operation_id>` 的 v2 结果为
`{protocol_version:2,operation_id,status:"unknown"|"revoked"|"conflict"|"committed",receipt?}`，仅 committed 可带收据。
Mochi 用持久 invocation、session snapshot 和原 scope 校验；Write 根据可信 directory/目标分区 OP ledger 取权威结果。
unknown 不等于没有保存，revoked/conflict 才表示该 OP 已封闭；核实不重发模型或业务写入，模型终态不被改成成功。
callback 响应丢失可原 OP 恢复；后续模型失败、取消或重启保留已知正式收据和所有候选。

### Pi 生命周期与兼容

同一个 executor 在进程内按 app/session 复用真实 Pi AgentSession，逐 run 替换工具执行委托、预算与模型设置；
固定 snapshot 不换，已结束 run 的委托立即失效。Mochi Tasks.close 等待活动执行后释放 session 和临时目录。
v2 的完整历史包含失败/取消的已持久消息及 continuation；重启按完整记录重建 Pi 内存状态，保持原 Mochi session ID，
不会声称跨进程保留同一内存对象。v2 普通 history 文本投影仅含成功消息且不将 continuation 伪造成新 user；新消费者使用 history?format=pi-v1 和 run 成果。
旧无工具/v1 仍每 run 以成功历史重建，旧持久数据不迁移、快照/hash 不重算。

本地验证使用真实 Pi 与假 provider，覆盖多目标连续会话、多候选、两阶段预算、撤回后的迟到 phase 拒绝、
篡改引用/收据和原 OP 恢复；没有调用真实收费模型、改权限或部署。Write 的内容/CAS/目录与多分区授权仍需消费者实现验收。
