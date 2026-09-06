# AGENTS.md — Mochi

人类入口见 [README.md](README.md)。共享规则遵循 `/home/ling/workspace/AGENTS.md`。

## 项目定位与当前范围

面向个人多个 Web app 的云端 Pi Agent 执行核心，部署目标为 Azure Container Apps。

当前仅完成项目建档。实现前区分已接受方向、待决策事项和已实现事实。

## ProjectOps 路由

本项目属于用户于 2026-09-06 授权的新项目试用，项目 ID 为 `mochi`。
数据 workspace 为 `/home/ling/workspace`，authority 为 `.pops/workspace.json`。
先在该 workspace 执行 `pops project list --json` 与 `pops project doctor --json`，
再通过 workspace 的 `projectops-workflow` skill 操作 manifest 解析出的 typed roots。
Backlog、Plan、execution、Report、ADR、Research 均由 ProjectOps 管理，不创建 Workspace Control 副本。
项目回顾使用 ProjectOps retrospective；共享工作区事项遵循 Workspace 路由。

## 开发边界

- 每个项目独立维护代码和部署契约；跨项目需求明确写出对方项目 ID。
- 不把凭据、OAuth token、运行会话、云状态或私有素材提交到 Git。
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
| ProjectOps typed roots | 管理任务、决策和交付 | 通过对应 ProjectOps 契约维护 |

## 常用命令与完工验收

```bash
pops project doctor --json
pops docs check mochi --json
pops backlog list mochi --json
git diff --check
```

当前文档与建档变更运行上述检查，并核对文档链接和仓库状态。
`docs check` 仅检查固定文档存在、类型与一级标题，不代替内容审阅或后续代码测试。
实现功能后同步产品和架构文档，运行覆盖实际变更的测试及质量门禁。
已有 CodeGraph 索引且修改其覆盖源码时收尾运行 `codegraph sync`；没有索引则跳过。
