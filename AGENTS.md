# AGENTS.md

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
| `lib/client.js` | 浏览器半边：全部 UI、读取与写入，`window.__ModuleLoader__` 懒 CJS bundle | **高**——第 2 节四条硬规则全在这里 |
| `lib/index.js` | 宿主半边：空的 `apply`，仅作为 Loader 的接线柱 | 低，但**不许删**：删了 `dsh-client-modules` 从该条目向上找不到 `package.json`，客户端 bundle 就不再投递 |
| `package.json` | 包清单契约（第 4 节） | 中——改错就整体不加载 |
| `tools/verify.mjs` | 离线自检：纯 Node、零依赖，用 `node:vm` 跑**真实的** `lib/client.js`（自带会真跑 hooks、能点击重渲染的 React 替身） | 低；改它必须同步改断言，**不许为了让它变绿而放宽断言** |
| `tools/mutation-check.mjs` | 反向验证：往 `lib/client.js` 注入 7 条违规，确认自检真的会红（护栏本身的自检） | 低；注入点跟着源码走，源码改了注入点找不到会报 `?` |
| `README.md` | 面向使用者的介绍与使用说明 | 低 |
| `AGENTS.md` | 本文件（工程约束） | 低 |

## 2. 四条硬规则

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
| 不许写空字典 `{}`、不写 `null`、不许只勾 `off` | 同上：空字典与 `null` 报 "empty reasoningEfforts"，只有 off 报 "offers no level beyond off" | verify E16 / E17 / F10/F11 |
| 读取优先 profile **user** 层，其次 **base**（继承）层；**不要**用 describe 的 `value`（解析后的生效值）当数据源 | `value` 已填好默认值，写回会把默认值物化；官方编辑器同样只用 `user`/`base`（其注释写明了这个坑） | verify G18 |
| `require` 只能取平台种子模块（本插件实际只用 `react`） | 种子表固化在 shell 里，取别的会 `require` 失败 | verify C4 |
| 宿主半边零 `import`、导出 `apply` | 它只当接线柱；多引入依赖就多一个失败面 | verify B1/B2 |
| 只注册 keyed 座位，**不要**加 `priority`、不要注册 `single` 座位 | keyed 座位的唯一性约束在 `(key, priority)`，重复注册直接抛错；`single` 才会遮蔽官方 UI，本插件不需要也没有抢位 | 约定 + verify D3 |
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

   必须看到 7 条全 `✓` + `反向验证全部命中 ✓`。**禁止**为了让自检变绿而放宽断言，也禁止用
   "看起来没问题"替代实际输出。
5. 只有第 3、4 步都过了才有资格说"改好了"。
6. 提交（第 7 节）。

## 6. 出问题时怎么恢复

| 症状 | 原因 | 恢复 |
|---|---|---|
| 设置页里"思考强度"整块不见了 | 条目被退役（2.1 / 2.3） | 重新保存一次 `lib/client.js`（内容不变也行，mtime/size 变了宿主就会发新 rev），或 `Ctrl+R`。不必重启 DSH |
| 界面上一直没有那块 UI（也不报错） | 2.2：`inject` 清单缺项，或座位 key 写错 | 用客户端 Inspect 看 `settings.models.provider-card` 的 occupants：应该有 `key: "llm-pi-ai"`。没有就是 `apply` 没跑到 |
| 想看到失败原因 | — | 看控制台 `[dsh-reasoning-setting]` 前缀的记录；`SeatBoundary` 的降级行里也带原文 |
| 保存报"配置已在别处修改" | 2.4 的 revision 冲突 | 插件会自动重读；重新勾选再保存 |
| 想立刻回到官方界面 | — | 删掉 profile 里 `id: dsh-reasoning-setting` 那个 insert 行 |

## 7. 提交

- 提交信息用中文 Conventional Commits：`feat:` / `fix:` / `chore:` / `docs:`，一行说清改了什么。
- 本仓库**没有 remote**（自用本地仓库）；不要自己加 remote、不要推送。
- **不要提交敏感信息**：profile 的 `cordis.patch.yml` 里有 API key / MCP token，它**不在本仓库内**，
  永远不要把它、或它的片段、或任何 token 复制进本仓库。
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
- 离线自检 111/111 + 7 项反向验证（M1–M7）全部命中。

还没验证（改这块之前请先补上）：

- **没在真机点过「保存到配置」**：离线侧证明的是 mutate 载荷形状、路径与 revision 传递；真机落盘结果
  要打开 profile 看 `- id: llm-pi-ai` 那一行里是否出现 `reasoningEfforts`（并且没多出别的东西）。
- **那块 UI 的实际视觉没在真机截图确认过**（间距、亮暗主题对比、与官方模型行的排布关系）。
- **只读 profile / `settings/conflict` 的真实触发路径没在真机演练过**（离线用假 ctx 覆盖）。
- **官方 `dsh-client-ui-settings-models` 升级后**：座位名、owner props（`provider.settingsNs` /
  `settingsPath` / `declared`）与 `remote.settings` 契约都要重新对照第 3 节的不变量。
