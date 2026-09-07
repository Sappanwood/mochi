# Mochi 产品规格

## 产品概述

Mochi 是供个人多个 Web app 调用的云端 Pi Agent 核心。首个部署平台为 Azure Container Apps，
共享基础设施由 `ccp` 管理。

## 当前状态

已实现服务基础、应用认证、Pi 无工具适配、持久凭据与独立个人管理页面，管理服务已部署，业务 Agent API 已接通本地持久会话/任务与首个应用，统一服务尚未云发布。
管理员采用 Entra 登录，仅允许登记的本人账号；支持 DeepSeek key 保存/更换/移除及 OpenAI 设备码授权/取消。
用户已验证真实 Entra/DeepSeek/OpenAI 正常流程，SMB 基础文件操作通过；已完成 SMB 隔离故障、停机交接和凭据备份恢复验证，真实 OAuth 刷新已由本人管理页验证成功。管理 API 与运行配置见 [管理服务](ADMIN.md)。
两个健康端点可匿名读取最小状态；未认证业务请求返回 401，有效身份越权返回 403。
统一服务 readiness 要求认证和数据目录所有权、Queue 消费初始化；独立管理维护入口仅检查认证所有权。就绪不证明账户模型可用。

## 已接受方向

- 继续使用 Pi 自带 provider/model 与认证能力，支持实际 provider 可用的 subscription 和 API key 认证。
- 认证服务端持久化采用专属 Azure Files，容器替换后可恢复；token 刷新和失效处理沿用 Pi 的 provider 机制。
- 多个 Web app 共用个人认证，但会话、工具配置和工作目录独立。
- 应用访问 Mochi 的认证与 Pi 访问模型 provider 的认证分开；客户端不获得上游凭据。
- 正式业务数据由各应用拥有，Agent 输出通过应用领域接口校验并保存。
- 首期仅做无工具对话；后续按 app 需求补充明确授权的工具，不开放任意 shell 或模型生成代码的执行，不部署独立工具执行容器。
- 管理页面使用独立 HTTPS 入口与 Entra 本人登录，无需首个业务 app 或日常隧道；业务 API 继续内部访问。
- 首期 provider 为 DeepSeek API key 与 OpenAI subscription（Pi `openai-codex`），不增加 OpenAI API key fallback。

## 首期用户流程与验收方向

用户管理 provider、查看可用模型、保存 API key、完成支持的 subscription 登录及退出登录。
应用后端使用独立 Managed Identity 获取 Entra app-only token 调用内部 Agent API；首期串行执行任务，其余持久排队。浏览器断开后任务继续，支持状态查询、事件重连和明确取消。
会话与任务文件持久化至独立 Azure Files 数据共享；Queue 用于派发，任务状态为依据。具体 API、事件和错误 schema 见 [Agent API](API.md)。
应验证容器重启后认证可恢复、刷新后的凭据持久化、失效时提示重登录，
以及两个应用的会话隔离和客户端不暴露上游凭据。

## 待决策项

Pi 版本固定为 0.85.1；管理登录、credential store 与刷新已实测。仍需验证实际账户模型调用、
统一入口云身份、任务数据共享与 Queue 的缩容/故障协调（MOC-004）。
应用工具权限契约在后续 app 接入时确定，不阻塞首期无工具对话。

## 不在当前范围

多用户商业服务、重写 Pi provider、将所有现有应用迁移到 Pi、直接管理共享云资源、任意 shell/代码执行及独立工具执行器。

## 跨项目依赖

`ccp` 提供 ACA、持久化与身份等基础设施；Mochi 提供镜像和实际运行需求。
mochi-write 为首个消费者；应用保存 canonical 正文与采纳状态，Mochi 只拥有执行状态和会话。

## 刷新异常恢复

OAuth 刷新结果不确定时，服务将对应凭据持久标记为需要重新登录，不向后续请求自动重试。
管理状态显示未配置，用户重新完成登录后恢复；请求取消不能跳过失效标记保存。
该修复已完成本地与真实 SMB 隔离验证，已完成维护发布；不将模拟刷新等同于真实 provider 验收。

个人管理页提供“验证并刷新订阅认证”；成功仅确认 OAuth 刷新及凭据保存，不等同于模型可用性验证。失败或取消后的不确定凭据需重新授权。
