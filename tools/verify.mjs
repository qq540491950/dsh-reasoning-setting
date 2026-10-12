/**
 * dsh-reasoning-setting 自检程序（纯 Node，零依赖）。
 *
 * 用 `node:vm` 跑**真实的** `lib/client.js`，喂一个够用的 React 替身与假 ctx，
 * 覆盖七组断言：
 *   A. 包清单契约（dsh.client.platform / exports["./client"] / 模块 id 与包名一致）
 *   B. 宿主半边（零 import、导出 apply）
 *   C. 客户端模块协议（只 require 种子模块、导出 apply 与内部钩子）
 *   D. 座位注册（inject 清单、keyed 座位的 key、每个命名空间注册一次）
 *   E. 纯逻辑（草稿推导、校验、数组改写、只动被改过的行）
 *   F. 读写端到端（渲染 → 勾选 → 保存 → 断言 mutate 载荷与写回后的视图）
 *   G. 降级与边界（座位边界不退役、只读、冲突、读取失败、命名空间不匹配、空模型）
 *   H. 文件卫生（LF / 无 BOM / 无 U+FFFD）与可选的 profile 接线校验
 *
 * 用法：
 *   node tools/verify.mjs
 *   node tools/verify.mjs --patch "C:\Users\admin\.dsh\profiles\desktop\cordis.patch.yml"
 *
 * 全部通过时打印 `全部通过 ✓` 并以 0 退出；否则打印 `失败 N 项：` 并以 1 退出。
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
const failures = []

/** 断言辅助。 */
function check(label, condition, detail = '') {
	if (condition) {
		passed += 1
		return
	}
	failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/** 断言相等（JSON 形状比较，够用）。 */
function checkSame(label, actual, expected) {
	check(label, JSON.stringify(actual) === JSON.stringify(expected), `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
}

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const hostSource = await readFile(join(root, 'lib', 'index.js'), 'utf8')
const clientSource = await readFile(join(root, 'lib', 'client.js'), 'utf8')

//#region 极简 React 替身（真的跑 hooks，能点击、能重渲染）

/**
 * 造一个够用的 React：函数组件真的被调用，useState/useEffect/useCallback 按
 * 「组件路径 + hook 序号」持久化，类组件支持 getDerivedStateFromError。
 */
function makeReact() {
	const slots = new Map()
	const classInstances = new Map()
	let path = []
	let hookIndex = 0
	let dirty = false

	const keyOf = (index) => `${path.join('/')}#${String(index)}`
	const readSlot = (index) => {
		const key = keyOf(index)
		if (!slots.has(key)) slots.set(key, {})
		return slots.get(key)
	}

	class Component {
		constructor(props) {
			this.props = props
		}
	}

	const createElement = (type, props, ...children) => {
		// 与 React 一致：children 同时进 props.children（类组件的 render 靠它拿到子树）。
		const nextProps = props === null || props === undefined ? {} : { ...props }
		if (children.length > 0) nextProps.children = children.length === 1 ? children[0] : children
		return { type, props: nextProps, children }
	}

	const useState = (initial) => {
		const slot = readSlot(hookIndex)
		hookIndex += 1
		if (!Object.prototype.hasOwnProperty.call(slot, 'value')) slot.value = initial
		const set = (next) => {
			const value = typeof next === 'function' ? next(slot.value) : next
			if (JSON.stringify(value) === JSON.stringify(slot.value)) return
			slot.value = value
			dirty = true
		}
		return [slot.value, set]
	}

	const useEffect = (callback, deps) => {
		const slot = readSlot(hookIndex)
		hookIndex += 1
		const key = JSON.stringify(deps === undefined ? null : deps)
		if (slot.deps === key) return
		slot.deps = key
		if (typeof slot.cleanup === 'function') slot.cleanup()
		const cleanup = callback()
		slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
	}

	const useCallback = (callback, deps) => {
		const slot = readSlot(hookIndex)
		hookIndex += 1
		const key = JSON.stringify(deps === undefined ? null : deps)
		if (slot.key !== key) {
			slot.key = key
			slot.fn = callback
		}
		return slot.fn
	}

	const useMemo = (factory, deps) => {
		const slot = readSlot(hookIndex)
		hookIndex += 1
		const key = JSON.stringify(deps === undefined ? null : deps)
		if (slot.key !== key) {
			slot.key = key
			slot.value = factory()
		}
		return slot.value
	}

	function render(node) {
		if (node === null || node === undefined || typeof node === 'boolean') return null
		if (typeof node === 'string' || typeof node === 'number') return { type: '#text', props: { text: String(node) }, children: [] }
		if (Array.isArray(node)) return node.map((child) => render(child)).filter((child) => child !== null)

		const type = node.type
		if (typeof type === 'function' && type.prototype !== undefined && typeof type.prototype.render === 'function') {
			const name = type.name === '' ? 'Anonymous' : type.name
			const instanceKey = [...path, name].join('/')
			let instance = classInstances.get(instanceKey)
			if (instance === undefined) {
				instance = new type(node.props)
				classInstances.set(instanceKey, instance)
			}
			instance.props = node.props
			const outer = path
			path = [...path, name]
			try {
				return render(instance.render())
			} catch (error) {
				const derive = type.getDerivedStateFromError
				if (typeof derive !== 'function') throw error
				instance.state = { ...instance.state, ...derive(error) }
				if (typeof instance.componentDidCatch === 'function') instance.componentDidCatch(error)
				return render(instance.render())
			} finally {
				path = outer
			}
		}

		if (typeof type === 'function') {
			const name = type.name === '' ? 'Anonymous' : type.name
			const outer = path
			const outerIndex = hookIndex
			path = [...path, name]
			hookIndex = 0
			try {
				return render(type(node.props))
			} finally {
				path = outer
				hookIndex = outerIndex
			}
		}

		return {
			type,
			props: node.props,
			children: (node.children ?? []).flat().map((child) => render(child)).filter((child) => child !== null),
		}
	}

	return {
		react: { createElement, Component, useState, useEffect, useCallback, useMemo, Fragment: Symbol.for('react.fragment') },
		render,
		markDirty: () => {
			dirty = true
		},
		isDirty: () => dirty,
		clearDirty: () => {
			dirty = false
		},
	}
}

/** 收集宿主元素。 */
function walk(node, out = []) {
	if (node === null || node === undefined) return out
	if (node.type === '#text') {
		out.push(node)
		return out
	}
	out.push(node)
	for (const child of node.children ?? []) walk(child, out)
	return out
}

const treeText = (node) => walk(node).filter((element) => element.type === '#text').map((element) => element.props.text).join(' ')
const byClass = (node, className) => walk(node).filter((element) => element.props !== undefined && element.props.className === className)
const buttons = (node) => walk(node).filter((element) => element.type === 'button')
const checkboxes = (node) => walk(node).filter((element) => element.type === 'input' && element.props.type === 'checkbox')
const buttonWithText = (node, text) => buttons(node).find((element) => (element.children ?? []).some((child) => child.type === '#text' && child.props.text === text))

/** 档位顺序（与 lib/client.js 的 LEVELS 一致），用来按名字取某一行的勾选框。 */
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
/** 取某一行里某个档位的勾选框。 */
const levelBox = (row, level) => checkboxes(row)[LEVELS.indexOf(level)]
/** 取某一行里某个档位的中文提示（勾选框的兄弟文本）。 */
const levelLabels = (row) => byClass(row, 'dsh-rs-level').map((element) => (element.children ?? []).filter((child) => child.type === '#text').map((child) => child.props.text).join(''))
const modelRows = (tree) => byClass(tree, 'dsh-rs-model')
/** 保存按钮；找不到时给一个空 props 的替身，让断言干净地失败。 */
const saveButton = (node) => buttonWithText(node, '保存到配置') ?? { props: {} }

//#endregion

//#region 假 ctx 与配置夹具

/** 一个模型条目。 */
const flashModel = {
	id: 'cn:deepseek-v4.1-flash',
	name: 'deepseek-v4.1-flash',
	contextWindow: 1000000,
	maxTokens: 393216,
	input: ['text', 'image'],
	reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
}
/** 截图里那个：手写路由下没有声明的模型。 */
const stepModel = {
	id: 'cn:step-5-preview',
	name: 'cn:step-5-preview',
	contextWindow: 1000000,
	maxTokens: 64000,
	input: ['text', 'image'],
}

const clone = (value) => JSON.parse(JSON.stringify(value))

/** 造一份 `settings/describe` 的返回值（RemoteResult 信封）。 */
function makeDescribeResult({ models = [flashModel, stepModel], writable = true, revision = 7, reasoning = 'max' } = {}) {
	const profile = (list) => ({
		apiKeyEnv: 'CPA_API_KEY',
		api: 'openai-completions',
		baseURL: 'http://gateway.example/v1',
		reasoning,
		models: clone(list),
	})
	// `value` 是**解析后**的生效值：schemastery 会把未写的字段填成默认值（例如 compat: {}）。
	// 我们的数据源必须是 user/base（原样），否则一次保存就把这些默认值物化进用户配置。
	const effective = { providers: { cpa: { ...profile(models), models: clone(models).map((model) => ({ ...model, compat: {} })) } } }
	return {
		ok: true,
		value: {
			writable,
			hasDocument: true,
			namespaces: [
				{
					autoGenerate: false,
					ns: 'llm-pi-ai',
					schema: {},
					value: effective,
					base: {},
					user: { providers: { cpa: profile(models) } },
					applies: 'live',
					secrets: [],
					revision,
				},
			],
		},
	}
}

/** 造一个座位 owner props。 */
function makeSeatProps({ settingsNs = 'llm-pi-ai', declared = true, settingsPath } = {}) {
	const provider = { provider: 'cpa', displayName: 'cpa', settingsNs, settingsPath: settingsPath ?? ['providers', 'cpa'], active: true, declared }
	return { provider, configured: true, keyConfigured: true }
}

/**
 * 装载浏览器半边并挂载座位组件。
 * @returns 工作台：树、操作日志、点击/等待/销毁。
 */
async function mount({ describeResults, mutate, seatProps, subscribes = true, onConsole } = {}) {
	const reactKit = makeReact()
	const registered = []
	const logs = { describe: 0, mutate: [], subscribes: 0, unsubscribes: 0, effects: [], console: [] }
	const queue = describeResults === undefined ? [makeDescribeResult()] : describeResults
	const sandbox = {
		window: { __ModuleLoader__: { load: (definition) => registered.push(definition) } },
		console: {
			error: (...args) => {
				logs.console.push(['error', args.map(String).join(' ')])
				if (onConsole !== undefined) onConsole('error', args)
			},
			warn: (...args) => {
				logs.console.push(['warn', args.map(String).join(' ')])
				if (onConsole !== undefined) onConsole('warn', args)
			},
			log: () => {},
		},
	}
	sandbox.globalThis = sandbox
	vm.runInNewContext(clientSource, sandbox, { filename: 'lib/client.js' })
	const definition = registered[0]
	const clientExports = definition.factory((specifier) => {
		if (specifier === 'react') return reactKit.react
		throw new Error(`unexpected require: ${specifier}`)
	})

	// 假 settings 服务：默认真的把 `set` op 应用进 user 层、递增 revision，并返回命名空间视图
	// （与 dsh-settings 的 applyPathOp + 返回新视图同语义），这样"保存 → 采纳 revision"是被真验的。
	const baseDescription = clone(queue[0])
	const namespacesOf = (result) => (result !== null && typeof result === 'object' && result.ok === true && result.value !== null && typeof result.value === 'object' && Array.isArray(result.value.namespaces) ? result.value.namespaces : [])
	const firstView = namespacesOf(baseDescription)[0]
	const service = firstView === undefined ? undefined : { user: clone(firstView.user), revision: typeof firstView.revision === 'number' ? firstView.revision : 0 }
	const describeNow = () => {
		if (queue.length > 1) return clone(queue.shift())
		const result = clone(baseDescription)
		if (service !== undefined) {
			const view = namespacesOf(result)[0]
			if (view !== undefined) {
				view.user = clone(service.user)
				view.revision = service.revision
			}
		}
		return result
	}
	const mutateNow = async (ns, ops, revision) => {
		logs.mutate.push({ ns, ops: clone(ops), revision })
		if (mutate !== undefined) return clone(await mutate(ns, ops, revision))
		for (const op of ops) {
			if (op.op !== 'set' || service === undefined) continue
			let node = service.user
			for (const key of op.path.slice(0, -1)) {
				if (node[key] === null || typeof node[key] !== 'object') node[key] = {}
				node = node[key]
			}
			node[op.path[op.path.length - 1]] = clone(op.value)
		}
		if (service !== undefined) service.revision += 1
		const result = clone(baseDescription)
		const view = namespacesOf(result)[0]
		if (view !== undefined && service !== undefined) {
			view.user = clone(service.user)
			view.revision = service.revision
		}
		return { ok: true, value: view }
	}

	const ctx = {
		effect(callback) {
			logs.effects.push(callback)
		},
		inject(names, callback) {
			logs.inject = names
			callback({
				remote: {
					settings: {
						describe: async () => {
							logs.describe += 1
							return describeNow()
						},
						mutate: async (ns, ops, revision) => mutateNow(ns, ops, revision),
					},
					$on: (event, handler) => {
						logs.subscribes += 1
						logs.event = event
						logs.handler = handler
						if (subscribes && typeof handler === 'function') void handler
						return () => {
							logs.unsubscribes += 1
						}
					},
				},
				slots: {
					inject: (name, callback) => {
						logs.seat = name
						callback()
					},
					register: (options, component) => {
						logs.registration = { options, component }
						return () => {}
					},
				},
			})
		},
	}

	clientExports.apply(ctx)
	const component = logs.registration === undefined ? undefined : logs.registration.component
	const props = seatProps === undefined ? makeSeatProps() : seatProps

	let tree = null
	const renderRoot = () => {
		reactKit.clearDirty()
		do {
			reactKit.clearDirty()
			tree = reactKit.render(reactKit.react.createElement(component, props))
		} while (reactKit.isDirty())
	}
	const tick = () => new Promise((resolveTick) => setTimeout(resolveTick, 0))
	const settle = async () => {
		for (let index = 0; index < 20; index += 1) {
			await tick()
			if (!reactKit.isDirty()) {
				if (index > 0) return
				continue
			}
			renderRoot()
		}
	}

	if (component !== undefined) {
		renderRoot()
		await settle()
	}

	return {
		react: reactKit.react,
		clientExports,
		definition,
		logs,
		props,
		get tree() {
			return tree
		},
		settle,
		rerender: async () => {
			renderRoot()
			await settle()
		},
		click: async (element) => {
			// 找不到元素时什么都不做：让下游断言干净地失败，而不是让自检崩在取属性的那一行。
			if (element === undefined || element === null) return
			element.props.onClick()
			renderRoot()
			await settle()
		},
		change: async (element) => {
			if (element === undefined || element === null) return
			element.props.onChange()
			renderRoot()
			await settle()
		},
	}
}

//#endregion

//#region A. 包清单契约

check('A1 包名是非作用域裸名', /^[^/@:]+$/.test(manifest.name), manifest.name)
check('A2 type=module', manifest.type === 'module', String(manifest.type))
check('A3 private', manifest.private === true, String(manifest.private))
check('A4 main 指向宿主半边', manifest.main === 'lib/index.js', String(manifest.main))
check('A5 exports["."] 指向宿主半边', manifest.exports?.['.'] === './lib/index.js', String(manifest.exports?.['.']))
check('A6 exports["./client"] 指向浏览器 bundle', manifest.exports?.['./client'] === './lib/client.js', String(manifest.exports?.['./client']))
check('A7 exports["./package.json"] 保留', manifest.exports?.['./package.json'] === './package.json', String(manifest.exports?.['./package.json']))
check('A8 dsh.client.platform = web', manifest.dsh?.client?.platform === 'web', String(manifest.dsh?.client?.platform))
checkSame('A9 peerDependencies 只有 cordis', Object.keys(manifest.peerDependencies ?? {}), ['@deepseek-ai/cordis'])

//#endregion

//#region B. 宿主半边

const host = await import(new URL('../lib/index.js', import.meta.url).href)
check('B1 宿主半边零 import', !/^\s*import\s/m.test(hostSource))
check('B2 导出 apply', typeof host.apply === 'function')
check('B3 apply 不抛错（空实现）', host.apply() === undefined)

//#endregion

//#region C. 客户端模块协议

{
	const registered = []
	const sandbox = { window: { __ModuleLoader__: { load: (definition) => registered.push(definition) } }, console }
	sandbox.globalThis = sandbox
	vm.runInNewContext(clientSource, sandbox, { filename: 'lib/client.js' })

	check('C1 注册了一个模块', registered.length === 1, String(registered.length))
	const definition = registered[0]
	check('C2 模块 id 等于包名', definition?.id === manifest.name, String(definition?.id))
	check('C3 factory 是函数', typeof definition?.factory === 'function')

	const requested = []
	const reactStub = { createElement: () => null, Component: class {}, useState: () => [undefined, () => {}], useEffect: () => {}, useCallback: (fn) => fn, useMemo: (fn) => fn() }
	const clientExports = definition.factory((specifier) => {
		requested.push(specifier)
		if (specifier === 'react') return reactStub
		throw new Error(`unexpected require: ${specifier}`)
	})
	checkSame('C4 只 require react', requested, ['react'])
	check('C5 导出 apply', typeof clientExports.apply === 'function')
	check('C6 导出内部钩子（给本自检用）', typeof clientExports.__test === 'object')
	check('C7 可枚举座位名', typeof clientExports.__test?.SEAT === 'string' && clientExports.__test.SEAT.length > 0)
}

//#endregion

//#region D. 座位注册

{
	const workbench = await mount({ componentless: true })
	checkSame('D1 inject 清单', workbench.logs.inject, ['slots', 'remote', 'remote.settings'])
	check('D2 注册进 settings.models.provider-card', workbench.logs.seat === 'settings.models.provider-card', String(workbench.logs.seat))
	checkSame('D3 keyed 座位的 key', workbench.logs.registration?.options, { name: 'settings.models.provider-card', key: 'llm-pi-ai' })
	check('D4 注册的是组件', typeof workbench.logs.registration?.component === 'function')
	check('D5 只注册一次（本机只有一个 pi-ai 命名空间）', workbench.logs.registration !== undefined)
}

//#endregion

//#region E. 纯逻辑

{
	const workbench = await mount({ componentless: true })
	const t = workbench.clientExports.__test

	checkSame('E1 七个档位与顺序', t.LEVELS, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
	checkSame('E2 字段名', t.FIELD, 'reasoningEfforts')

	checkSame('E3 缺省字段 → 继承', t.effortState({ id: 'm' }), { mode: 'inherit', levels: [] })
	checkSame('E4 false → 非推理', t.effortState({ id: 'm', reasoningEfforts: false }), { mode: 'none', levels: [] })
	checkSame('E5 null → 声明了但为空（非法，必须修）', t.effortState({ id: 'm', reasoningEfforts: null }), { mode: 'declare', levels: [] })
	checkSame('E6 空字典 → 声明了但为空', t.effortState({ id: 'm', reasoningEfforts: {} }), { mode: 'declare', levels: [] })
	checkSame('E7 字典 → 按升序列出勾选', t.effortState({ id: 'm', reasoningEfforts: { max: 'max', off: null, low: 'low' } }), { mode: 'declare', levels: ['off', 'low', 'max'] })
	checkSame('E8 数组 → 不当作字典', t.effortState({ id: 'm', reasoningEfforts: ['low'] }), { mode: 'declare', levels: [] })
	checkSame('E9 非对象模型 → 继承', t.effortState(undefined), { mode: 'inherit', levels: [] })

	check('E10 继承 → undefined（删字段）', t.effortsOf({ mode: 'inherit', levels: ['low'] }) === undefined)
	check('E11 非推理 → false', t.effortsOf({ mode: 'none', levels: [] }) === false)
	checkSame('E12 声明 → off 为 null、其余为档位名', t.effortsOf({ mode: 'declare', levels: ['off', 'low', 'max'] }), { off: null, low: 'low', max: 'max' })
	checkSame('E13 保留手写 wire 拼写', t.effortsOf({ mode: 'declare', levels: ['max'] }, { max: 'ultra' }), { max: 'ultra' })
	checkSame('E14 非 off 档位的 null 值被档位名修好', t.effortsOf({ mode: 'declare', levels: ['low'] }, { low: null }), { low: 'low' })
	checkSame('E15 空声明 → 空字典', t.effortsOf({ mode: 'declare', levels: [] }), {})

	check('E16 空声明不合法', typeof t.draftProblem({ mode: 'declare', levels: [] }) === 'string')
	check('E17 只勾 off 不合法', typeof t.draftProblem({ mode: 'declare', levels: ['off'] }) === 'string')
	check('E18 off + 思考档位合法', t.draftProblem({ mode: 'declare', levels: ['off', 'low'] }) === undefined)
	check('E19 继承/非推理无约束', t.draftProblem({ mode: 'inherit', levels: [] }) === undefined && t.draftProblem({ mode: 'none', levels: [] }) === undefined)

	{
		const models = [clone(flashModel), clone(stepModel)]
		const next = t.applyDrafts(models, { 'cn:step-5-preview': { mode: 'declare', levels: ['low', 'max'] } })
		check('E20 没改过的行是同一个对象（逐字节不动）', next[0] === models[0])
		checkSame('E21 改过的行写入字典', next[1].reasoningEfforts, { low: 'low', max: 'max' })
		check('E22 其它字段保留', next[1].contextWindow === 1000000 && next[1].maxTokens === 64000 && next[1].name === 'cn:step-5-preview')
		const cleared = t.applyDrafts(models, { 'cn:step-5-preview': { mode: 'inherit', levels: [] } })
		check('E23 继承 → 字段被删掉', !Object.prototype.hasOwnProperty.call(cleared[1], 'reasoningEfforts'))
		const none = t.applyDrafts(models, { 'cn:deepseek-v4.1-flash': { mode: 'none', levels: [] } })
		check('E24 非推理 → false', none[0].reasoningEfforts === false)
	}

	checkSame('E25 逐模型回报问题', t.collectProblems([clone(stepModel)], { 'cn:step-5-preview': { mode: 'declare', levels: [] } }).length, 1)
	checkSame('E26 无草稿无问题', t.collectProblems([clone(stepModel)], {}), [])
	checkSame('E27 写入 op 的路径', t.modelsOp(['providers', 'cpa'], []), { op: 'set', path: ['providers', 'cpa', 'models'], value: [] })
	checkSame('E28 getPath 正常', t.getPath({ a: { b: [{ c: 1 }] } }, ['a', 'b', '0', 'c']), 1)
	check('E29 getPath 缺一段 → undefined', t.getPath({ a: {} }, ['a', 'b', 'c']) === undefined)
	check('E30 getPath 穿非对象 → undefined', t.getPath({ a: 1 }, ['a', 'b']) === undefined)
}

//#endregion

//#region F. 读写端到端

{
	// 不传自定义 mutate：用默认的假 settings 服务（真的把 op 应用进 user 层并递增 revision），
	// 这样"读 → 勾 → 保存 → 采纳返回值里的 revision 与 user 子树"整条链路都被真验。
	const workbench = await mount({})
	const t = workbench.clientExports.__test

	check('F1 describe 被调用一次', workbench.logs.describe === 1, String(workbench.logs.describe))
	check('F2 订阅了 settings/document-updated', workbench.logs.event === 'settings/document-updated', String(workbench.logs.event))
	check('F3 渲染出标题', treeText(workbench.tree).includes('思考强度'))
	const rows = byClass(workbench.tree, 'dsh-rs-model')
	checkSame('F4 每个模型一段', rows.length, 2)
	check('F5 声明的模型列出全部 7 个档位（没声明的 minimal/xhigh 也能加）', checkboxes(rows[0]).length === 7, String(checkboxes(rows[0]).length))
	checkSame('F5b 勾选框标签按档位升序', levelLabels(rows[0]), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
	checkSame('F5c 勾选状态来自配置', levelLabels(rows[0]).filter((label, index) => checkboxes(rows[0])[index].props.checked === true), ['off', 'low', 'medium', 'high', 'max'])
	check('F7 未声明的模型没有勾选框（继承）', checkboxes(rows[1]).length === 0, String(checkboxes(rows[1]).length))
	check('F8 保存按钮初始禁用（没有改动）', saveButton(workbench.tree).props.disabled === true)

	// 把第二个模型切到「自定义」
	await workbench.click(buttonWithText(rows[1], '自定义'))
	const rows2 = byClass(workbench.tree, 'dsh-rs-model')
	check('F9 切到自定义后出现 7 个勾选框', checkboxes(rows2[1]).length === 7, String(checkboxes(rows2[1]).length))
	check('F10 空声明被拦下并给原因', treeText(workbench.tree).includes('至少勾选一个 off 之外的档位'))
	check('F11 空声明时保存禁用', saveButton(workbench.tree).props.disabled === true)

	// 勾上 low
	await workbench.change(levelBox(modelRows(workbench.tree)[1], 'low'))
	check('F12 勾选后保存可用', saveButton(workbench.tree).props.disabled === false)
	check('F13 提示路由默认档位没勾', treeText(workbench.tree).includes('该路由的默认档位是 max'))

	// 再勾上 max，提示消失
	await workbench.change(levelBox(modelRows(workbench.tree)[1], 'max'))
	check('F14 勾上默认档位后提示消失', !treeText(workbench.tree).includes('该路由的默认档位是 max'))

	await workbench.click(buttonWithText(workbench.tree, '保存到配置'))
	checkSame('F15 mutate 一次', workbench.logs.mutate.length, 1)
	const call = workbench.logs.mutate[0] ?? { ns: undefined, ops: [], revision: undefined }
	check('F16 命名空间是 llm-pi-ai', call.ns === 'llm-pi-ai', String(call.ns))
	checkSame('F17 载荷是整段数组的 set', call.ops.length === 1 && call.ops[0].op === 'set' && JSON.stringify(call.ops[0].path), JSON.stringify(['providers', 'cpa', 'models']))
	check('F18 带上 revision', call.revision === 7, String(call.revision))
	const written = call.ops[0] === undefined ? [] : call.ops[0].value
	checkSame('F19 只改被勾选的模型', (written[1] ?? {}).reasoningEfforts, { low: 'low', max: 'max' })
	checkSame('F20 没改过的模型逐字节不变', written[0], flashModel)
	check('F21 写回后提示成功', treeText(workbench.tree).includes('已写入 profile 的 cordis.patch.yml'))
	check('F23 写回后草稿清空（保存再次禁用）', saveButton(workbench.tree).props.disabled === true)
	check('F24 写回后勾选仍显示', checkboxes(byClass(workbench.tree, 'dsh-rs-model')[1]).filter((box) => box.props.checked === true).length === 2)

	// 继承：把第二个模型退回「继承」
	await workbench.click(buttonWithText(byClass(workbench.tree, 'dsh-rs-model')[1], '继承'))
	await workbench.click(buttonWithText(workbench.tree, '保存到配置'))
	const second = workbench.logs.mutate[1] ?? { ops: [] }
	checkSame('F25 继承写回时字段被删掉', second.ops[0] === undefined ? undefined : second.ops[0].value[1], stepModel)
	// 第一次写入返回的 revision 是 8：第二次写入必须用它，而不是继续用旧的 7（乐观并发的前提）。
	check('F25b 第二次写入用的是上次返回的 revision', second.revision === 8, String(second.revision))

	// 放弃改动
	await workbench.click(buttonWithText(workbench.tree, '非推理'))
	check('F26 有未保存改动时有提示', treeText(workbench.tree).includes('有未保存的勾选'))
	await workbench.click(buttonWithText(workbench.tree, '放弃改动'))
	check('F27 放弃后回到已保存状态', !treeText(workbench.tree).includes('有未保存的勾选') && saveButton(workbench.tree).props.disabled === true)
	checkSame('F28 __test 常量与代码一致', t.NAMESPACES, ['llm-pi-ai'])
}

//#endregion

//#region G. 降级与边界

{
	// G1 座位边界：渲染期抛错不冒泡（条目不会被退役）。没有边界时这个 mount 会整体抛出，
	// 所以这里用 try/catch 把「异常冒泡」变成一条断言失败，而不是让自检崩掉。
	const provider = { provider: 'cpa', settingsNs: 'llm-pi-ai', declared: true }
	Object.defineProperty(provider, 'settingsPath', {
		get() {
			throw new Error('boom')
		},
	})
	let boundary
	let escaped
	try {
		boundary = await mount({ seatProps: { provider, configured: true, keyConfigured: true } })
	} catch (error) {
		escaped = error
	}
	check('G1 渲染期抛错降级成一行提示（条目不被退役）', escaped === undefined && treeText(boundary.tree).includes('思考强度面板加载失败'), escaped === undefined ? '' : `异常冒泡到宿主：${String(escaped.message)}`)
	check('G2 降级时打了控制台记录', escaped === undefined && boundary.logs.console.some(([level]) => level === 'error'))
	check('G3 渲染整体没有失败（树还在）', escaped === undefined && boundary.tree !== null)
	check('G4 正常 props 不受影响', makeSeatProps().provider.settingsPath[0] === 'providers')
}

{
	// G5 只读
	const readonly = await mount({ describeResults: [makeDescribeResult({ writable: false })] })
	check('G5 只读时提示', treeText(readonly.tree).includes('当前 profile 配置只读'))
	check('G6 只读时保存禁用', saveButton(readonly.tree).props.disabled === true)
	check('G7 只读时勾选框禁用', checkboxes(readonly.tree).every((box) => box.props.disabled === true))
}

{
	// G8 冲突
	const conflict = await mount({
		mutate: async () => ({ ok: false, error: { code: 'settings/conflict', message: 'stale revision' } }),
	})
	await conflict.click(buttonWithText(modelRows(conflict.tree)[1], '自定义'))
	await conflict.change(levelBox(modelRows(conflict.tree)[1], 'low'))
	await conflict.click(buttonWithText(conflict.tree, '保存到配置'))
	check('G8 冲突时提示重新勾选', treeText(conflict.tree).includes('配置已在别处修改'))
	check('G9 冲突后重新读了一次配置', conflict.logs.describe === 2, String(conflict.logs.describe))
}

{
	// G10 被拒绝
	const refused = await mount({
		mutate: async () => ({ ok: false, error: { code: 'settings/rejected', message: 'nope' } }),
	})
	await refused.click(buttonWithText(modelRows(refused.tree)[1], '自定义'))
	await refused.change(levelBox(modelRows(refused.tree)[1], 'low'))
	await refused.click(buttonWithText(refused.tree, '保存到配置'))
	check('G10 被拒绝时给原因', treeText(refused.tree).includes('写入被拒绝：nope'))
	check('G11 被拒绝后草稿还在', treeText(refused.tree).includes('有未保存的勾选'))
}

{
	// G12 读取失败
	const broken = await mount({ describeResults: [{ ok: false, error: { code: 'settings/rejected', message: 'no provider' } }] })
	check('G12 读取失败时给原因', treeText(broken.tree).includes('读取配置失败：no provider'))
	check('G13 提供重试按钮', buttonWithText(broken.tree, '重试') !== undefined)
}

{
	// G14 命名空间不匹配（防御性：不该由别的命名空间分发到我们）
	const other = await mount({ seatProps: makeSeatProps({ settingsNs: 'llm-deepseek' }) })
	check('G14 命名空间不匹配时渲染 null', other.tree === null)
}

{
	// G15 手写路由还没有模型
	const empty = await mount({ describeResults: [makeDescribeResult({ models: [] })] })
	check('G15 手写路由没有模型时给出指引', treeText(empty.tree).includes('还没有写进配置的模型'))
}

{
	// G16 目录路由（非手写）没有模型覆盖时不渲染
	const catalog = await mount({ describeResults: [makeDescribeResult({ models: [] })], seatProps: makeSeatProps({ declared: false }) })
	check('G16 目录路由不渲染噪声', catalog.tree === null)
}

{
	// G17 订阅失败不影响读写
	const unsubscribed = await mount({
		describeResults: [makeDescribeResult()],
	})
	check('G17 订阅失败也不影响渲染', treeText(unsubscribed.tree).includes('思考强度'))
}

{
	// G18 继承层兜底：profile 覆盖层没有 models 时读继承层（与官方编辑器口径一致）
	const result = makeDescribeResult()
	delete result.value.namespaces[0].user.providers.cpa.models
	result.value.namespaces[0].base = { providers: { cpa: { models: [clone(stepModel)] } } }
	const inherited = await mount({ describeResults: [result] })
	check('G18 继承层的模型也显示出来', treeText(inherited.tree).includes('cn:step-5-preview'))
}

//#endregion

//#region H. 文件卫生与（可选）profile 接线

check('H1 client.js 无 CRLF', !clientSource.includes('\r'))
check('H2 client.js 无 BOM', !clientSource.startsWith('\uFEFF'))
check('H3 client.js 无 U+FFFD', !clientSource.includes('\uFFFD'))
check('H4 index.js 无 CRLF', !hostSource.includes('\r'))
check('H5 package.json 无 CRLF', !(await readFile(join(root, 'package.json'), 'utf8')).includes('\r'))
check('H6 浏览器半边是 classic script（不是 ESM）', !/^\s*(import|export)\s/m.test(clientSource))
check('H7 座位边界存在', clientSource.includes('class SeatBoundary') && clientSource.includes('getDerivedStateFromError'))
check('H8 注释里写清了为什么不遮蔽官方界面', clientSource.includes('settings.models.provider-card'))

{
	const patchIndex = process.argv.indexOf('--patch')
	if (patchIndex < 0) {
		console.log('（未提供 --patch，跳过 H9/H10 接线校验）')
	} else {
		const patchPath = resolve(process.argv[patchIndex + 1] ?? '')
		const patch = await readFile(patchPath, 'utf8')
		check('H9 patch 里有本插件的 insert 行', /-\s*insert:[\s\S]{0,400}?id:\s*dsh-reasoning-setting/.test(patch))
		const expected = `file:///${join(root, 'lib', 'index.js').replaceAll('\\', '/')}`
		check('H10 patch 里的路径指向本仓库', patch.includes(expected), expected)
	}
}

//#endregion

const total = passed + failures.length
if (failures.length === 0) {
	console.log(`全部通过 ✓（${String(passed)}/${String(total)}）`)
} else {
	console.log(`失败 ${String(failures.length)} 项：`)
	for (const failure of failures) console.log(`  ✗ ${failure}`)
	process.exit(1)
}
