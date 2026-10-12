# dsh-reasoning-setting

给 DSH 桌面端（Web GUI）的「设置 → 模型」加一个**按模型勾选思考强度**的可视化控件，勾完保存即写进 profile 配置。

> 自用维护的小插件，不发布（`package.json` 里 `"private": true`）。它是**纯新增**：挂在官方声明的
> keyed 座位 `settings.models.provider-card` 上多渲染一块区域，不遮蔽、不替换官方任何界面；
> 删掉接线行就完全回到原样。工程约束与硬规则见 [AGENTS.md](AGENTS.md)。

## 为什么需要它

官方 `@deepseek-ai/dsh-client-ui-settings-models` 的模型行只给了 `id` / `显示名称` /
`上下文窗口` / `最大输出 token 数` / `输入类型`，**刻意没有推理等级**——官方注释写得很清楚：

> effort is a per-MODEL capability, and the models under one provider disagree about it,
> so a provider-scoped control can only be set to a value some of them reject.
> … `cordis.patch.yml` keeps the profile field for a deployment that knows its route.

于是手写一个自定义模型（例如中转站上的 `cn:step-5-preview`）时，它默认
`reasoning: false`：composer 的档位面板里**一个档位都没有**，想开只能手改 YAML。
本插件把这件事补成勾选框。

## 它长什么样

在提供商卡片里（模型行上方）多出一块：

```
┌ 思考强度                              按模型勾选可用档位 ┐
│ cn:deepseek-v4.1-flash                                  │
│  ( 继承 ) ( 非推理 ) ( 自定义 )                          │
│  ☑off ☐minimal ☑low ☑medium ☑high ☐xhigh ☑max          │
│ cn:step-5-preview                                       │
│  ( 继承 ) ( 非推理 ) ( 自定义 )                          │
│                                                         │
│ [ 保存到配置 ]  放弃改动   有未保存的勾选                │
└─────────────────────────────────────────────────────────┘
```

- 每个模型有三种声明姿态，正好对应该字段的三种合法取值：
  | 姿态 | 写进配置的东西 | 效果 |
  |---|---|---|
  | **继承** | 删掉 `reasoningEfforts` | 保留已安装目录的能力（手写路由等于不提供档位） |
  | **非推理** | `reasoningEfforts: false` | 明确声明这是非推理模型 |
  | **自定义** | `reasoningEfforts: { off: null, low: low, … }` | composer 的档位面板出现这些档位 |
- 档位是官方 schema 的七个：`off / minimal / low / medium / high / xhigh / max`（升序）。
  没声明的档位也能勾——勾上就加进配置。
- 值是**档位名**，`off` 特例写 `null`（表示"支持关闭、但不发任何推理参数"）。
  已经手写成别的分发拼写（例如 `max: ultra`）的档位在重新勾选时**保留原值**，不会被改回档位名。
- 保存前会做两项校验，不合法就不让保存并说明原因：
  1. 只勾 `off`（或一个都不勾）会被适配器拒绝：必须至少有一个 `off` 之外的档位；
  2. 该路由的默认档位（`providers.<route>.reasoning`，本机 `cpa` 是 `max`）没在勾选里时**只提示不拦**：
     未显式选择档位时请求会撞 `UNSUPPORTED_REASONING_EFFORT`，建议一并勾上。

## 交互

| 操作 | 行为 |
|---|---|
| 点姿态按钮 | 切换该模型的声明姿态；切到「自定义」保留原有勾选 |
| 点勾选框 | 就地改草稿（不会立刻写盘），自动切到「自定义」 |
| 「保存到配置」 | 一次 `settings.mutate` 把整段 `models` 数组写回 profile 配置；成功后就地采用返回的 revision |
| 「放弃改动」 | 丢弃全部草稿，回到已保存状态 |
| 读取失败 | 显示原因 + 「重试」按钮，**不退役座位条目** |

写入是**显式保存**的（与官方模型编辑器同一个交互）：勾选期间不写盘，避开"只勾 off"这类中间非法态。

## 它是怎么工作的

**座位**：官方在自己的 `settings.section` 声明里挂了一个 keyed 子座位，
`renderSlot("settings.models.provider-card", { provider, configured, keyConfigured }, { entryKey: row.entry.settingsNs })`，
在每张展示目录行的卡片里渲染。`settingsNs` 是**适配器家族的设置命名空间**
（`dsh-llm-pi-ai` 里 `settingsNs = ctx.fiber.entry.options.id` ⇒ 本机是 `llm-pi-ai`，
`settingsPath = ["providers", <route>]`），所以**注册一次 `key: "llm-pi-ai"` 就接管了所有 pi-ai 卡片的这一块**，
卡片身份由 owner props 里的 `provider.provider`（路由 id，例如 `cpa`）区分。

**数据面**（不在宿主侧写一个字节的 YAML）：

```
读：ctx.remote.settings.describe()
      → namespaces[] 里找 ns = "llm-pi-ai"
      → models = user[providers][route].models ?? base[providers][route].models   （与官方编辑器同口径）
      → revision 用来做乐观并发
写：ctx.remote.settings.mutate("llm-pi-ai",
      [{ op: "set", path: ["providers", "cpa", "models"], value: <整段新数组> }], revision)
      → dsh-settings 校验 volatile 路径 → dsh-config-editor 外科手术式写 profile 的
        cordis.patch.yml（保留注释与 insert 分节、原子写入、失败回滚）→ 热重载
```

- 只带一个 `set`：整段数组换新，与官方模型编辑器（`pathOps` 产出 `set providers.<route>.models`）完全一致。
- **没被改过的模型原样保留**（同一个对象引用，逐字节不动）——避免把 schema 默认值物化进用户配置。
- 陈旧写入被 `settings/conflict` 拒绝，插件会提示"配置已在别处修改"并重读。
- 订阅 `settings/document-updated`，别处改了配置也会跟上。

## 安装（接线）

不需要 pnpm、不需要 `node_modules`、不改 profile 的 `package.json`。只在
`C:\Users\admin\.dsh\profiles\desktop\cordis.patch.yml` 末尾加一个 insert 行：

```yaml
- insert:
    - id: dsh-reasoning-setting
      name: 'file:///D:/project/dsh-plugins/dsh-reasoning-setting/lib/index.js'
```

`name` 必须指向本仓库的 `lib/index.js`（正斜杠形式）。**仓库一搬家就要同步改这一行。**
之后 `dsh-client-modules` 的投递链路会接手：从该条目的模块位置向上找最近的 `package.json`
→ 读 `dsh.client` 声明 → 从 `exports["./client"]` 定位浏览器 bundle → Host 在 `/plugins` 下发布
并写进浏览器 boot graph。保存后由 Loader 加载；界面若没变化，按 `Ctrl+R` 刷新一次。

## 卸载 / 回滚

删掉那个 insert 行即可，官方界面立刻回到原样（客户端插件随 Loader 条目一起卸载）。
接线前的 profile 备份：`cordis.patch.yml.bak-1791779255424`。

## 自检

```powershell
node D:\project\dsh-plugins\dsh-reasoning-setting\tools\verify.mjs
# 想连 profile 接线一起校验：
node D:\project\dsh-plugins\dsh-reasoning-setting\tools\verify.mjs --patch "C:\Users\admin\.dsh\profiles\desktop\cordis.patch.yml"
```

纯 Node、零依赖的离线程序：用 `node:vm` 跑**真实的** `lib/client.js`，喂一个会真跑 hooks、
能点击重渲染的 React 替身与一个会真的把 `set` op 应用进 user 层、递增 revision 的假 settings 服务，
覆盖 8 组共 111 条断言（含"渲染 → 勾选 → 保存 → 断言 `mutate` 载荷与写回后视图"的端到端链路）。
全部通过时打印 `全部通过 ✓` 并以 0 退出。

新加断言必须做**反向验证**（注入违规、看它变红、再还原）：

```powershell
node D:\project\dsh-plugins\dsh-reasoning-setting\tools\mutation-check.mjs
```

7 条注入（写入路径、未改动行逐字节保留、座位边界、inject 清单、座位 key、数据源层级、off 的 null）
必须全部命中；全部命中才算护栏真的存在。

## 已知取舍

- **只管 pi-ai 家族**（`llm-pi-ai`，即自定义 / 第三方模型路由）：`llm-deepseek` 家族的模型没有
  按模型的推理字段（那边是 provider 级 `reasoningEffort`），所以不在范围里。加一个命名空间 =
  在 `lib/client.js` 的 `NAMESPACES` 里加一项。
- **只列出配置里声明过的模型**（profile 覆盖层，其次继承层）：目录路由（已安装 catalog、配置里没写模型）
  不渲染这块区域，避免在还没保存模型时凭空生成一份用户层数组；手写路由没有模型时给一行指引。
- **不能按模型设默认档位**：`llm-pi-ai` 的模型字段里没有这个字段，默认档位只能是路由级
  `providers.<route>.reasoning`（本机 `cpa` 是 `max`）。插件只对"没勾默认档位"给提示。
- **不能发明新档位名**：schema 的键只能取那七个（值可以重命名分发拼写，插件会保留手写的值）。
- **文案硬编码中文**：没有注册 locale 命名空间（有意少一个失败面）。
- **自带 CSS 而不是复用官方 class**：官方样式是 hashed CSS module，插件拿不到，所以自己注入一份
  用 `--dsw-alias-*` token 的样式（亮暗主题都跟着走）。

## 目录结构

```
dsh-reasoning-setting/
  package.json      包清单：exports{"./client"} + dsh.client{platform:"web"}
  lib/index.js      宿主半边：空的 apply，只作为 Loader 的接线柱
  lib/client.js     浏览器半边：window.__ModuleLoader__ 懒 CJS bundle（全部 UI 与读写）
  tools/verify.mjs  自检程序（纯 Node，零依赖）
  AGENTS.md         工程约束：硬规则、不变量、改动流程
```

运行时**零依赖**：宿主半边不 import 任何东西；浏览器半边只 `require("react")`。

## 改代码前

必须先读 [AGENTS.md](AGENTS.md)：那里写了四条各对应一次真实故障的硬规则（条目抛错即被退役、
inject 清单缺一项就整块静默消失、HMR 会读到半截文件、配置写入只能走 settings.mutate），
以及"改完必须跑自检并看到 `全部通过 ✓`、新断言必须反向验证"的流程。
