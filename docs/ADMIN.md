# Mochi 管理服务

## 当前实现与范围

管理服务可独立运行，使用 Entra 个人登录，精确允许一个 tenant/oid。它提供 DeepSeek API key
保存、更换、移除，OpenAI subscription 设备码登录、取消和移除，以及脱敏认证状态和固定 Pi 模型目录。
首期无应用工具。统一入口已接入业务会话/任务 API 并完成云发布；部署和身份验收与真实任务执行验收分别记录，见下文[统一服务云发布](#统一服务云发布)。

管理入口已部署：[https://mochiadmin.whitemeadow-6e32159b.eastus.azurecontainerapps.io](https://mochiadmin.whitemeadow-6e32159b.eastus.azurecontainerapps.io)。
2026-09-06 用户确认已通过真实管理页完成 Entra 登录、DeepSeek API key 注册和 OpenAI 登录流，正常途径成功。
真实非 root 容器已部署到 ACA，Azure Files SMB 的基础文件操作已通过隔离探针；已完成发布前备份、跨 revision 停机交接及隔离凭据恢复；真实 OAuth 刷新已由本人管理页验证成功。`configured` 仅表示保存了对应类型凭据，不等同于账号有效或模型调用成功。

## 启动与 Entra 配置

```bash
npm ci --ignore-scripts
npm run check
npm run start:admin
```

独立入口为 `dist/admin-main.js`。Dockerfile 默认启动统一业务/管理入口；独立维护模式使用同一镜像的
command override `node dist/admin-main.js`。不得让两个进程同时拥有同一认证目录。
`dist/main.js` 现在在同一进程共享 FileCredentials、Pi 与 AdminControl；保留该独立入口用于维护兼容，不启动第二个凭据写入者。

| 环境变量 | 要求 |
|---|---|
| `MOCHI_ENTRA_ISSUER` | 固定 `https://login.microsoftonline.com/<tenant-id>/v2.0` |
| `MOCHI_ADMIN_CLIENT_ID` | 管理 SPA 的 client ID |
| `MOCHI_ADMIN_AUDIENCE` | 管理 API 的 client ID；不是 `api://` URI |
| `MOCHI_ADMIN_OID` | 该租户中唯一允许的本人 object ID，不使用 email 授权 |
| `MOCHI_ADMIN_ORIGIN` | 浏览器访问的精确 HTTPS origin；本地只允许 localhost/127.0.0.1 的 HTTP origin |
| `MOCHI_AUTH_DIR` | 已存在的绝对目录；容器契约为 `/var/lib/mochi/auth` |
| `PORT` | 容器默认 8080；本地长期端口先登记，测试使用临时端口 |

所有 GUID 使用小写。管理模式不需要业务调用方 CALLERS 映射；它完全不提供 `Mochi.Invoke` 业务 API。

Entra 部署需准备管理 SPA registration、精确 `<origin>/` redirect URI，以及独立管理 API 的
delegated `Mochi.Manage` scope，并向该 SPA 授权。页面使用固定 MSAL Browser 5.21.0 的
authorization code + PKCE；请求 scope 为 `api://<admin-api-client-id>/Mochi.Manage`。
服务端校验原始 access token 的签名、RS256、issuer/audience、exp/nbf/iat、tenant、v2、azp、oid 与 scope，
拒绝 app-only token 和其他个人账号。浏览器只保存自己的 Entra 登录状态，不获得 provider OAuth token。

管理入口采用独立 HTTPS 地址，由 CCP 的 ACA environment HTTP route configuration 托管，不新增代理容器。
Container App 自身保持 internal ingress。公网路由仅匹配 `/`、`/admin.js`、`/admin.css` 和 `/admin/` 前缀，
不重写路径，不配置兜底转发；健康探针和业务 API 不公开。使用 ACA 默认域名，SPA redirect URI 固定为 `<origin>/`。
管理服务拒绝路径中的百分号编码、反斜线、重复斜线和 URL 规范化产生的路径变化。

CCP 使用独立管理 API/SPA registration，两个 service principal 都要求用户 assignment，且只给显式本人 oid 授予默认访问；
管理 SPA 预授权 `Mochi.Manage`。不使用客户端密码或 provider token 作为 Entra 配置。
ACA Easy Auth 同样限定管理 API audience、SPA client ID 和本人 oid；仅登录 shell、静态资源、`/admin/config` 与内部探针排除认证。
应用仍独立校验 Bearer token，不信任代理身份 header。平台认证配置完成后才创建公网路由。

CCP 的 `--admin-oid` 选择独立管理模式，不需要伪造业务调用方，使用同一个 `mochi-agent` Container App。
该模式仅启用 HTTP 缩放，不消费 Queue；初期与业务模式互斥。统一入口已合并同进程路由和认证策略，
不能通过切换启动命令丢弃管理注册或增加第二个凭据拥有者。已存在的注册带删除保护。
SMB 挂载固定 `uid=1000,gid=1000,dir_mode=0700,file_mode=0600`，与镜像的非 root `node` 用户一致。

部署验收需核对路由实际 FQDN 与配置 origin 一致、未列出路径不转发、本人真实登录成功、其他账号与应用身份拒绝，
以及实际 SMB 操作和部署交接。Terraform mock 与本地容器测试不替代这些云端证据。

- [ACA 按路径路由](https://learn.microsoft.com/en-us/azure/container-apps/rule-based-routing)
- [HTTP route API 2025-07-01](https://learn.microsoft.com/en-us/azure/templates/microsoft.app/2025-07-01/managedenvironments/httprouteconfigs)

## 管理会话与 provider 事务

匿名资源仅为登录 shell、固定 JS/CSS、非敏感 `/admin/config` 和健康探针。
所有管理 API 都需要 Entra Bearer token。认证后由 `POST /admin/session` 签发最多十分钟的
随机管理会话 ID，上限 16 个活动会话，且不超过 access token 的到期时间。
后续请求同时携带 `X-Mochi-Session` 与 `X-Mochi-Request: 1`；后端再次验证 token 与本人 oid。
不使用自动发送的认证 cookie，变更请求要求精确 Origin 和 JSON Content-Type，不提供跨域 CORS。
退出或过期会话取消尚未完成的 provider 登录；进程重启使管理会话与授权事务失效。

| 接口 | 行为 |
|---|---|
| `POST /admin/session` | 创建管理会话 |
| `DELETE /admin/session` | 退出管理会话，取消该会话授权 |
| `GET /admin/providers` | 脱敏状态及固定 SDK 模型目录 |
| `POST /admin/providers/deepseek/key` | JSON `{ "key": "..." }`；保存或更换，不回显 |
| `POST /admin/providers/openai-codex/refresh` | 空 JSON `{}`；由当前拥有者主动刷新订阅认证，持久保存后返回 `{ "ok": true }` |
| `POST /admin/providers/openai-codex/login` | 创建五分钟设备码事务，返回事务 ID |
| `GET /admin/oauth/<id>` | 本会话事务的状态、设备码与固定 OpenAI 授权链接 |
| `POST /admin/oauth/<id>/cancel` | 取消事务，禁止迟到凭据保存 |
| `POST /admin/providers/<provider>/logout` | 移除对应凭据；进行中的授权先取消 |

只允许 `deepseek` 和 `openai-codex`。授权中返回 `provider_busy`，不并行发起另一个 provider 变更。
OpenAI 使用 Pi 的 `device_code` headless 流程，不启动 localhost OAuth callback listener，
也不接受外部 callback/code 注入。事务绑定管理会话，设备码只显示在该会话页面，终态不再返回设备码。
账号不支持设备码、撤销、超时与网络异常返回失败，不静默回退到 OpenAI API key 或浏览器回调。
认证错误不回传 provider 原始异常，日志仅含请求 ID、状态码与生命周期事件。

## 认证文件与所有权

`FileCredentials` 实现 Pi `CredentialStore`，保留 `{ "deepseek": {...}, "openai-codex": {...} }`
的原生 auth.json 布局及 OAuth 附加字段。原生 Pi 文件 backend 已核对：使用会自动判断 stale 的锁，
并直接覆盖 auth.json；本实现为满足明确维护交接及写失败恢复，使用独立 adapter，仍复用 Pi 的 provider 登录和刷新。

安全边界是受信任 Linux/容器目录：拒绝静态 symlink 祖先、symlink/non-regular credential 文件与硬链接，
不要求抵抗同用户恶意 ancestor 替换，不使用 native helper，不承诺 Windows/macOS 或未验证 SMB 的等价语义。

- 启动以原子 mkdir 获取 `.owner/`，写入本实例随机 owner ID。已存在的锁一律拒绝，不按 PID 或时间抢占。
- 同一实例的所有 mutation 串行；完整 OAuth 登录/刷新回调在 mutation 内执行，随后保存最新凭据。
- OAuth 刷新抛错、取消或返回非法凭据时，在同一锁内写入 `mochiReauthenticationRequired: true`，
  即使请求已取消也完成该标记的持久化。后续并发请求及重启后均拒绝刷新；管理状态为 configured=false，
  用户重新登录或移除凭据后解除。标记写入失败则由 FileCredentials 停止服务并保留 owner 锁。
- 写入使用同目录唯一临时文件、0600 权限、文件 fsync、rename 与目录 fsync。修改前后检查所有权；
  读取可以在授权等待期间读取上一个完整快照。发布后的 fsync 失败可能意味着新值已落盘，失败后不得盲重试。
- 每秒检查 owner 标识；发现失权后触发 abort、停止管理请求与授权。提交前再次核对 owner，阻止迟到覆盖。
- `release()` 停止接收新操作，等待已开始的 mutation，再移除自己的 owner ID 和空锁目录；该实例不能重新获取所有权。
- 正常终止管理服务时先停止接单、取消授权、释放拥有者。45 秒内不能完成则退出失败并保留锁，避免不确定交接。

异常退出留下 `.owner/` 时，必须先确认旧容器及可能的旧 revision 已彻底停止、不会再次写入，
再人工移除该 exact 认证目录的 `.owner/id` 和空 `.owner/`，随后启动新拥有者。
不得对可能仍活动的拥有者抢锁，不得递归删除认证目录，不得为回滚代码恢复旧 OAuth token。
若异常终止前可能有未完成刷新，或恢复了历史备份，不能凭文件可读认定 refresh token 安全可重用；
恢复前应将 OAuth 凭据标为需要重新登录或移除该 provider，再由本人重新授权。不能恢复旧备份来清除失效标记。
实际部署需按 CCP 维护窗口停止旧实例后再启动新实例，不能等待新实例 ready 才交出旧所有权。

## 验证

`npm run check` 覆盖文件恢复、跨进程排他、取消和失败保存、静态路径、失权晚写、管理员 JWT、
会话/事务隔离与 HTTP Origin/请求体边界。浏览器 fixture 为 `node test/browser-fixture.ts`，
只使用临时目录、模拟 Entra/provider 和 loopback 临时端口，不进入生产镜像。
需要允许子进程与 loopback 监听的运行环境；受限 sandbox 曾返回空子进程输出，不能按空输出推定执行通过。

真实 Azure Files SMB 的基础文件操作、模拟刷新竞争、发布前存储故障、跨 revision 停机交接与隔离备份恢复已验证。
本人已完成真实 Entra/OpenAI 登录；真实 OAuth 刷新已成功；模型调用和网络断连/发布后 fsync 故障尚未实测。

实际挂载探针为 `test/manual/storage-probe.mjs`，先构建，再在显式 `MOCHI_AUTH_DIR` 下运行。
它仅创建随机 `.mochi-probe-*` 子目录，使用无敏感信息的测试值验证文件权限、fsync、rename、排他、重新打开和删除，
结束释放测试拥有者并清理该目录；不读写活动 auth.json，也不调用模型。
2026-09-06 已在真实 ACA revision `mochi-agent--hdxf2gk` 的 Azure Files SMB 挂载上通过该探针。
该结果覆盖文件操作，不覆盖真实 OAuth 刷新、故障注入、跨 revision 维护交接或备份恢复。


云端入口验证：登录页、JS/CSS、公开 config 返回 200；匿名管理请求、伪造身份 header、无效 bearer 和真实错误 audience
Entra token 均返回 401。业务、健康和 dot-segment 路径返回 404；编码斜线路径被平台认证拒绝为 401，未进入应用。
浏览器验证 MSAL 使用正确 tenant、scope、回调与 S256 PKCE 跳转。部署后完整 Terraform plan 为 No changes。
首次请求曾在平台认证配置后的新副本启动期间超时，随后恢复；不能保证首次冷启动在十秒内完成。

## MOC-002 刷新失败与隔离恢复验证

已修复并部署刷新失败后后续请求继续使用旧 token 的问题。
`test/pi.test.ts` 覆盖成功刷新合并、失败后并发请求拒绝、持久标记跨重启保留、取消时保存标记和重新登录恢复。
完整门禁为 44 个测试、类型检查和构建通过。

`test/manual/credential-recovery-probe.mjs` 使用显式挂载下新建的随机 `.mochi-recovery-*` 子目录，
只使用合成凭据和模拟 OAuth 响应；不访问真实 provider，也不读写根目录活动 auth.json。
2026-09-06 在 ACA revision `mochi-agent--hdxf2gk` 上加载候选 Pi 适配模块并通过：

- 八个并发请求只执行一次模拟刷新，结果写回实际 SMB，释放并重新取得所有权后读到新值。
- 模拟刷新响应丢失仅调用一次，后续请求和重新打开均拒绝刷新；退出清除状态。
- 发布前将测试目标临时换成目录注入存储错误，旧测试文件保留，拥有者失效且新拥有者被拒绝。
  确认测试操作结束后恢复该测试文件、移除测试锁并重新取得所有权，验证恢复后的读取和删除。

探针结束已清理自己的文件与目录。它证明实际 SMB 上的适配器行为；文件原位保存与恢复不等同于
Azure Backup 恢复点恢复，重新打开也不等同于跨 ACA revision 发布。后续独立执行的维护验证见下节；
真实 token 刷新后续已由本人通过正常管理页验证，见主动验证章节。

## 已验证的维护发布与备份恢复

2026-09-06 UTC（JST 2026-09-07 凌晨），经用户批准停机，完成从 `mochi-agent--hdxf2gk`
到 `mochi-agent--0000001` 的交接；新镜像 digest 为
`sha256:9ec41e34f38560aaaf29d3677e7fbcd374b4377a85e925318a4f9a68f6c24aa2`。

使用 ACA `stop` 操作使应用进入 Stopped，确认副本为零、`.owner` 已释放后，为 auth/data 两个共享备份。
备份 job 均成功才 apply 已审阅的仅镜像更新计划；应用保持停止，更新完成后 `start`。
新 revision ready、管理入口返回 200、第二个拥有者被拒绝；活动 auth.json 与维护前 SHA256 一致。
不依赖 Single revision 自动滚动顺序，不强制删除活动锁。

从本次 Azure Backup 恢复点将 auth.json 恢复到认证共享的独立目录，使用 AlternateLocation/Skip。
恢复 job 完成后核对文件摘要一致，FileCredentials 和 Pi 状态可读取两个已配置 provider；只检查状态，
不使用恢复副本刷新或请求模型。验证后释放测试锁并删除恢复文件与空目录，活动 auth.json 未被覆盖。
这证明备份可恢复为适配器可读取的文件，不证明历史 OAuth token 仍有效；灾难恢复仍须按前述重新授权规则执行。

平台停止/启动接口见 [Stop](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps/stop?view=rest-resource-manager-containerapps-2025-07-01)
和 [Start](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps/start?view=rest-resource-manager-containerapps-2025-07-01)。

## 主动验证订阅认证

管理页的“验证并刷新订阅认证”调用独立的 POST 操作，要求本人 Entra token、有效管理会话、
精确 Origin 和空 JSON；不接受 token、provider 或强制选项。与登录、更换 key、移除操作互斥，
十五秒超时，会话退出或拥有者失效会取消；页面在请求期间禁用重复点击。

操作直接复用固定 Pi provider 的 OAuth refresh，整个回调和写入仍在同一 CredentialStore mutation 内。
即使当前 access token 未到期也会刷新；成功必须保存类型有效且未过期的替代凭据，响应仅为 ok，
不返回凭据或调用模型。失败返回 409 `reauthentication_required`；不确定结果持久隔离并要求重新登录，
后续请求不重复使用旧 refresh token。存储故障仍使服务停止就绪。

47 项测试覆盖显式刷新写回、失败隔离、过期替代值拒绝、管理权限/Origin/请求体、并发操作和会话取消。
浏览器 fixture 覆盖未配置时提示重新登录，以及模拟刷新成功与按钮禁用/恢复；fixture 不访问真实 provider。


2026-09-07 主动验证操作首次部署到 revision `mochi-agent--0000002`，当时镜像 digest 为
`sha256:8a53e93fda699d8607bf7d700f2919a38b592ee181db833541ca97964f236abc`。
发布经过停机、七天保留备份及旧拥有者退出；管理页已提供按钮，匿名 POST 返回 401。
2026-09-07 本人点击后确认“订阅认证已刷新并保存；未调用模型。”
维护审计核对 auth.json 摘要已变化，两个 provider 类型保持正确，OAuth 无重新登录标记。

真实刷新后已再次 stop/start：旧副本退出并释放锁，新副本取得拥有权；auth.json 摘要与刷新后完全一致，两个 provider 配置保留，管理页恢复 200。重启验证没有再次刷新 token 或调用模型。

## 统一服务云发布

2026-09-07 统一业务/管理服务发布到 revision `mochi-agent--0000003`，构建对应代码 checkpoint
`58843632f670508feeb005a249169c91681c7778`，镜像 digest 为
`sha256:deff25d3ded914d1704efb3535216aca5431a839c101e3b76e0defeef751fd01`。

发布采用维护窗口：停止旧实例，确认所有活动 revision 零副本、认证与数据共享的旧 owner 均退出；
对两个共享分别提交七天保留备份并核验本轮 job 完成及恢复点；应用部署计划后启动新实例。
发布后审计确认仅一个活动副本，新实例持有两个共享的 owner，auth.json 摘要与维护前一致，
两个 provider 类型与无需重新登录状态保留。备份提交的七天保留请求已记录；恢复点列表未暴露到期字段时，
不把请求回执等同于独立核验实际到期时间。

真实 Write 容器使用自身 Managed Identity 调用 `GET /v1/models` 返回 200 和 11 个模型选项，
身份与 `Mochi.Invoke` 角色匹配；同一 token 伪造 app header 返回 403。本人管理页登录正常。
本轮跨服务配置及匿名 HTTP 验收共 81 项通过；这些检查不调用模型，也不创建会话或任务。

本轮未验收真实模型调用、Queue 派发/消费任务、重复投递、执行中重启或缩容，以及业务状态故障恢复。
readiness、模型目录响应、备份恢复点存在和 owner 交接成功，均不单独证明这些执行路径已通过。
