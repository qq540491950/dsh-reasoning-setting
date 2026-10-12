# dsh-reasoning-setting

给 DSH 桌面端（Web GUI）的「设置 → 模型」加一个**按模型勾选思考强度**的可视化控件，勾完保存即写进 profile 配置。

> 自用维护的小插件（`package.json` 里 `"private": true`，不发布到 npm；源码公开在
> [GitHub](https://github.com/qq540491950/dsh-reasoning-setting)）。它是**纯新增**：挂在官方声明的
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

**首选形态是行内的**：点开提供商的「编辑」、再展开某个模型行（那排 `上下文窗口 / 最大输出 token 数 /
输入类型`），`思考强度` 就长在 `输入类型` 的正下方——和官方字段同一种语法：一行字段标签 + 一排勾选框。
**这一行有未保存的勾选时，勾选框下面立刻出现「保存到配置 / 放弃这一行」**，同时这行左边会亮起一条
告警色竖条 + 「未保存」小字。卡片最底部（官方编辑器页脚下方）另有一条保存条，作为兜底入口。

```
cn:deepseek-v4.1-flash   （官方模型行）
    上下文窗口 [1M]   最大输出 token 数 [131072]
    输入类型   ☑ 文本  ☑ 图片
    思考强度   未保存                            恢复默认
    ☑ off  ☐ minimal  ☑ low  ☑ medium  ☑ high  ☐ xhigh  ☑ max      ☐ 非推理模型
    [ 保存到配置 ]  放弃这一行          ← 有未保存勾选时才出现，就在勾选框下面

    （卡片底部，同样有未保存勾选时才出现「有未保存的勾选」）
    未勾选任何档位 = 不写这个字段（继承适配器/目录的能力）；勾「非推理模型」= 写 reasoningEfforts: false。
    [ 保存到配置 ]  放弃改动   有未保存的勾选
```

> 为什么行内也要有一个保存入口：行内勾选框在模型行里，而卡片底部那条保存条隔着整个官方编辑器。
> 只有底部一个入口时，勾完就走、以为"已经设置了"，其实草稿只活在组件 state 里，重开配置页就还原
> （真机上就是这么踩的）。两处按钮是**同一个 `save`**，禁用判据也共用 `saveDisabled`，不会分叉。

**行内挂不上时自动退回整块**（还是同样的控件，渲染在卡片顶部、官方编辑器上方）。触发回退的情况：
拿不到 `react-dom` 种子、官方改了模型行的 DOM 结构、或这个模型还没写进配置。
**行内成功过之后，兜底整块只留保存条与提示，不再重复列出每个模型的勾选组**——勾选控件只活在
模型行里，整块与行内不会看起来像两份设置。整块形态下的可见性沿用原有的结构性 CSS 判据（见下）。

> 官方那句 `renderSlot` 在**卡片折叠态也会渲染**，而座位契约只给 `provider` / `configured` /
> `keyConfigured`，拿不到"卡片是否在编辑"。所以整块形态的可见性用一个**结构性判据**（纯 CSS，不依赖
> hashed class）：
> 1. 官方 slot 锚点 `div[data-slot="settings.models.provider-card"]` 是某张卡片的直接子节点
>    （渲染器注释里明说这个锚点就是"可寻址面"）；
> 2. **同一张卡片里出现了非 checkbox 的输入控件**——官方编辑器/凭据输入打开时的必然产物
>    （我们自己的勾选框都是 checkbox，不会自我触发）。
>
> `:has()` 不被支持时保持默认可见（宁多不少，绝不会把功能藏没）。行内挂载成功时这块由
> `data-inline="1"` 独立隐藏，不依赖 `:has`。

- 勾选框的语义就是配置字段的三种合法取值：
  | 界面操作 | 写进配置的东西 | 效果 |
  |---|---|---|
  | 什么都不勾（或点「恢复默认」） | 删掉 `reasoningEfforts` | 保留已安装目录的能力（手写路由等于不提供档位） |
  | 勾「非推理模型」 | `reasoningEfforts: false` | 明确声明这是非推理模型 |
  | 勾若干档位 | `reasoningEfforts: { off: null, low: low, … }` | composer 的档位面板出现这些档位 |
- **「默认档位」下拉**（每张卡片一个，写路由级 `providers.<route>.reasoning`）：它决定"切到这条
  路由的模型时，选择器里『默认』那一格落在哪"，以及**请求没带显式档位时实际发送的值**。
  下拉里**只列这条路由每个模型都勾过的档位**（外加「不设置」）——只要有一个模型不认这一档，
  它那些"没显式选档位"的请求就会被适配器拒（`UNSUPPORTED_REASONING_EFFORT`）。自动推荐值 =
  这些共同档位里最高的那个（`max` 有就用 `max`，没有依次向下；一个都没有就只留「不设置」）。
  选「不设置」= `unset` 掉这个字段（不是写空串）。
- 档位是官方 schema 的七个：`off / minimal / low / medium / high / xhigh / max`（升序）。
  没声明的档位也能勾——勾上就加进配置。
- 值是**档位名**，`off` 特例写 `null`（表示"支持关闭、但不发任何推理参数"）。
  已经手写成别的分发拼写（例如 `max: ultra`）的档位在重新勾选时**保留原值**，不会被改回档位名。
- 勾「非推理模型」时上面的档位勾选会**变灰休眠**（不丢），取消勾选即恢复原样。
- 保存前会做两项校验：
  1. **只勾 `off`** 会被适配器拒绝（字典里必须至少有一个 `off` 之外的档位），就地拦下并说明；
  2. 该路由的默认档位（`providers.<route>.reasoning`）没在某个模型的勾选里时**只提示不拦**：
     未显式选择档位时请求会撞 `UNSUPPORTED_REASONING_EFFORT`，建议一并勾上（或者把默认档位
     换成共同档位——下拉里只给共同档位，就是为了不让这种情况发生）。
- 「恢复默认」只在**该模型确实声明过**时出现（免得给每个模型都挂一个没用的链接）。

## 交互

| 操作 | 行为 |
|---|---|
| 展开一个模型行 | `思考强度` 出现在该行 `输入类型` 的正下方（行内形态） |
| 点档位勾选框 | 就地改草稿（不会立刻写盘）；勾了就自动取消「非推理模型」 |
| 点「非推理模型」 | 写 `reasoningEfforts: false`；原有档位勾选休眠保留 |
| 点「恢复默认」 | 把该模型的草稿清成"不写这个字段"（继承）；行内形态常驻、未声明时置灰 |
| 行内「保存到配置」 | 有未保存勾选时出现在勾选框下面；一次 `settings.mutate` 把整段 `models` 数组写回 profile 配置（这张卡上所有未保存的勾选一起写），成功后就地采用返回的 revision |
| 行内「放弃这一行」 | 只丢这一个模型的草稿，其它行的未保存改动保留 |
| 卡片底部「保存到配置」 | 与行内那个按钮同一个动作（兜底入口；卡片折叠时只剩它） |
| 「默认档位」下拉 | 改路由级默认档位（`providers.<route>.reasoning`）；与勾选一起在同一次保存里写下去，`不设置` = `unset` 这个字段 |
| 「放弃改动」 | 丢弃全部草稿（含默认档位），回到已保存状态 |
| 读取失败 | 显示原因 + 「重试」按钮，**不退役座位条目** |

写入是**显式保存**的（与官方模型编辑器同一个交互）：勾选期间不写盘，点「保存到配置」才写。
一次保存 = **一个** `set` 承载整段 `models` 数组（与官方编辑器同一种最小写法），改过默认档位时
再加一条兄弟路径的 op（`providers.<route>.reasoning` 的 `set` / `unset`）。
保存成功后提示会点明：**还要在 composer 的档位面板里选一次档位**，请求才会带上它——
勾选写的是"这个模型提供哪些档位"（能力声明），不是"用哪个档位"；路由默认档位才是"没显式选时发什么"。

## 它是怎么工作的

**座位**：官方在自己的 `settings.section` 声明里挂了一个 keyed 子座位，
`renderSlot("settings.models.provider-card", { provider, configured, keyConfigured }, { entryKey: row.entry.settingsNs })`，
在每张展示目录行的卡片里渲染。`settingsNs` 是**适配器家族的设置命名空间**
（`dsh-llm-pi-ai` 里 `settingsNs = ctx.fiber.entry.options.id` ⇒ 本机是 `llm-pi-ai`，
`settingsPath = ["providers", <route>]`），所以**注册一次 `key: "llm-pi-ai"` 就接管了所有 pi-ai 卡片的这一块**，
卡片身份由 owner props 里的 `provider.provider`（路由 id，例如 `cpa`）区分。

**行内挂载**（把勾选组放进模型行）：官方模型行没有扩展座位，所以这一步不走座位契约，而是
**往官方 DOM 里插门户容器**：

```
座位节点（div.dsh-rs-box，官方 SlotOutlet 的 div[data-slot] 的孩子）
  → 卡片（锚点的父节点）
      → 每个模型行的展开体：`输入类型` 那个 <fieldset> 的正下方插一个容器（React 门户）
      → 卡片末尾插一个保存条容器（React 门户）
      → MutationObserver（childList/subtree）跟随展开/折叠/增删行，重新对账
```

- 锚点**只用结构**：展开体里唯一的 `<fieldset>` 就是 `输入类型`；它的父节点是展开体；
  展开体的前一个兄弟是行头，行头第一个输入框是模型 id。不看 hashed class、不认本地化文案。
- 容器**只挂配置里已经写着的模型 id**：官方行里可能还有没保存的草稿（刚加的空行、刚删的行），
  对不上的行一个都不挂，避免把 A 模型的勾选组渲染到 B 模型名下。
- 自己造成的 DOM 变更（插容器、门户内容重渲染）用 `data-dsh-rs-own` 标记并从观察里滤掉，否则会自触发重挂。
- 任何一步出问题都退回整块形态并打一条 console 警告，**绝不抛出**（keyed 座位上的条目抛错会被退役）。
- 取不到 `react-dom` 种子（shell 固化的种子表，官方 `dsh-client-ui-renderer` 也在取它）时直接关闭行内挂载。

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
覆盖 9 组共 179 条断言（`--patch` 时 181 条；含"渲染 → 勾选 → 保存 → 断言 `mutate` 载荷与写回后
视图"的端到端链路，以及用假 DOM 断言行内挂载的结构锚点、挂/撤、观察者过滤与降级路径）。
全部通过时打印 `全部通过 ✓` 并以 0 退出。

新加断言必须做**反向验证**（注入违规、看它变红、再还原）：

```powershell
node D:\project\dsh-plugins\dsh-reasoning-setting\tools\mutation-check.mjs
```

26 条注入（写入路径、未改动行逐字节保留、座位边界、inject 清单、座位 key、数据源层级、off 的 null、
编辑态可见性的两个要素、行内容器的插入位置、按模型 id 过滤、react-dom 缺失时的降级、行内保存入口与
其共用判据、行内提示、放弃一行只删一行、保存成功文案、路由默认档位的取交集/跳过 off/参与改动/unset）
必须全部命中；全部命中才算护栏真的存在。

## 已知取舍

- **"只在编辑态出现"是结构性判据，不是官方开关**：见上面「它长什么样」里的引用块。它依赖两件
  事实（官方 slot 锚点 `data-slot` 的存在、官方编辑器里会出现非 checkbox 的输入控件）。官方哪天
  把编辑器改成全 checkbox 表单、或换掉锚点属性，这块会退回"一直可见"或"一直不可见"；`@supports`
  守卫保证老引擎落在"一直可见"这一侧，不会把功能藏没。
- **行内挂载依赖官方模型行的 DOM 结构，但失败是显式的**：官方模型行没有扩展座位，所以"长在
  `输入类型` 下面"只能往官方 DOM 里插门户容器。锚点刻意只用结构（`fieldset` / 行头的输入框 /
  兄弟关系），不看 hashed class、不认本地化文案；官方哪天改了结构，扫描会返回空表，
  插件**自动退回座位里的整块形态**并在控制台留一条警告——功能不会消失，位置退回卡片顶部。
  反过来它也永远不去动官方节点本身：只追加自己的容器，官方卸载子树时容器随之消失，
  下一次对账再补回来。
- **三个保存入口，一份判据**：行内每一条有草稿的模型行、卡片底部的保存条，都只是**草稿**的展示面
  （同一份 state、同一个 `save`、同一个 `saveDisabled` 判据）。「放弃这一行」只丢一行的草稿，
  「放弃改动」丢全部。官方编辑器自己的「保存」用的是它打开时的 revision，期间我们写过配置的话
  它会被 `settings/conflict` 拒绝并提示——两边互不静默覆盖。
- **路由默认档位只给共同档位**：`providers.<route>.reasoning` 是**整条路由**的兜底值，pi-ai 在
  "请求没带显式档位"时用它（`resolveReasoningLevel(model, undefined ?? profile.reasoning)`），
  遇到不认这一档的模型直接抛 `UNSUPPORTED_REASONING_EFFORT`。所以下拉里只列每个模型都勾过的档位；
  一个共同档位都没有时只留「不设置」（宁可不设，也不把同路由其它模型打挂）。
  这也意味着**做不到"每个模型各记一个默认档位"**——DSH 的默认选择只有一份
  （`agent-default-model` 的 `{provider, model, reasoningEffort}`），路由默认也只有一份。
- **只管 pi-ai 家族**（`llm-pi-ai`，即自定义 / 第三方模型路由）：`llm-deepseek` 家族的模型没有
  按模型的推理字段（那边是 provider 级 `reasoningEffort`），所以不在范围里。加一个命名空间 =
  在 `lib/client.js` 的 `NAMESPACES` 里加一项。
- **只列出配置里声明过的模型**（profile 覆盖层，其次继承层）：目录路由（已安装 catalog、配置里没写模型）
  不渲染这块区域，避免在还没保存模型时凭空生成一份用户层数组；手写路由没有模型时给一行指引。
- **不能按模型设默认档位**：`llm-pi-ai` 的模型字段里没有这个字段，默认档位只能是路由级
  `providers.<route>.reasoning`（插件现在能改它，见上面「默认档位」）。插件只对"某个模型没勾
  路由默认档位"给提示。
- **不能发明新档位名**：schema 的键只能取那七个（值可以重命名分发拼写，插件会保留手写的值）。
- **文案硬编码中文**：没有注册 locale 命名空间（有意少一个失败面）。
- **自带 CSS 而不是复用官方 class**：官方样式是 hashed CSS module，插件拿不到，所以自己注入一份
  用 `--dsw-alias-*` token 的样式（亮暗主题都跟着走）。

## 目录结构

```
dsh-reasoning-setting/
  package.json          包清单：exports{"./client"} + dsh.client{platform:"web"}
  lib/index.js          宿主半边：空的 apply，只作为 Loader 的接线柱
  lib/client.js         浏览器半边：window.__ModuleLoader__ 懒 CJS bundle（全部 UI 与读写）
  tools/verify.mjs      自检程序（纯 Node，零依赖）
  tools/mutation-check.mjs  反向验证：往 client.js 注入 22 条违规，确认自检真的会红
  AGENTS.md             工程约束：硬规则、不变量、改动流程
```

运行时**零依赖**：宿主半边不 import 任何东西；浏览器半边只 `require("react")` 与
`require("react-dom")`（都是平台种子模块，取不到后者时行内挂载自动关闭）。

## 改代码前

必须先读 [AGENTS.md](AGENTS.md)：那里写了四条各对应一次真实故障的硬规则（条目抛错即被退役、
inject 清单缺一项就整块静默消失、HMR 会读到半截文件、配置写入只能走 settings.mutate），
以及"改完必须跑自检并看到 `全部通过 ✓`、新断言必须反向验证"的流程。
