/**
 * 反向验证：往 lib/client.js 里注入违规，确认自检真的会红。
 *
 * 为什么要有它：`tools/verify.mjs` 全绿只证明"当前代码通过了断言"，不证明断言本身有护栏。
 * 每次注入都会在 finally 里原样还原；任何一次「注入后仍然全绿」都算那条断言没有护栏。
 *
 * 用法（在仓库根目录）：node tools/mutation-check.mjs
 */import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const clientPath = join(repo, 'lib', 'client.js')
const original = readFileSync(clientPath, 'utf8')

/** 每条注入：改什么、期望哪条断言命中。 */
const mutations = [
	{
		name: 'M1 写入路径不再是整段数组（多带一个数组下标）',
		from: '{ op: "set", path: [...settingsPath, "models"], value: models }',
		to: '{ op: "set", path: [...settingsPath, "models", "0"], value: models }',
		expect: 'F17',
	},
	{
		name: 'M2 没改过的模型也被复制成新对象',
		from: 'if (draft === undefined) return model;',
		to: 'if (draft === undefined) return { ...model };',
		expect: 'E20',
	},
	{
		name: 'M3 座位子树不再被边界包住',
		from: 'return react.createElement(SeatBoundary, null, react.createElement(Body, props));',
		to: 'return react.createElement(Body, props);',
		expect: 'G1',
	},
	{
		name: 'M4 inject 清单漏掉 remote.settings',
		from: 'ctx.inject(["slots", "remote", "remote.settings"], (scope) => {',
		to: 'ctx.inject(["slots", "remote"], (scope) => {',
		expect: 'D1',
	},
	{
		name: 'M5 off 不再写 null（改成写字符串）',
		from: 'out[level] = typeof wire === "string" && wire.length > 0 ? wire : null;',
		to: 'out[level] = "off";',
		expect: 'E12',
	},
	{
		name: 'M6 座位 key 写成路由名（收不到任何卡片）',
		from: 'const NAMESPACES = ["llm-pi-ai"];',
		to: 'const NAMESPACES = ["cpa"];',
		expect: 'D3',
	},
	{
		name: 'M7 数据源从 user 层换成解析后的生效值（会把默认值物化进配置）',
		from: 'const models = Array.isArray(stored) ? stored : Array.isArray(inherited) ? inherited : [];',
		to: 'const models = Array.isArray(getPath(descriptor.value, path)) ? getPath(descriptor.value, path) : [];',
		expect: 'F20',
	},
	{
		name: 'M8 不再默认隐藏（折叠态也会把面板铺出来）',
		from: '.dsh-rs-box { display: none; }',
		to: '.dsh-rs-box { display: flex; }',
		expect: 'H8c',
	},
	{
		name: 'M9 可见性判据丢掉官方 slot 锚点',
		from: ':has(> [data-slot="settings.models.provider-card"])',
		to: ':has(> .dsh-rs-box)',
		expect: 'H8d',
	},
	{
		name: 'M10 行内容器不再插在「输入类型」正下方（挪到展开体外）',
		from: 'if (!insertAfter(row.fieldset, holder)) continue;',
		to: 'if (!insertAfter(row.body, holder)) continue;',
		expect: 'I4',
	},
	{
		name: 'M11 行内容器不再按模型 id 过滤（DOM 里的草稿行也会被挂上）',
		from: 'if (!known.has(row.id) || seen.has(row.id)) continue;',
		to: 'if (seen.has(row.id)) continue;',
		expect: 'I2',
	},
	{
		name: 'M12 取不到 react-dom 时不再降级（整个插件跟着崩）',
		from: 'function loadReactDom() {\n\t\t\ttry {\n\t\t\t\treturn require("react-dom");\n\t\t\t} catch (error) {\n\t\t\t\tif (typeof console !== "undefined" && typeof console.warn === "function") {\n\t\t\t\t\tconsole.warn("[dsh-reasoning-setting] 取不到 react-dom，行内挂载关闭（退回卡片面板块）：", error);\n\t\t\t\t}\n\t\t\t\treturn undefined;\n\t\t\t}\n\t\t}',
		to: 'function loadReactDom() {\n\t\t\treturn require("react-dom");\n\t\t}',
		expect: 'I0',
	},
	{
		name: 'M13 让位条件退回「必须已挂上行内容器」（折叠态又会铺出整块兜底）',
		from: 'const inlineActive = reactDom !== undefined && attachment.bar !== undefined;',
		to: 'const inlineActive = reactDom !== undefined && attachment.rows.length > 0;',
		expect: 'H8j',
	},
	{
		name: 'M14 结构判定只看展开体（折叠态被误判成"官方结构变了"，又铺出整块）',
		from: 'if (modelHeadersUnder(card, models).length === 0) return EMPTY_ATTACH;',
		to: 'if (modelRowsUnder(card).length === 0) return EMPTY_ATTACH;',
		expect: 'I14',
	},
	{
		name: 'M15 行内容器不再跨列（只剩半宽，八个勾选框被挤成参差多行）',
		from: '.dsh-rs-inline-host { grid-column: 1 / -1; }',
		to: '.dsh-rs-inline-host { grid-column: auto; }',
		expect: 'H8l',
	},
	{
		name: 'M16 勾选框尺寸不再照抄官方（16px → 12px）',
		from: '\twidth: 16px;\n\theight: 16px;',
		to: '\twidth: 12px;\n\theight: 12px;',
		expect: 'H8m',
	},
	{
		name: 'M17 放弃一行时不再判断该键是否存在（没有该键也返回新对象）',
		from: 'if (!Object.prototype.hasOwnProperty.call(drafts, key)) return drafts;',
		to: 'if (false) return drafts;',
		expect: 'E33',
	},
	{
		name: 'M18 保存判据里「有校验问题」这一项失效（有问题的草稿也能点保存）',
		from: 'return writable !== true || busy === true || changed !== true || problems > 0;',
		to: 'return writable !== true || busy === true || changed !== true || problems > 99;',
		expect: 'E37',
	},
	{
		name: 'M19 行内不再渲染保存/放弃（又只剩卡片最底部那一个入口）',
		from: 'if (hasDraft) parts.push(inlineActionsOf(key));',
		to: 'if (false) parts.push(inlineActionsOf(key));',
		expect: 'I16',
	},
	{
		name: 'M20 行内保存按钮不再共用判据（改成"只读才禁用"）',
		from: 'disabled: saveDisabled(writable, busy, changed, problems.length),',
		to: 'disabled: !writable,',
		expect: 'I17',
	},
	{
		name: 'M21 行内不再贴出提示（保存失败的原因只有卡片底部看得到）',
		from: 'if (hasDraft && note !== undefined) parts.push(react.createElement("p", { className: "dsh-rs-note", key: "note" }, note));',
		to: 'if (false) parts.push(react.createElement("p", { className: "dsh-rs-note", key: "note" }, note));',
		expect: 'I18',
	},
	{
		name: 'M22 保存成功文案退回「随即生效」（把"声明"说成"已生效"）',
		from: 'setNote("已写入 profile 的 cordis.patch.yml：模型选择器里选一次档位，请求才会带上它");',
		to: 'setNote("已写入 profile 的 cordis.patch.yml（模型选择器随即生效）");',
		expect: 'F21',
	},
	{
		name: 'M23 路由默认档位改成取并集（只声明 max 的模型会把同路由其余模型全部打挂）',
		from: 'if (rows.every((model) => effortState(model).levels.includes(level))) return level;',
		to: 'if (rows.some((model) => effortState(model).levels.includes(level))) return level;',
		expect: 'E43',
	},
	{
		name: 'M24 路由默认档位不再跳过 off（off 当默认会让选择器显示「Off」而不是提供方默认）',
		from: 'if (level === "off") continue;',
		to: '',
		expect: 'E45',
	},
	{
		name: 'M25 路由默认档位不再参与「有改动」（只选它就按不了保存）',
		from: 'const changed = modelsChanged || routeChanged;',
		to: 'const changed = modelsChanged;',
		expect: 'F33',
	},
	{
		name: 'M26 「不设置」写成空串而不是 unset（空串会被 schema 拒绝）',
		from: '? { op: "unset", path: routeReasoningPath }',
		to: '? { op: "set", path: routeReasoningPath, value: "" }',
		expect: 'F40',
	},
]

let bad = 0
try {
	for (const mutation of mutations) {
		if (!original.includes(mutation.from)) {
			console.log(`? ${mutation.name} — 找不到注入点（自检与源码不同步）`)
			bad += 1
			continue
		}
		writeFileSync(clientPath, original.replace(mutation.from, mutation.to))
		const run = spawnSync(process.execPath, [join(repo, 'tools', 'verify.mjs')], { cwd: repo, encoding: 'utf8' })
		const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
		const caught = run.status === 1 && output.includes(mutation.expect)
		console.log(`${caught ? '✓' : '✗'} ${mutation.name} → 退出码 ${String(run.status)}，期望断言 ${mutation.expect}${caught ? ' 命中' : ' 未命中'}`)
		if (!caught) {
			bad += 1
			console.log(output.split('\n').slice(0, 6).map((line) => `      ${line}`).join('\n'))
		}
	}
} finally {
	writeFileSync(clientPath, original)
}

const restored = readFileSync(clientPath, 'utf8') === original
console.log(restored ? '已还原 lib/client.js ✓' : '还原失败 ✗')
if (!restored || bad > 0) {
	console.log(`反向验证失败 ${String(bad)} 项`)
	process.exit(1)
}
console.log('反向验证全部命中 ✓')
