# Mochi 架构

## 当前状态

当前只有项目文档，尚无运行时实现。以下描述已接受方向，不声明 API 或存储已发布。

## 组件方向

Web app → Mochi 应用认证与 Agent API → Pi runtime → 模型 provider。
Mochi 统一持有 provider 认证，不同应用使用独立 AgentSession、工具配置与工作目录。
首期采用单一活动认证拥有者，多个消费者不要求复制多份 OAuth 凭据。

## 认证与持久化

保留 Pi 的 provider catalog、登录和自动刷新能力。原生可写 auth.json 配合专属持久卷是第一版候选，
自定义 CredentialStore 是后续可评估路径；实施前按固定 SDK 版本验证。
API key 的持久化保存与 runtime override 必须区分；OAuth 刷新后的凭据必须写回持久存储。
配置、认证、模型目录缓存和各应用会话分别识别，禁止把凭据写入镜像或日志。

各 provider 的设备码、回调或手工授权输入分别适配；浏览器 localhost 不指向 ACA 容器。
不保证认证永不失效，必须处理撤销和重新登录。

## 并发与权限边界

部署交接和维护也可能引入实例重叠，不能用 maxReplicas=1 代替认证所有权协调。
需要多个执行实例时，明确刷新全过程的串行化和最新凭据读取策略。
允许任意 shell 的工具执行环境应与凭据拥有者隔离；目录分开不是安全边界。
具体隔离技术、租约和存储锁语义在实现前决策，不预设对抗恶意同用户 ancestor 替换。

## 数据所有权与部署

Mochi 拥有执行会话、任务状态和 provider 认证；消费者拥有正文、角色等 canonical 业务数据。
共享资源由 `ccp` 提供，Mochi 定义镜像、配置、健康检查和存储需求。
长任务脱离浏览器连接、事件恢复及 ACA Jobs 接入在首期范围细化时确定。

## 技术方向与官方入口

运行时以 Pi SDK 为核心，语言和依赖版本在首个实现中固定，当前没有安装 SDK。

- [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [Pi providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md)
- [Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/overview)

## 验证方向

覆盖认证恢复、刷新持久化、凭据失效、并发刷新、应用会话隔离和敏感信息不进入客户端。
真实 subscription 登录及模型调用按实际账户与授权范围验证，不能用 mock 宣称兼容全部 provider。
