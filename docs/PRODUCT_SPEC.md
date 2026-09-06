# Mochi 产品规格

## 产品概述

Mochi 是供个人多个 Web app 调用的云端 Pi Agent 核心。首个部署平台为 Azure Container Apps，
共享基础设施由 `ccp` 管理。

## 当前状态

仅完成项目初始化；尚无 Agent API、认证管理页、容器镜像或部署资源。

## 已接受方向

- 继续使用 Pi 自带 provider/model 与认证能力，支持实际 provider 可用的 subscription 和 API key 认证。
- 认证服务端持久化，容器替换后可恢复；token 刷新和失效处理沿用 Pi 的 provider 机制。
- 多个 Web app 共用个人认证，但会话、工具配置和工作目录独立。
- 应用访问 Mochi 的认证与 Pi 访问模型 provider 的认证分开；客户端不获得上游凭据。
- 正式业务数据由各应用拥有，Agent 输出通过应用领域接口校验并保存。

## 首期用户流程与验收方向

用户管理 provider、查看可用模型、保存 API key、完成支持的 subscription 登录及退出登录。
应用可创建独立会话并调用 Agent；具体 API、事件和错误 schema 尚待设计。
应验证容器重启后认证可恢复、刷新后的凭据持久化、失效时提示重登录，
以及两个应用的会话隔离和客户端不暴露上游凭据。

## 待决策项

实际 provider 清单、固定 Pi 版本、各 provider 云端登录方式、应用身份机制、
文件型或自定义 credential store、长期任务执行方式和工具隔离方案。

## 不在当前范围

多用户商业服务、重写 Pi provider、将所有现有应用迁移到 Pi、直接管理共享云资源。

## 跨项目依赖

`ccp` 提供 ACA、持久化与身份等基础设施；Mochi 提供镜像和实际运行需求。
新小说 Web app 与现有应用作为后续消费者，当前不修改它们。
