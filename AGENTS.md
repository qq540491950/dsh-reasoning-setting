# AGENTS.md

> **状态：已归档（2026-10-23）。** 官方 DSH 已原生提供思考强度配置，本项目停用、仓库转只读存档。
> 不要再接线、不要再往 profile 里加 `insert:` 行。本文件保留为**历史约束清单**：里面的座位规则、
> `inject` 清单、revision 写入、行内门户挂载等经验仍然成立，但描述的是「官方这个功能还没原生实现时」
> 的那个插件。唯一的例外是第 5、7、8 节的操作纪律（自检 / 提交 / 只碰自己那一行）——真要在这个仓库
> 里再动手时照样适用。

给**在这个仓库里动手的 AI 与人**看的约束清单。动手前先读完第 2 节——那里的每一条都对应一次真实
故障或一次真实的配置损坏风险，相关代码看着"多余"但都不是。

## 1. 这是什么

DSH 桌面端（Web GUI）的**纯客户端**插件：在「设置 → 模型」的提供商卡片里，为每个模型勾选思考强度
（`llm-pi-ai` 的 `providers.<route>.models[].reasoningEfforts`），保存后写进 profile 的
`cordis.patch.yml`。

- **自用维护，不发布**。`package.json` 里 `"private": true`；接线只有一种：DSH profile 里的一个路径行。
- **零运行时依赖、零构建步骤**。`lib/client.js` 就是直接投递给浏览器的产物，改完即产物。
- 仓库里只有 Linux 风格 LF 换行（`.gitattributes` 强制），不要提交 CRLF。

### 文件职责

| 文件 | 职责 | 改它的风险 |
|---|---|---|
| `lib/client.js` | 浏览器半边：全部 UI、读取与写入，`window.__ModuleLoader__` 懒 CJS bundle | **高**——第 2 节五条硬规则全在这里 |
| `lib/index.js` | 宿主半边：空的 `apply`，仅作为 Loader 的接线柱 | 低，但**不许删**：删了 `dsh-client-modules` 从该条目向上找不到 `package.json`，客户端 bundle 就不再投递 |
| `package.json` | 包清单契约（第 4 节） | 中——改错就整体不加载 |
| `tools/verify.mjs` | 离线自检：纯 Node、零依赖，用 `node:vm` 跑**真实的** `lib/client.js`（自带会真跑 hooks、能点击重渲染的 React 替身） | 低；改它必须同步改断言，**不许为了让它变绿而放宽断言** |
| `tools/mutation-check.mjs` | 反向验证：往 `lib/client.js` 注入 30 条违规，确认自检真的会红（护栏本身的自检） | 低；注入点跟着源码走，源码改了注入点找不到会报 `?` |
| `README.md` | 面向使用者的介绍与使用说明 | 低 |
| `AGENTS.md` | 本文件（工程约束） | 低 |

## 2. 五条硬规则

### 2.1 遮蔽型座位：条目一抛错就被退役

`single` / `keyed` / `list` 这类座位在 DSH 里有一条硬规则：**条目抛出的错误被外层边界捕获后，
该条目被退役**（`SlotCore.reportEntryError(..., { abdicate: true })`）。退役之后要等页面刷新或
bundle 重新发布才恢复。`settings.models.provider-card` 是 **keyed**，所以本插件：

- **任何可能抛错的东西都不许放在 `inject` 工厂或 `slots.register` 之前**——那里抛错连注册都完不成；
- 座位子树被 `SeatBoundary` 包住（`class SeatBoundary` + `getDerivedStateFromError`），失败降级成
  一行"思考强度面板加载失败：…"，**条目不被退役**。`SeatBoundary` **不是可选项**。

### 2.2 `inject` 清单缺一项 = 整块 UI 静默消失

`ctx.inject([...], cb)` 只在**全部**依赖都能解析时才调用 `cb`。依赖名写错时**不报错、不抛异常**，
只是那块 UI 永远不出现——这是本插件最难查的一种坏法。

**当前清单必须保持这三项，一项都不能少**：

```js
ctx.inject(["slots", "remote", "remote.settings"], (scope) => { … })
```

- `slots`：注册座位。
- `remote` + `remote.settings`：`ctx.remote.settings.describe()` / `.mutate()` 走的是 Remote 代理，
  属性访问按**调用方上下文**求值；少写 `remote.settings` 会在读取时炸（"cannot get property
  remote.settings without inject"），少写 `remote` 则连代理本身都拿不到。
- 官方 `dsh-client-ui-settings-models` 自己的清单是
  `["slots","locale","remote","remote.credentials","remote.llm","remote.settings","remote.session","configForms","settingsSchema"]`，
  可以据此判断"我们没用到哪些"。

`tools/verify.mjs` 的 D1 组对这份清单有回归护栏。

### 2.3 HMR 可能读到半截文件

`dsh-client-hmr` 按 mtime/ctime/size 判版本（约 500ms 一次）。文件写到一半时被读到，按失败策略
「替换失败不回滚」，插件会彻底消失。**写 `lib/client.js` 一定要写临时文件再原子替换**，不要就地
截断写入。恢复办法见第 6 节。

### 2.4 写配置只能走 `ctx.remote.settings.mutate`

- **不许**自己读/写 `cordis.patch.yml`（YAML 手写解析会毁注释、毁 `insert:` 分节）。
- **不许**用 `ctx.loader.create()/remove()` 动态加条目：`EntryTree.write()` 是
  `this.writeFile(this.root.data)`，**整体重写整个配置**，会把手写的 `insert:` 分节压平。
- 正确路径：`ctx.remote.settings.mutate(ns, ops, revision)` → `dsh-settings`（校验 volatile 路径、
  校验 revision）→ `dsh-config-editor`（针对性 YAML 节点编辑、原子写入、失败回滚）→ 热重载。
- **必须带 `revision`**：陈旧写入应被 `settings/conflict` 拒绝，然后**重读**，不要盲目重试覆盖。
- 写回成功后要采用返回值里的 `revision` 与 `user` 子树，不要自己猜。

### 2.5 行内挂载：只追加自己的节点、只用结构锚点、失败必须退回整块

官方模型行没有扩展座位，所以"长在 `输入类型` 下面"是往官方 DOM 里**插门户容器**（React portal +
`MutationObserver` 对账）。这一步碰的是别人的 React 树，有三条不许破：

- **只追加自己的节点**：容器永远是我们自己 `createElement` 出来的 div，插在 `输入类型` 的
  `fieldset` 之后、或卡片末尾（保存条）。**不许**移动/删除/包裹官方节点——React 对自己子树的
  位置有假设，挪官方节点会在它的下一次 reconcile 里炸出 `removeChild` 错误。
- **锚点只用结构**：展开体里唯一的 `fieldset`（= `输入类型`）、展开体的前一个兄弟（= 行头）、
  行头第一个文本输入框（= 模型 id）。**不许**用 hashed class、本地化文案、或 CSS 选择器字符串。
- **对不上就一个都不插**：`attachInline` 返回空挂载 ⇒ `data-inline="1"` 隐藏整块 ⇒ 组件退回
  座位里的整块形态并 `console.warn`。行内挂载是**优化**，不是功能的依赖；任何一步都可能失败
  （官方改结构、拿不到 `react-dom`、没有展开行），失败路径必须和成功路径一样平滑。
  另外容器**只挂配置里已写着的模型 id**——官方行里可能有未保存的草稿行，按 DOM 位置配对会把
  A 模型的控件渲染到 B 模型名下。

自己造成的 DOM 变更必须用 `data-dsh-rs-own` 标记并从 `MutationObserver` 里滤掉，否则
插容器 → 观察到自己插的容器 → 重挂 → 再观察……死循环。

## 3. 不能改的东西（不变量）

| 不变量 | 为什么 | 谁在守 |
|---|---|---|
| bundle `id` 必须等于 `package.json` 的 `name` | `dsh-client-modules` 用它做模块身份 | verify C2 |
| 注册用的 key 必须是 **`"llm-pi-ai"`**（适配器家族的 settings 命名空间，= Loader 条目 id），**不是**路由 id | 官方 `renderSlot(…, { entryKey: row.entry.settingsNs })` 按命名空间分发；`dsh-llm-pi-ai` 里 `settingsNs = ctx.fiber.entry.options.id`。写成 `cpa` 就永远收不到任何卡片 | verify D3 |
| `LEVELS` 必须与 `dsh-llm-pi-ai` 的 `THINKING_LEVELS` 同源同序：`off / minimal / low / medium / high / xhigh / max` | schema 的字典**键**只允许这七个（值可以重命名分发拼写） | verify E1 |
| 写入路径是 `[...provider.settingsPath, "models"]`，**不许硬编码** `["providers", route]` | `settingsPath` 由 owner props 给出（pi-ai 是 `["providers", <route>]`，其它家族可能不同或为空） | verify F17 |
| 一次保存只用**一个** `set` op 承载整段 `models` 数组 | 与官方模型编辑器的 `pathOps` 产物一致；逐字段 op 会在数组下标上撞 `applyPathOp` 的越界检查 | verify F17 |
| 没被改过的模型必须 `return model`（同一个对象引用，逐字节不动） | 一旦复制/重建，就会把 schema 默认值、甚至 `!!js` 表达式的惰性形状物化进用户配置 | verify E20 / F20 |
| `reasoningEfforts.off` 写 `null`；其它档位必须写**非空字符串** | `resolveModelReasoning` 的校验：非 off 档位的 `null` / 空串直接 `invalid`；而 `off: null` 是"支持关闭、不发参数"的唯一表达 | verify E12 / M5 |
| 不许写空字典 `{}`、不写 `null`、不许只勾 `off` | 同上：空字典与 `null` 报 "empty reasoningEfforts"，只有 off 报 "offers no level beyond off"。界面上"全不勾"= 删字段（合法），"只勾 off"= 就地拦下 | verify E15 / F9 / F10 |
| 读取优先 profile **user** 层，其次 **base**（继承）层；**不要**用 describe 的 `value`（解析后的生效值）当数据源 | `value` 已填好默认值，写回会把默认值物化；官方编辑器同样只用 `user`/`base`（其注释写明了这个坑） | verify G18 / F54 |
| `require` 只能取平台种子模块（本插件实际取 `react` 与 `react-dom`；后者取不到时必须降级而不是崩） | 种子表固化在 shell 里，取别的会 `require` 失败 | verify C4 / I0 / I15 / M12 |
| 宿主半边零 `import`、导出 `apply` | 它只当接线柱；多引入依赖就多一个失败面 | verify B1/B2 |
| 只注册 keyed 座位，**不要**加 `priority`、不要注册 `single` 座位 | keyed 座位的唯一性约束在 `(key, priority)`，重复注册直接抛错；`single` 才会遮蔽官方 UI，本插件不需要也没有抢位 | 约定 + verify D3 |
| 整块**只在卡片编辑态**出现：样式表里默认 `.dsh-rs-box { display: none; }`，再用 `@supports selector(:has(*))` + `:is(li, div):has(> [data-slot="settings.models.provider-card"]):has(input:not([type="checkbox"])) .dsh-rs-box:not([data-inline="1"])` 显示；行内挂载成功时用 `.dsh-rs-box[data-inline="1"]` 独立隐藏（不依赖 `:has`） | 官方那句 renderSlot 在卡片折叠态也会渲染，而座位契约没有"卡片是否在编辑"。判据刻意只用官方 slot 锚点（渲染器说它就是可寻址面）+ "编辑器必然带非 checkbox 输入"，不碰 hashed class。`@supports` 守卫保证不支持 `:has` 时是**一直可见**而不是一直不可见 | verify H8b–H8i / M8 / M9 |
| **行内挂载的锚点只用结构**（展开体里唯一的 `fieldset`、它的前一个兄弟是行头、行头第一个文本输入框是模型 id），不看 hashed class、不认本地化文案、不用选择器字符串 | 2.5：锚点一旦依赖 class 或文案，官方一升级或换语言就静默失效 | verify I1 / M10 |
| 行内容器**只挂配置里已写着的模型 id**，对不上的行一个都不挂；只追加自己的节点、不许挪官方节点 | 2.5：按 DOM 位置配对会把 A 模型的控件渲染到 B 模型名下；挪官方节点会撞 React 的 reconcile | verify I2 / I3–I5 / M11 |
| 自己插的节点必须带 `data-dsh-rs-own`，并从 `MutationObserver` 里滤掉 | 不滤就是"插容器 → 观察到自己 → 重挂 → 再观察"的死循环 | verify I6 / I12 |
| 行内保存入口与卡片底部保存条是**同一个 `save` + 同一份 `saveDisabled` 判据**；有未保存草稿的行必须自带「保存到配置 / 放弃这一行」并把提示贴在该行 | 保存条隔着整个官方编辑器，只有底部一个入口时用户勾完就走、以为"设置了却没生效"（草稿只活在组件 state 里，重开配置页即还原）——真机上就是这么踩的 | verify E31–E38 / I16–I18 / M17–M21 |
| 路由默认档位（`providers.<route>.reasoning`）下拉的候选 = 该路由**任一**模型声明过的档位（并集）；但**自动推荐/预选**仍然只取**每个模型都声明过**的档位里最高的那个（`routeDefaultLevel`，max 优先依次向下）；`off` 不进候选；「不设置」写 `unset` 而不是空串 | 它是"请求没带显式档位"时的兜底（`resolveReasoningLevel(model, undefined ?? profile.reasoning)`），所以**自动**写出一个没被某模型声明的值会让那个模型每次请求都被拒（`UNSUPPORTED_REASONING_EFFORT`）——预选必须保守。但候选取交集会把 huawei 压成只剩 `high`（三模型交集 `{high}`），用户想给支持 `max` 的 `global:deepseek-v4.1-flash` 选 `max` 都选不到（实测反馈）；显式选择由用户负责，风险写进提示与 `title` | verify E39–E47 / F29–F44 |
| 推荐值必须**预选**在下拉里，且预选要算进「有改动」；写回后要采纳返回值里的 `reasoning`；明确选过「不设置」要把 `null` 草稿留住 | 预选不算改动 ⇒ 保存按钮灰着，这个值**永远写不进去**（真机上卡住的就是这一步：下拉显示「不设置」、按钮点不动）；写回不采纳返回值 ⇒ 刚存完又被预选顶回来、按钮一直亮着；unset 后丢掉草稿同理 | verify F42–F53 / M27–M29 |
| `routeDraft` 这个 `useState` 必须和其它 hook 排在一起（所有提前 `return null` 之前） | 挂在守卫分支之后时，命中守卫（命名空间不匹配 / 非手写路由没有模型）就少一个 hook，React 直接抛错、整棵树降级成一行"面板加载失败"——写这个控件时就真踩了一次 | verify G14 / G16 |
| 文案硬编码中文、**不注册 locale 命名空间** | 有意少一个失败面 | 约定 |
| 视觉只用 `--dsw-alias-*` token，不裸写颜色（`var()` 兜底值可以） | 亮暗主题都要成立 | 人工 + 人工复核 |

**不要顺手做的重构**：不加依赖、不引入构建/打包工具、不把 `lib/client.js` 拆成多文件（它必须是一个
classic script，不是 ESM）、不改有意的硬编码。

## 4. 包清单契约

`dsh-client-modules` 的投递链路：扫「已启用的 Loader 条目」→ 从该条目的模块位置向上找最近的
`package.json` → 读 `dsh.client`（`platform` 必须为 `"web"`）→ 从 `exports["./client"]` 定位浏览器
bundle → Host 在 `/plugins` 下发布并写进浏览器 boot graph。

因此 `package.json` 里这几项是契约，不是风格：

- `name`：非作用域裸包名（`^[^/@:]+$`，verify A1）——带 `@scope/` 会导致投递失败。
- `exports["./client"]`：指向浏览器 bundle 的字符串。
- `exports["./package.json"]`：`"./package.json"`（投递链路要读清单本身）。
- `dsh.client.platform`：`"web"`。

## 5. 改动流程（做完算数才算完）

1. 改代码（`lib/client.js` 用临时文件 + 原子替换写）。
2. **跑自检**：

   ```powershell
   node tools/verify.mjs
   # 接线也一并校验（H9/H10）：
   node tools/verify.mjs --patch "C:\Users\admin\.dsh\profiles\desktop\cordis.patch.yml"
   ```

3. **必须看到 `全部通过 ✓` 且退出码 0**。失败时会打印 `失败 N 项：` 并 `exit 1`。
4. **新加/改动的断言必须反向验证**（注入违规 → 看它变红 → 再还原）：

   ```powershell
   node tools/mutation-check.mjs
   ```

   必须看到 30 条全 `✓` + `反向验证全部命中 ✓`。**禁止**为了让自检变绿而放宽断言，也禁止用
   "看起来没问题"替代实际输出。
5. 只有第 3、4 步都过了才有资格说"改好了"。
6. 提交（第 7 节）。

## 6. 出问题时怎么恢复

| 症状 | 原因 | 恢复 |
|---|---|---|
| 设置页里"思考强度"整块不见了 | 条目被退役（2.1 / 2.3） | 重新保存一次 `lib/client.js`（内容不变也行，mtime/size 变了宿主就会发新 rev），或 `Ctrl+R`。不必重启 DSH |
| 界面上一直没有那块 UI（也不报错） | 2.2：`inject` 清单缺项，或座位 key 写错 | 用客户端 Inspect 看 `settings.models.provider-card` 的 occupants：应该有 `key: "llm-pi-ai"`。没有就是 `apply` 没跑到 |
| 想看到失败原因 | — | 看控制台 `[dsh-reasoning-setting]` 前缀的记录；`SeatBoundary` 的降级行里也带原文 |
| 没有长在模型行里（思考强度又回到卡片顶部整块） | 2.5：行内挂载退回了（官方 DOM 结构变了 / 拿不到 `react-dom` / 没有展开任何模型行 / 模型还没写进配置） | 这是设计好的回退，不是故障；看控制台的 `行内挂载失败` 警告定位原因，再对照官方包更新后的 DOM 结构 |
| 保存报"配置已在别处修改" | 2.4 的 revision 冲突 | 插件会自动重读；重新勾选再保存 |
| 想立刻回到官方界面 | — | 删掉 profile 里 `id: dsh-reasoning-setting` 那个 insert 行 |

## 7. 提交

- 提交信息用中文 Conventional Commits：`feat:` / `fix:` / `chore:` / `docs:`，一行说清改了什么。
- 远端：`origin` = `https://github.com/qq540491950/dsh-reasoning-setting`（**PUBLIC**，默认分支 `main`）。
  提交后 `git push origin main` 即可；不要改远端地址、不要 force push。
- **不要提交敏感信息**：profile 的 `cordis.patch.yml` 里有 API key / MCP token，它**不在本仓库内**，
  永远不要把它、或它的片段、或任何 token 复制进本仓库。仓库是**公开**的，推上去就抹不掉
  （撤不回的公开历史）——所以 commit 前必须查 `git status` 与待提交 diff。
- 提交前确认 `git status` 里没有意外文件。

## 8. 只碰自己那一行

profile 是**用户的环境**，不是本仓库的一部分：`C:\Users\admin\.dsh\profiles\desktop\cordis.patch.yml`。
在里面**只允许增删 `id: dsh-reasoning-setting` 这一个 insert 行**——其它条目的配置（模型、推理强度、
搜索 provider、MCP、密钥）都不属于本任务范围，不要"顺手"改。补丁层里新增条目必须用 `insert:` 追加，
裸写 `- id: ...` 会被当成覆盖目标，id 不存在时 Loader 报 `entry not found` 并丢弃该条。

改 profile 前先备份（`Copy-Item` 带时间戳后缀），改完用**真实 YAML 解析器**校验一次
（`C:\Users\admin\AppData\Local\Temp\dsh-asar-probe\out\dsh\node_modules\yaml`），并确认
`--patch` 自检仍然全绿。

## 9. 本机事实（会漂移，别当契约）

- 仓库路径：`D:\project\dsh-plugins\dsh-reasoning-setting`（profile 里的路径行依赖它）。
- 远端：`origin` → `https://github.com/qq540491950/dsh-reasoning-setting`（**PUBLIC**，默认分支 `main`）。
- profile 补丁：`C:\Users\admin\.dsh\profiles\desktop\cordis.patch.yml`；接线前备份
  `cordis.patch.yml.bak-1791779255424`。
- 只读的 DSH 源码副本（从 `app.asar` 解出）：
  `C:\Users\admin\AppData\Local\Temp\dsh-asar-probe\out\dsh\node_modules\@deepseek-ai\`。
- Node：v24.14.1（自检只需标准库）。
- 目标座位：`settings.models.provider-card`（keyed，key = `llm-pi-ai`）；
  声明者是官方 `@deepseek-ai/dsh-client-ui-settings-models` 的 `settings.section` 注册的 `children`。
- 写入落点：profile 的 `cordis.patch.yml` 里 `- id: llm-pi-ai` 那一行的 `config`。
- 相关官方包：`dsh-llm-pi-ai`（schema 与 `THINKING_LEVELS`）、`dsh-settings`（`mutate` 与 volatile 校验）、
  `dsh-config-editor`（YAML 外科手术 + 原子写入）、`dsh-api-settings-controller`（`remote.settings`）。

## 10. 真机验证到哪一步（诚实清单）

已经验证：

- **接线与投递已真机确认**：改完 profile 后，客户端 Inspect 的
  `settings.models.provider-card` occupants 出现 `{ registrant, key: "llm-pi-ai", priority: 0, active: true }`。
  这同时证明了 `inject` 清单（含 `remote.settings`）能解析——否则 `apply` 里的回调根本不会跑。
- **真机截图确认过这块 UI 渲染在 `cpa` 卡片里**（读到了 5 个模型、勾选状态与配置一致）。
- **真机落盘已逐字段核对**：用户在 GUI 里勾选并保存后，把当前 profile 与接线前的备份
  `cordis.patch.yml.bak-1791779255424` 对比：
  - `providers.cpa` 仍然只有 `apiKeyEnv / api / baseURL / reasoning / models` 五个字段；
  - 只有 `cn:step-5-preview` 多了 `reasoningEfforts: { off: null, low, medium, high, max }`
    （写出去的值与界面上勾的完全一致），其余 4 个模型**逐字节未变**；
  - 除新增的两条 `insert:` 行（本插件那条，以及用户自己接的 `dsh-skill-manager`）外，整份文档与备份深度相等
    ——没有把 schema 默认值物化进配置（这正是"数据源只用 user/base"守住的）；
  - 路由默认档位 `max` 在声明集合里，所以不会撞 `UNSUPPORTED_REASONING_EFFORT`。
- **真机确认过「保存确实落盘」**（2026-10-12 18:45）：用户在设置页保存后，`cordis.patch.yml` 里出现
  `providers.huawei.models[].reasoningEfforts`（`global:hy3`: low/high；`global:step-5-preview`:
  low/medium/high；`global:deepseek-v4.1-flash`: high/max）与 `providers.tengxun.models[].reasoningEfforts`
  （三个模型），其余条目逐字节未动。这次之后才补的"行内保存入口"与"默认档位下拉"属于**还没上真机**的部分。
- 离线自检 193/193（`--patch` 时 195/195）+ 30 项反向验证（M1–M30）全部命中。
- **用户明确要求后，直接改过一次 profile**（2026-10-12 20:17，破例，第 8 节默认禁止）：备份
  `cordis.patch.yml.bak-1791807420700`，在 `providers.huawei` 下外科式插入一行 `reasoning: high`
  （只多这一行，去掉它后整份文档与备份深度相等；`insert:` 分节与注释未动，仍是 LF），
  `--patch` 自检仍 195/195。**注意**：`reconcileProfilePatches` 只由 `dsh-config-editor` 的
  `settings.mutate` 调用，**没有任何文件监听器**——所以手改 `cordis.patch.yml` 必须**重启 DSH**
  才生效（Ctrl+R 不够，配置在宿主进程里）。

还没验证（改这块之前请先补上）：

- **行内挂载已在真机看到过一次**（用户截图：展开模型行后 `思考强度` 确实出现在 `输入类型` 下方），
  但那次同时暴露了两个问题，修完后**还没再上真机**：
  1. 模型行全部折叠时，兜底整块会连同 5 个模型的列表一起铺在卡片顶部（"看起来有两份设置"）——
     已改成「认得出模型行（`modelHeadersUnder`，折叠也算）就让位」，并且只在真机上验过旧行为；
  2. 勾选项尺寸/配色与官方不一致（官方 Checkbox 原语是 `gap:6px; 14px/20px` + `16×16` 勾选框 +
     `accent-color: brand-primary`），这次已**逐值照抄**官方 CSS 并跨满官方两列网格。
  需要复看的：展开/折叠各一遍都不出现第二份设置；8 个档位整齐 4+4；亮/暗主题下与官方观感一致；
  门户容器不干扰官方编辑器（增删模型行、获取可用模型、保存官方编辑都不报错）。
- **行内「保存到配置 / 放弃这一行」还没上真机**：这是本次修的坑（勾完看不到保存入口 ⇒ 以为"设置了
  却没生效"）。要复看的：展开一行勾一个档位后，勾选框下面立刻出现两个按钮、这行左边亮起告警色竖条；
  点行内保存后提示出现在这一行且勾选持久（重开配置页不还原）；点「放弃这一行」只清这一行、其它行不动；
  保存失败（冲突等）时原因也贴在这一行。门户里的子树在 vm 里渲染不出来，离线只静态守住这三条不变量
  （I16–I18）。
- **「默认档位」下拉**：它写路由级 `providers.<route>.reasoning`，下拉里列该路由**任一**模型声明过的
  档位（+「不设置」），并且**路由还没设过时直接预选共同档位里最高的那个**（预选保守，见第 3 节那一行）。
  要复看的：huawei 卡片的下拉里现在**能选到 `max`**（并集），打开时仍是预选的 `high`（三个模型的共同
  档位）；**不碰下拉、直接点一次「保存到配置」**，`cordis.patch.yml` 里就应出现
  `providers.huawei.reasoning: high` 且其余条目逐字节未动；显式选 `max` 再保存则写入 `max`——此时
  hy3 / step-5-preview 在"请求没带显式档位"时会被适配器拒（选择器切模型会带上显式档位，所以主要
  影响 `/model` 这类不带档位的切换）。之后切到该路由任一模型时选择器"默认"那一格显示该值；点
  「放弃改动」能把预选一起丢掉。**注意**：正因为预选算"有改动"，卡片一打开保存按钮就是亮的
  （有未保存的改动），这是设计如此，不是 bug。
- **"只在编辑态出现"的 CSS 判据还没在真机确认过**：机制是 `@supports selector(:has(*))` +
  `:is(li, div):has(> [data-slot="settings.models.provider-card"]):has(input:not([type="checkbox"])) .dsh-rs-box:not([data-inline="1"])`，
  依据是官方 `SlotOutlet` 把占用者包在 `div[data-slot]` 里（`display: contents`）、且官方编辑器必然
  渲染非 checkbox 输入（两条都读自官方源码，但没有在真机 DOM 上验过）。要确认的是：**卡片折叠时
  整块不可见、点「编辑」后出现**。若发现"一直不可见"，优先看 `:has()` 是否命中
  （`@supports` 守卫保证那时应退化为一直可见）。
- **只读 profile / `settings/conflict` 的真实触发路径没在真机演练过**（离线用假 ctx 覆盖）。
- **官方 `dsh-client-ui-settings-models` 升级后**：座位名、owner props（`provider.settingsNs` /
  `settingsPath` / `declared`）与 `remote.settings` 契约都要重新对照第 3 节的不变量。
