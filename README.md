# Mochi

面向个人多个 Web app 的云端 Pi Agent 执行核心，部署目标为 Azure Container Apps。

## 当前状态

项目已建档并注册到 ProjectOps；尚无应用代码、可运行服务或已部署云资源。
产品规格和架构文档记录已接受方向及待决策事项，不代表功能已实现。

## 项目入口

- [产品规格](docs/PRODUCT_SPEC.md)：目标、范围与初期验收方向。
- [架构](docs/ARCHITECTURE.md)：组件职责与跨项目边界。
- [Agent 指引](AGENTS.md)：开发与 ProjectOps 操作入口。

## 项目管理

项目 ID 为 `mochi`。在所属 ProjectOps workspace 或 Repo 中执行：

```bash
pops project list --json
pops project doctor --json
pops backlog list mochi --json
pops docs check mochi --json
```

安装、运行、测试和部署命令随首个实现补充；当前不存在这些执行入口。
