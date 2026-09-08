# AGENTS.md — Mochi

人类入口见 [README.md](README.md)。共享规则遵循 `/home/ling/workspace/AGENTS.md`。

## 项目定位与当前范围

面向个人多个 Web app 的云端 Pi Agent 执行核心，部署目标为 Azure Container Apps。

当前已建立 HTTP/Entra/Pi 基础、持久凭据与独立个人管理页面；统一业务/管理服务已发布到 Azure Container Apps，真实 Write Managed Identity 读取模型目录与本人管理登录已验证。真实 Write MI 经 Queue/Pi 调用 DeepSeek V4 Flash 的两个独立会话任务已成功，排队时页面断开后可恢复原任务；执行中中断、进程恢复、跨应用身份隔离及业务故障恢复仍待 MOC-004 验收。
实现前区分已接受方向、待决策事项和已实现事实。

## ProjectOps 路由

本项目属于用户于 2026-09-06 授权的新项目试用，项目 ID 为 `mochi`。
数据 workspace 为 `/home/ling/workspace`，authority 为 `.pops/workspace.json`。
先在该 workspace 执行 `pops project list --json` 与 `pops project doctor --json`，
再通过 workspace 的 `projectops-workflow` skill 操作 manifest 解析出的 typed roots。
Backlog、Plan、execution、Report、ADR、Research 均由 ProjectOps 管理，不创建 Workspace Control 副本。
项目回顾使用 ProjectOps retrospective；共享工作区事项遵循 Workspace 路由。

## 开发边界

- 当前阶段以快速迭代为主，验收覆盖主要 happy path；真实使用中出现的 bug 再针对性处理，不为追求工程完备性主动扩展实现与验收范围。
- 每个项目独立维护代码和部署契约；跨项目需求明确写出对方项目 ID。
- 不把凭据、OAuth token、运行会话、云状态或私有素材提交到 Git。
- 默认无应用工具；本地已实现、尚未发布的工具扩展遵循 `docs/APP_TOOLS.md`。仅支持 DeepSeek API key 和 OpenAI subscription（`openai-codex`）；不得隐式启用默认工具或 OpenAI API key fallback。
- 外部 API、SDK、认证或云资源契约变更前查阅最新官方文档，并固定实际验证版本。
- 新增收费资源、修改云权限或发布前，准备可审阅结果并按用户实际授权执行。
- 本地文件操作先明确威胁模型；普通开发按受信任本地 Linux workspace，不默认要求对抗恶意 ancestor 替换。
- 中高风险行为按共享测试纪律先验证失败用例，首个代码实现同时建立适用质量入口。

## 文档路由

| 文档 | 何时读 | 何时更新 |
|---|---|---|
| README.md | 了解项目状态和入口 | 状态、安装和运行命令变化 |
| docs/PRODUCT_SPEC.md | 明确用户行为和范围 | 产品流程、数据和验收边界变化 |
| docs/ARCHITECTURE.md | 设计组件、依赖和存储 | 技术选型、所有权和部署契约变化 |
| docs/API.md | 业务接口、任务和事件开发 | API schema、幂等、状态、预算、恢复语义变化 |
| docs/APP_TOOLS.md | 应用工具、授权解释、回调和业务写入接入 | 工具协议、快照、预算、历史、授权和收据契约变化 |
| docs/ADMIN.md | 管理服务开发、Entra 接入、认证恢复与发布交接 | 管理 API、会话、文件安全与操作流程变化 |
| ProjectOps typed roots | 管理任务、决策和交付 | 通过对应 ProjectOps 契约维护 |

## 常用命令与完工验收

```bash
npm ci --ignore-scripts
npm run check
pops project doctor --json
pops docs check mochi --json
pops backlog list mochi --json
git diff --check
```

代码变更必须运行 `npm run check`（测试、类型检查和构建）；仅文档变更运行 ProjectOps 检查与
`git diff --check`，并核对文档链接和仓库状态。HTTP 测试使用 loopback 临时端口，需允许本地监听。
测试采用 Node 原生 TypeScript 与 `--test-isolation=none`，核对用例数量，不能仅以文件级通过判定成功。
跨进程排他测试也需允许子进程实际执行并返回输出；sandbox 中空输出不作为通过证据。
`docs check` 仅检查固定文档存在、类型与一级标题，不代替内容审阅或后续代码测试。
实现功能后同步产品和架构文档，运行覆盖实际变更的测试及质量门禁。
已有 CodeGraph 索引且修改其覆盖源码时收尾运行 `codegraph sync`；没有索引则跳过。

应用发布 workflow 与 `scripts/deploy.py` 的修改需运行 Python 发布行为测试，随后执行项目既有质量门禁。日常发布入口与维护边界见 README；不得恢复 CCP 与应用双重管理 image。
