# Turn Recap for DSH

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）用的常驻插件：每轮对话结束后，在 Web UI 的
对话流末尾给出一段模型生成的简短小结，也可以用 `/recap` 主动重算。

<img src="icon.svg" width="72" height="72" alt="轮次小结图标">

[English](README.md) | 中文

## 功能

- **轮次结束、会话安静下来之后**，在该轮末尾出现一张卡片：一到三句话说明这一轮做成了什么，必要时补一句尚未完成的部分。
  卡片会先等过一段安静窗口（默认两分钟），而且如果你在窗口内又发了新提示词，这一轮的卡片就不会出现——它是「上次做到哪」
  的提示，而不是你正在读的那条回复的第二份摘要。正文跟随对话语言。
- **`/recap`**：按需为最近一轮立即生成同样的小结——适合某一轮没等到安静窗口、你翻过去了、或者想重新看一下当前进展的时候。
- 没有可总结内容的轮次（被中断、失败、空轮）不出卡片；子代理会话默认跳过。

卡片使用宿主的主题变量，跟随明暗主题与当前语言（随包提供中英两套词条）。

## 环境要求

- **DSH `>=0.2.1-rc.2`** —— 本插件的开发与验证都基于这个运行时版本，`package.json` 用 `engines.dsh` 声明了下限。启动器会在两处校验它：
  安装 bundle 时，以及包含它的 profile 启动时。运行时低于下限会被 `incompatible-version` 拒绝，并给出未满足的范围。
- 用 `dsh --version` 查看 profile 实际会用的运行时版本。
- 这个下限对应的是插件实际绑定的 API 集合，不是拍脑袋定的：`agent/turn-stopping`、带客户端可见 `wire` 视图的 session
  投影、`commands` 注册表（含 `command/done` 的结果文本）、`llm.prepareCall()` 流式调用，以及客户端的
  `conversation.chat.turnTail` / `conversation.chat.commandview` 槽位和 `remote.session.projections`。提供了这些 API 的相邻
  版本大概率也能用，但只有这里声明的下限是实际验证过的组合。

刻意没有声明 `peerDependencies`：这个 bundle 不 import 任何 `@deepseek-ai/*` 模块，只在运行时解析 Cordis 服务，
写 peer 范围反而是在描述一个并不存在的依赖。

确实要在更低版本上跑，启动器提供的口子是**精确版本豁免**，而不是范围：

```bash
dsh plugin --profile <profile> allow-version '@local/dsh-turn-recap@1.0.1' --dsh-version '<runtime>' --accept-risk
```

Plugin Manager 里也有同样的授权入口。它等于让未经验证的进程内代码跑在你的运行时上——文档明确的风险是崩溃与数据丢失，
而且授权只对一个确切的插件版本 + 一个确切的运行时版本生效。

## 安装

这是一个 DSH bundle：声明了 `dsh.bundle.patch` 与 `dsh.client` 两半，用启动器自带的插件命令装进 profile，不发布到 npm。

```bash
# 默认分支最新提交
dsh plugin add github:littepointR/dsh-turn-recap

# 或锁定 tag 版本
dsh plugin add github:littepointR/dsh-turn-recap#v1.0.1
```

`dsh plugin` 会把参数转发给 profile 目录里的 pnpm，安装成功后选中该 bundle。profile 的 YAML 里启用了 HMR 时组合会立即重载，
否则下次启动生效。装进指定 profile 时把 profile 名传进去：

```bash
dsh plugin --profile <name> add github:littepointR/dsh-turn-recap
```

bundle 的 patch 会插入一行 Loader 配置：

```yaml
- insert:
    - id: turn-recap
      name: '@local/dsh-turn-recap'
```

### 从本地检出安装

```bash
git clone https://github.com/littepointR/dsh-turn-recap.git
dsh plugin --profile <name> add link:D:/path/to/dsh-turn-recap
```

也可以在 DSH 会话里让 agent 用 profile 的 plugin manager 从这个目录安装。

重新安装或启停插件不需要重启 Harness：禁用再启用该行即可重新导入宿主模块。

## 配置

所有字段都可选。在 profile 的 `cordis.patch.yml` 里给这一行加 `config` 块即可——这层配置能跨包升级保留。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | `false` 时不注册投影、轮次监听与 `/recap` |
| `maxTokens` | `200` | 小结请求的输出上限 |
| `temperature` | `0.2` | 采样温度 |
| `timeoutMs` | `12000` | 单次小结请求的硬超时（毫秒） |
| `digestChars` | `6000` | 送给模型的轮次摘要长度上限 |
| `idleMs` | `120000` | 卡片出现前该轮需要保持的安静窗口；`0` 表示立即出现 |
| `skipSubagents` | `true` | 子代理会话不自动出小结 |
| `provider`、`model` | 未设置 | 显式指定路由；默认复用本轮自己的请求路由 |

```yaml
- insert:
    - id: turn-recap
      name: '@local/dsh-turn-recap'
      config:
        maxTokens: 300
        skipSubagents: false
```

## 工作原理

```
agent/turn-stopping ──▶ 抽取本轮摘要 ──▶ 模型调用 ──▶ 待定表
                                                      │
turn/end（提交）──▶ 投影 apply ──▶ recap 投影 ──▶ useProjection("recap")
                                                      │
                                          conversation.chat.turnTail
```

1. **`agent/turn-stopping`** 是 agent loop 在提交 `turn/end` 之前派发的串行事件。插件从 session 日志里抽取本轮内容——
   用户请求、最近的工具调用（标注失败）、以及本轮的**最后一条**助手回复——向服务本轮请求的模型索取一段小结。
2. 随后的 **`turn/end`** 提交把文本折进客户端可见的 **`recap` session 投影**，卡片与结束的轮次同一帧到达。
3. 客户端半边注册到 **`conversation.chat.turnTail`** 槽位，用 `useProjection("recap")` 读取投影。每个条目带一个
   `revealAt` 截止时刻：在它之前、或者期间已经开始了新一轮，卡片都不会出现——安静窗口不产生成本，也不会打断正在进行的操作。

**为什么用投影而不是 session 事件？** 插件不能追加新的事件类型：日志里出现当前构建不认识的事件类型会导致会话无法重新打开，
而 `appendPluginRecord()` 只留给一方实验包。session 投影才是承载「会话派生客户端状态」的正规通道。

**为什么要在 `turn/end` 之前生成？** 投影状态是从已提交事件同步折叠出来的，只有提交事件改变状态时 Value 才会被重新读取。
在轮次边界还开着的时候拿到文本，才能让它随提交一起折进状态——延后的只是**出现**，不是请求本身，所以安静窗口既不改成本也不改延迟。

**`/recap`** 是一个普通的 DSH 命令：它不产生 turn，结果随 `command/done` 落日志。客户端半边通过
`conversation.chat.commandview` 槽位的 `recap` 键接管该命令行，自己渲染「生成中 / 成功 / 失败」三态。

## 代价与限制

- **每轮多一次模型请求。** 请求很短，但会由你的 provider 计费；由于没有追加助手消息，它不会出现在会话的 token 统计里。
- **轮次会等小结就绪后才关闭。** 生成发生在 `turn/end` 之前，provider 慢时边界最多延后 `timeoutMs`；失败或超时只会退化成
  「没有卡片」，绝不会让轮次失败。安静窗口只影响你看到的时间，不影响成本。
- **没等到窗口的卡片不会出现。** 如果在 `idleMs` 之内就发出了新提示词，那一轮不会留下卡片；确实想要时用 `/recap` 补一张。
- **小结文本无法从日志重建。** 它存放在投影缓存里，重启后仍在；如果投影单元格只能从日志重新折叠（例如插件被重新注册），
  历史卡片会从空白开始。
- **`stateVersion` 控制旧口径缓存。** 提升它会让上一套取材规则产出的小结失效，而不是继续展示旧文本。

## 开发

两半都是零依赖的 JavaScript：宿主半边是普通 ESM，客户端半边是只向页面索取 `react` 的模块加载器工厂。

```bash
npm test        # 在假的 Cordis 上下文里跑宿主半边，除了 Node 什么都不需要
npm run check   # 对所有 JavaScript 入口做语法检查
```

宿主测试覆盖投影折叠、轮次摘要抽取、`/recap` 处理器以及各条失败路径，所以多数改动不必启动 Harness 就能验证。

## 许可

MIT，详见 [LICENSE](LICENSE)。
