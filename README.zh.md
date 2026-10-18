# Turn Recap for DSH

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）用的常驻插件：每轮对话结束后，在 Web UI 的
对话流末尾给出一段模型生成的简短小结，也可以用 `/recap` 主动重算。

<img src="icon.svg" width="72" height="72" alt="轮次小结图标">

[English](README.md) | 中文

## 功能

- **每轮结束自动小结**：轮次末尾出现一张安静的卡片，一到三句话说明这一轮做成了什么，必要时补一句尚未完成的部分。
  正文跟随对话语言。
- **`/recap`**：按需为最近一轮生成同样的小结——适合自动小结被跳过、你翻过去了、或者想重新看一下当前进展的时候。
- 没有可总结内容的轮次（被中断、失败、空轮）不出卡片；子代理会话默认跳过。

卡片使用宿主的主题变量，跟随明暗主题与当前语言（随包提供中英两套词条）。

## 安装

这是一个本地 DSH 插件包：声明了 `dsh.bundle.patch` 与 `dsh.client` 两半，安装进 profile，不发布到 npm。

```bash
git clone https://github.com/littepointR/dsh-turn-recap.git
```

然后在你的 DSH profile 里把这个目录作为 bundle 安装——在 DSH 会话里让 agent 用插件的绝对路径执行安装（走 profile 的
plugin manager），或用你自己的工具做等价安装。bundle 的 patch 会插入一行 Loader 配置：

```yaml
- insert:
    - id: turn-recap
      name: '@local/dsh-turn-recap'
```

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
3. 客户端半边注册到 **`conversation.chat.turnTail`** 槽位，用 `useProjection("recap")` 读取投影。

**为什么用投影而不是 session 事件？** 插件不能追加新的事件类型：日志里出现当前构建不认识的事件类型会导致会话无法重新打开，
而 `appendPluginRecord()` 只留给一方实验包。session 投影才是承载「会话派生客户端状态」的正规通道。

**为什么要在 `turn/end` 之前生成？** 投影状态是从已提交事件同步折叠出来的，只有提交事件改变状态时 Value 才会被重新读取。
在轮次边界还开着的时候拿到文本，才能让它随提交一起折进状态。

**`/recap`** 是一个普通的 DSH 命令：它不产生 turn，结果随 `command/done` 落日志。客户端半边通过
`conversation.chat.commandview` 槽位的 `recap` 键接管该命令行，自己渲染「生成中 / 成功 / 失败」三态。

## 代价与限制

- **每轮多一次模型请求。** 请求很短，但会由你的 provider 计费；由于没有追加助手消息，它不会出现在会话的 token 统计里。
- **轮次会等小结就绪后才关闭。** 生成发生在 `turn/end` 之前，provider 慢时边界最多延后 `timeoutMs`；失败或超时只会退化成
  「没有卡片」，绝不会让轮次失败。
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
