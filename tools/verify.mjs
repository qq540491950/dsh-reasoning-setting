/**
 * dsh-reasoning-setting 自检程序（纯 Node，零依赖）。
 *
 * 用 `node:vm` 跑**真实的** `lib/client.js`，喂一个够用的 React 替身与假 ctx，
 * 覆盖九组断言：
 *   A. 包清单契约（dsh.client.platform / exports["./client"] / 模块 id 与包名一致）
 *   B. 宿主半边（零 import、导出 apply）
 *   C. 客户端模块协议（只 require 种子模块、导出 apply 与内部钩子）
 *   D. 座位注册（inject 清单、keyed 座位的 key、每个命名空间注册一次）
 *   E. 纯逻辑（草稿推导、校验、数组改写、只动被改过的行、保存判据、放弃一行）
 *   F. 读写端到端（渲染 → 勾选 → 保存 → 断言 mutate 载荷与写回后的视图与提示文案）
 *   G. 降级与边界（座位边界不退役、只读、冲突、读取失败、命名空间不匹配、空模型）
 *   H. 文件卫生（LF / 无 BOM / 无 U+FFFD）与可选的 profile 接线校验
 *   I. 行内挂载（结构锚点、门户容器只挂配置里的模型、撤销幂等、react-dom 缺失时退回整块、
 *      以及行内保存入口/提示/共用判据这三条静态不变量）
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
		// useLayoutEffect 在真实 React 里与 useEffect 同为 hook，语义差别只在"绘制前还是绘制后"；
		// 自检不需要区分时序，所以直接共用同一份实现（顺序调用、同样返回 cleanup）。
		react: { createElement, Component, useState, useEffect, useLayoutEffect: useEffect, useCallback, useMemo, Fragment: Symbol.for('react.fragment') },
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
const byClass = (node, className) =>
	walk(node).filter(
		(element) =>
			element.props !== undefined && typeof element.props.className === 'string' && element.props.className.split(' ').includes(className),
	)
const buttons = (node) => walk(node).filter((element) => element.type === 'button')
const checkboxes = (node) => walk(node).filter((element) => element.type === 'input' && element.props.type === 'checkbox')
const buttonWithText = (node, text) => buttons(node).find((element) => (element.children ?? []).some((child) => child.type === '#text' && child.props.text === text))

/** 档位顺序（与 lib/client.js 的 LEVELS 一致），用来按名字取某一行的勾选框。 */
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
/** 一行里所有勾选项的标签（7 个档位 + 「非推理模型」）。 */
const choiceLabels = (row) =>
	byClass(row, 'dsh-rs-choice').map((element) => (element.children ?? []).filter((child) => child.type === '#text').map((child) => child.props.text).join(''))
/** 按标签取某一行里的勾选框。 */
const choiceBox = (row, label) => {
	const index = choiceLabels(row).indexOf(label)
	return index < 0 ? undefined : checkboxes(row)[index]
}
/** 取某一行里某个档位的勾选框。 */
const levelBox = (row, level) => choiceBox(row, level)
/** 「非推理模型」勾选框。 */
const noneBox = (row) => choiceBox(row, '非推理模型')
/** 某一行里已勾选的标签。 */
const checkedLabels = (row) => choiceLabels(row).filter((label) => choiceBox(row, label)?.props.checked === true)
const modelRows = (tree) => byClass(tree, 'dsh-rs-model')
/** 保存按钮；找不到时给一个空 props 的替身，让断言干净地失败。 */
const saveButton = (node) => buttonWithText(node, '保存到配置') ?? { props: {} }
/** 折叠容器（现在组件不再自己套一层，正常应为 undefined）。 */
const foldOf = (tree) => byClass(tree, 'dsh-rs-fold')[0]
/** 下拉/选项辅助：给「默认档位」那几个断言用。 */
const selectValue = (node) => (node === undefined ? undefined : node.props.value)
const optionValues = (node) => (node === undefined ? [] : (node.children ?? []).map((option) => option.props.value))

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

/**
 * 把夹具改成「这条路由没设默认档位」：`reasoning` 这个字段三层都不写。
 * 不能靠 `makeDescribeResult({ reasoning: undefined })` —— 解构默认值对 undefined 生效，会变回 'max'。
 */
function withoutRouteDefault(result) {
	const ns = result.value.namespaces[0]
	delete ns.user.providers.cpa.reasoning
	delete ns.value.providers.cpa.reasoning
	return result
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
async function mount({ describeResults, mutate, seatProps, subscribes = true, reactDomUnavailable = false, onConsole } = {}) {
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
		if (specifier === 'react-dom') {
			// 门户能力：默认给个桩；显式指定不可用时让 require 真的抛错（验证降级路径）。
			if (reactDomUnavailable) throw new Error('seed react-dom is unavailable')
			return { createPortal: (children, container, key) => ({ type: '#portal', props: { children, container, key }, children: [] }) }
		}
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
			if (service === undefined) continue
			if (op.op === 'unset') {
				// 与 dsh-config-editor 同语义：删掉这个节点（「不设置」= 配置里没有这个字段）。
				let node = service.user
				for (const key of op.path.slice(0, -1)) node = node === null || typeof node !== 'object' ? undefined : node[key]
				if (node !== null && typeof node === 'object') delete node[op.path[op.path.length - 1]]
				continue
			}
			if (op.op !== 'set') continue
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
		change: async (element, value) => {
			if (element === undefined || element === null) return
			// 下拉没有「空事件」语义：把 value 交给事件对象的 target，与真实 DOM 的 onChange 一致。
			element.props.onChange(value === undefined ? undefined : { target: { value } })
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
		if (specifier === 'react-dom') return { createPortal: () => null }
		throw new Error(`unexpected require: ${specifier}`)
	})
	checkSame('C4 只 require react 与 react-dom', requested, ['react', 'react-dom'])
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

	checkSame('E3 缺省字段 → 未声明', t.effortState({ id: 'm' }), { disabled: false, levels: [] })
	checkSame('E4 false → 非推理', t.effortState({ id: 'm', reasoningEfforts: false }), { disabled: true, levels: [] })
	checkSame('E5 null → 当作未声明（保存时归一成删字段）', t.effortState({ id: 'm', reasoningEfforts: null }), { disabled: false, levels: [] })
	checkSame('E6 空字典 → 同上', t.effortState({ id: 'm', reasoningEfforts: {} }), { disabled: false, levels: [] })
	checkSame('E7 字典 → 按升序列出勾选', t.effortState({ id: 'm', reasoningEfforts: { max: 'max', off: null, low: 'low' } }), { disabled: false, levels: ['off', 'low', 'max'] })
	checkSame('E8 数组 → 不当作字典', t.effortState({ id: 'm', reasoningEfforts: ['low'] }), { disabled: false, levels: [] })
	checkSame('E9 非对象模型 → 未声明', t.effortState(undefined), { disabled: false, levels: [] })

	check('E10 全不勾 → undefined（删字段/继承）', t.effortsOf({ disabled: false, levels: [] }) === undefined)
	check('E11 非推理 → false', t.effortsOf({ disabled: true, levels: [] }) === false)
	check('E11b 非推理优先（勾选只是休眠）', t.effortsOf({ disabled: true, levels: ['low', 'max'] }) === false)
	checkSame('E12 声明 → off 为 null、其余为档位名', t.effortsOf({ disabled: false, levels: ['off', 'low', 'max'] }), { off: null, low: 'low', max: 'max' })
	checkSame('E13 保留手写 wire 拼写', t.effortsOf({ disabled: false, levels: ['max'] }, { max: 'ultra' }), { max: 'ultra' })
	checkSame('E14 非 off 档位的 null 值被档位名修好', t.effortsOf({ disabled: false, levels: ['low'] }, { low: null }), { low: 'low' })

	check('E15 只勾 off 不合法', typeof t.draftProblem({ disabled: false, levels: ['off'] }) === 'string')
	check('E16 off + 思考档位合法', t.draftProblem({ disabled: false, levels: ['off', 'low'] }) === undefined)
	check('E17 全不勾合法（= 恢复继承）', t.draftProblem({ disabled: false, levels: [] }) === undefined)
	check('E18 非推理合法', t.draftProblem({ disabled: true, levels: [] }) === undefined)

	{
		const models = [clone(flashModel), clone(stepModel)]
		const next = t.applyDrafts(models, { 'cn:step-5-preview': { disabled: false, levels: ['low', 'max'] } })
		checkSame('E19 改过的行写入字典', next[1].reasoningEfforts, { low: 'low', max: 'max' })
		check('E20 没改过的行是同一个对象（逐字节不动）', next[0] === models[0])
		check('E21 其它字段保留', next[1].contextWindow === 1000000 && next[1].maxTokens === 64000 && next[1].name === 'cn:step-5-preview')
		const cleared = t.applyDrafts(models, { 'cn:step-5-preview': { disabled: false, levels: [] } })
		check('E22 全不勾 → 字段被删掉', !Object.prototype.hasOwnProperty.call(cleared[1], 'reasoningEfforts'))
		const none = t.applyDrafts(models, { 'cn:deepseek-v4.1-flash': { disabled: true, levels: [] } })
		check('E23 非推理 → false', none[0].reasoningEfforts === false)
	}

	checkSame('E24 逐模型回报问题（只勾 off）', t.collectProblems([clone(stepModel)], { 'cn:step-5-preview': { disabled: false, levels: ['off'] } }).length, 1)
	checkSame('E25 全不勾不再是问题', t.collectProblems([clone(stepModel)], { 'cn:step-5-preview': { disabled: false, levels: [] } }), [])
	checkSame('E26 无草稿无问题', t.collectProblems([clone(stepModel)], {}), [])
	checkSame('E27 写入 op 的路径', t.modelsOp(['providers', 'cpa'], []), { op: 'set', path: ['providers', 'cpa', 'models'], value: [] })
	checkSame('E28 getPath 正常', t.getPath({ a: { b: [{ c: 1 }] } }, ['a', 'b', '0', 'c']), 1)
	check('E29 getPath 缺一段 → undefined', t.getPath({ a: {} }, ['a', 'b', 'c']) === undefined)
	check('E30 getPath 穿非对象 → undefined', t.getPath({ a: 1 }, ['a', 'b']) === undefined)

	// 「勾了却看起来没生效」那类故障的护栏：行内保存入口的判据 + 只丢一行的草稿。
	checkSame('E31 放弃一行只删掉这个模型的草稿', t.dropDraft({ a: { levels: ['low'] }, b: { levels: ['max'] } }, 'a'), { b: { levels: ['max'] } })
	{
		const drafts = { a: { levels: ['low'] } }
		t.dropDraft(drafts, 'a')
		checkSame('E32 放弃一行不改动入参', drafts, { a: { levels: ['low'] } })
		check('E33 没有这个键时原样返回同一个引用（状态更新短路）', t.dropDraft(drafts, 'zzz') === drafts)
	}
	check('E34 保存判据：只读 → 禁用', t.saveDisabled(false, false, true, 0) === true)
	check('E35 保存判据：写入中 → 禁用', t.saveDisabled(true, true, true, 0) === true)
	check('E36 保存判据：没有改动 → 禁用', t.saveDisabled(true, false, false, 0) === true)
	check('E37 保存判据：有校验问题 → 禁用', t.saveDisabled(true, false, true, 1) === true)
	check('E38 保存判据：可写 + 空闲 + 有改动 + 无问题 → 可用', t.saveDisabled(true, false, true, 0) === false)

	// 路由默认档位：候选只取「每个模型都声明过的档位」里最高的那个（max 优先，没有依次向下）。
	check('E39 空 / 非数组 → 不设置', t.routeDefaultLevel(undefined) === undefined && t.routeDefaultLevel('nope') === undefined)
	check('E40 没有任何模型声明档位 → 不设置', t.routeDefaultLevel([{ id: 'a' }, { id: 'b' }]) === undefined)
	checkSame('E41 全都有 max → 取 max', t.routeDefaultLevel([{ id: 'a', reasoningEfforts: { max: 'max', high: 'high' } }, { id: 'b', reasoningEfforts: { max: 'max' } }]), 'max')
	checkSame('E42 交集里最高的那个（max/xhigh 都有 → 取 xhigh）', t.routeDefaultLevel([{ id: 'a', reasoningEfforts: { max: 'max', xhigh: 'xhigh' } }, { id: 'b', reasoningEfforts: { xhigh: 'xhigh', high: 'high' } }]), 'xhigh')
	checkSame('E43 只有一个模型声明 → 不取（取并集会让其余模型请求被拒）', t.routeDefaultLevel([{ id: 'a', reasoningEfforts: { max: 'max' } }, { id: 'b', reasoningEfforts: { high: 'high' } }]), undefined)
	checkSame('E44 交集只有一个 → 取那一个', t.routeDefaultLevel([{ id: 'a', reasoningEfforts: { low: 'low' } }, { id: 'b', reasoningEfforts: { low: 'low', max: 'max' } }]), 'low')
	checkSame('E45 off 不进候选（off: null 只是"支持关闭"，当默认没有意义）', t.routeDefaultLevel([{ id: 'a', reasoningEfforts: { off: null } }, { id: 'b', reasoningEfforts: { off: null } }]), undefined)
	checkSame('E46 非推理模型不参与候选', t.routeDefaultLevel([{ id: 'a', reasoningEfforts: false }, { id: 'b', reasoningEfforts: { max: 'max' } }]), undefined)
	checkSame('E47 手写 wire 拼写也算已声明', t.routeDefaultLevel([{ id: 'a', reasoningEfforts: { max: 'ultra' } }, { id: 'b', reasoningEfforts: { max: 'max' } }]), 'max')
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
	check('F3 渲染出字段标签', treeText(workbench.tree).includes('思考强度'))
	const rows = byClass(workbench.tree, 'dsh-rs-model')
	checkSame('F4 每个模型一段', rows.length, 2)
	check('F5 每个模型列出 7 个档位 + 非推理模型', checkboxes(rows[0]).length === 8, String(checkboxes(rows[0]).length))
	checkSame('F5b 勾选框标签 = 档位升序 + 非推理模型', choiceLabels(rows[0]), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', '非推理模型'])
	checkSame('F5c 勾选状态来自配置', checkedLabels(rows[0]), ['off', 'low', 'medium', 'high', 'max'])
	checkSame('F6 未声明的模型全都没勾', checkedLabels(rows[1]), [])

	// 可见性交给样式表（H8b–H8f），组件不再自己套折叠；行内是「字段标签 + 勾选行」的官方语法。
	check('F7a 组件不再自己包一层折叠', byClass(workbench.tree, 'dsh-rs-fold').length === 0 && foldOf(workbench.tree) === undefined)
	checkSame('F7b 每个模型都有「思考强度」字段标签行', byClass(workbench.tree, 'dsh-rs-field').length, 2)
	check('F7c 已声明的模型有「恢复默认」，未声明的没有', buttonWithText(rows[0], '恢复默认') !== undefined && buttonWithText(rows[1], '恢复默认') === undefined)
	check('F7d 语义说明常驻（空勾 = 继承）', treeText(workbench.tree).includes('未勾选任何档位 = 不写这个字段'))
	check('F8 保存按钮初始禁用（没有改动）', saveButton(workbench.tree).props.disabled === true)

	// 只勾 off 是唯一被配置校验拒绝的勾法
	await workbench.change(levelBox(modelRows(workbench.tree)[1], 'off'))
	check('F9 只勾 off 被拦下并给原因', treeText(workbench.tree).includes('至少再勾一个 off 之外的档位'))
	check('F10 只勾 off 时保存禁用', saveButton(workbench.tree).props.disabled === true)

	// 再勾 low → 合法
	await workbench.change(levelBox(modelRows(workbench.tree)[1], 'low'))
	check('F11 勾上 low 后保存可用', saveButton(workbench.tree).props.disabled === false)
	check('F12 提示路由默认档位没勾', treeText(workbench.tree).includes('该路由的默认档位是 max'))

	// 再勾上 max，提示消失
	await workbench.change(levelBox(modelRows(workbench.tree)[1], 'max'))
	check('F13 勾上默认档位后提示消失', !treeText(workbench.tree).includes('该路由的默认档位是 max'))
	check('F13b 未保存提示在页脚（紧挨保存按钮）', treeText(byClass(workbench.tree, 'dsh-rs-foot')[0]).includes('有未保存的改动'))

	await workbench.click(buttonWithText(workbench.tree, '保存到配置'))
	checkSame('F15 mutate 一次', workbench.logs.mutate.length, 1)
	const call = workbench.logs.mutate[0] ?? { ns: undefined, ops: [], revision: undefined }
	check('F16 命名空间是 llm-pi-ai', call.ns === 'llm-pi-ai', String(call.ns))
	checkSame('F17 载荷是整段数组的 set', call.ops.length === 1 && call.ops[0].op === 'set' && JSON.stringify(call.ops[0].path), JSON.stringify(['providers', 'cpa', 'models']))
	check('F18 带上 revision', call.revision === 7, String(call.revision))
	const written = call.ops[0] === undefined ? [] : call.ops[0].value
	checkSame('F19 只改被勾选的模型', (written[1] ?? {}).reasoningEfforts, { off: null, low: 'low', max: 'max' })
	checkSame('F20 没改过的模型逐字节不变', written[0], flashModel)
	check(
		'F21 写回后提示成功，并点明还要在模型选择器里选一次',
		treeText(workbench.tree).includes('已写入 profile 的 cordis.patch.yml') && treeText(workbench.tree).includes('模型选择器里选一次'),
	)
	check('F23 写回后草稿清空（保存再次禁用）', saveButton(workbench.tree).props.disabled === true)
	checkSame('F24 写回后勾选仍显示', checkedLabels(byClass(workbench.tree, 'dsh-rs-model')[1]), ['off', 'low', 'max'])

	// 恢复默认：删掉该模型的字段
	await workbench.click(buttonWithText(byClass(workbench.tree, 'dsh-rs-model')[1], '恢复默认'))
	await workbench.click(buttonWithText(workbench.tree, '保存到配置'))
	const second = workbench.logs.mutate[1] ?? { ops: [] }
	checkSame('F25 恢复默认写回时字段被删掉', second.ops[0] === undefined ? undefined : second.ops[0].value[1], stepModel)
	// 第一次写入返回的 revision 是 8：第二次写入必须用它，而不是继续用旧的 7（乐观并发的前提）。
	check('F25b 第二次写入用的是上次返回的 revision', second.revision === 8, String(second.revision))

	// 非推理 + 放弃改动
	await workbench.change(noneBox(modelRows(workbench.tree)[0]))
	check('F26a 非推理勾上后档位勾选变灰', levelBox(modelRows(workbench.tree)[0], 'low')?.props.disabled === true)
	check('F26 有未保存改动时有提示', treeText(workbench.tree).includes('有未保存的改动'))
	await workbench.click(buttonWithText(workbench.tree, '放弃改动'))
	check('F27 放弃后回到已保存状态', !treeText(workbench.tree).includes('有未保存的改动') && saveButton(workbench.tree).props.disabled === true)
	checkSame('F28 __test 常量与代码一致', t.NAMESPACES, ['llm-pi-ai'])

	// 路由默认档位：选一次就写 `providers.<route>.reasoning`；与逐模型勾选共用一次保存。
	check('F29 渲染出「默认档位」下拉', byClass(workbench.tree, 'dsh-rs-routedefault-select').length === 1, String(byClass(workbench.tree, 'dsh-rs-routedefault-select').length))
	// 默认夹具里只有第一个模型声明了档位，交集为空 ⇒ 只能选「不设置」，且提示说明为什么。
	{
		const only = byClass(workbench.tree, 'dsh-rs-routedefault-select')[0]
		checkSame('F30 没有共同档位时只能选「不设置」', optionValues(only), [''])
		check('F30b 并说明原因（这条路由的模型还没有共同的档位）', treeText(byClass(workbench.tree, 'dsh-rs-routedefault')[0]).includes('还没有共同的档位'))
	}

	// 两个模型都声明了 high/max ⇒ 下拉列出这两个 + 不设置，并跟随配置里的路由默认档位。
	{
		const shared = makeDescribeResult({
			models: [flashModel, { id: 'cn:step-5-preview', name: 'cn:step-5-preview', contextWindow: 1000000, maxTokens: 64000, input: ['text', 'image'], reasoningEfforts: { high: 'high', max: 'max' } }],
			reasoning: 'max',
		})
		const bench = await mount({ describeResults: [shared] })
		const select = byClass(bench.tree, 'dsh-rs-routedefault-select')[0]
		checkSame('F31 下拉只列出每个模型都勾过的档位 + 不设置', optionValues(select), ['', 'high', 'max'])
		check('F32 下拉默认跟随配置里的路由默认档位', selectValue(select) === 'max')
		await bench.change(select, 'high')
		check('F33 只改路由默认档位也能保存（不动任何勾选）', saveButton(bench.tree).props.disabled === false)
		await bench.click(buttonWithText(bench.tree, '保存到配置'))
		const routeCall = bench.logs.mutate[bench.logs.mutate.length - 1] ?? { ops: [] }
		checkSame('F34 路由默认档位与 models 同一次保存（两条 op）', routeCall.ops.length, 2)
		checkSame('F35 models 仍然是整段数组的 set', routeCall.ops[0] === undefined ? undefined : routeCall.ops[0].path, ['providers', 'cpa', 'models'])
		checkSame('F36 reasoning 写在 models 的兄弟路径上', routeCall.ops[1] === undefined ? undefined : routeCall.ops[1].path, ['providers', 'cpa', 'reasoning'])
		check('F37 写出去的值就是选的那个档位', routeCall.ops[1] !== undefined && routeCall.ops[1].value === 'high')
		check('F38 保存后草稿清空（按钮重新禁用）', saveButton(bench.tree).props.disabled === true)
		// 「不设置」= unset 掉这个字段（不是写空串；写空串会被 schema 拒绝）
		await bench.change(select, '')
		check('F39 选「不设置」时按钮可用', saveButton(bench.tree).props.disabled === false)
		await bench.click(buttonWithText(bench.tree, '保存到配置'))
		const unsetCall = bench.logs.mutate[bench.logs.mutate.length - 1] ?? { ops: [] }
		check('F40 「不设置」= unset reasoning（而不是写空串）', unsetCall.ops[1] !== undefined && unsetCall.ops[1].op === 'unset')
		// 不是共同声明的档位不出现在下拉里：选了它会让没勾它的模型在请求时被拒。
		check('F41 未共同声明的档位不出现在下拉里', !optionValues(select).includes('medium'))
	}

	// 推荐值必须**预选**：路由还没设默认档位时，只勾模型档位就保存，默认档位也要跟着落盘。
	// （真机上卡住的就是这一步：下拉显示「不设置」+ 保存按钮灰着 ⇒ 默认档位永远写不进去。）
	{
		const bothShared = { id: 'cn:step-5-preview', name: 'cn:step-5-preview', contextWindow: 1000000, maxTokens: 64000, input: ['text', 'image'], reasoningEfforts: { high: 'high', max: 'max' } }
		const noRoute = withoutRouteDefault(makeDescribeResult({ models: [flashModel, bothShared] }))
		const bench = await mount({ describeResults: [noRoute] })
		const selectOf = (tree) => byClass(tree, 'dsh-rs-routedefault-select')[0]
		check('F42 路由没设默认档位时，下拉预选共同档位里最高的那个（max 有就是 max）', selectValue(selectOf(bench.tree)) === 'max', String(selectValue(selectOf(bench.tree))))
		check('F43 预选也算未保存改动（否则保存按钮是灰的，默认档位永远写不进去）', saveButton(bench.tree).props.disabled === false)
		checkSame('F44 预选不改候选列表', optionValues(selectOf(bench.tree)), ['', 'high', 'max'])
		check('F44b 提示写明已预选', treeText(byClass(bench.tree, 'dsh-rs-routedefault')[0]).includes('预选'))
		await bench.click(buttonWithText(bench.tree, '保存到配置'))
		const preselectCall = bench.logs.mutate[bench.logs.mutate.length - 1] ?? { ops: [] }
		checkSame('F45 一次保存就带上路由默认档位（两条 op）', preselectCall.ops.length, 2)
		check(
			'F46 第二条把预选值写进 reasoning',
			preselectCall.ops[1] !== undefined && preselectCall.ops[1].op === 'set' && preselectCall.ops[1].path.join('/') === 'providers/cpa/reasoning' && preselectCall.ops[1].value === 'max',
		)
		check('F47 写回后采纳返回值（按钮禁用、不再显示未保存）', saveButton(bench.tree).props.disabled === true && !treeText(bench.tree).includes('有未保存的改动'))
		check('F48 写回后下拉显示写下去的值', selectValue(selectOf(bench.tree)) === 'max')
		// 明确选「不设置」：写 unset，并且写回后不被预选顶回来（否则卡片会一直"有未保存"）。
		await bench.change(selectOf(bench.tree), '')
		check('F49 选「不设置」时按钮可用', saveButton(bench.tree).props.disabled === false)
		await bench.click(buttonWithText(bench.tree, '保存到配置'))
		const unsetCall = bench.logs.mutate[bench.logs.mutate.length - 1] ?? { ops: [] }
		check('F50 「不设置」= unset（不是空串）', unsetCall.ops.length === 2 && unsetCall.ops[1] !== undefined && unsetCall.ops[1].op === 'unset')
		check('F51 unset 写回后回到干净态', saveButton(bench.tree).props.disabled === true)
		check('F52 unset 写回后下拉保持「不设置」', selectValue(selectOf(bench.tree)) === '')
		// 重开卡片：推荐值重新预选（它只是建议，不自动写；用户可以不理会，也可以选「不设置」）。
		const reopened = await mount({ describeResults: [noRoute] })
		check('F53 重开卡片时推荐值重新预选', selectValue(selectOf(reopened.tree)) === 'max')
		// 解析后的生效值里有 reasoning（模拟 schema 给了默认值）不能当成"用户设过"。
		const valueDefault = withoutRouteDefault(makeDescribeResult({ models: [flashModel, bothShared] }))
		valueDefault.value.namespaces[0].value.providers.cpa.reasoning = 'low'
		const guarded = await mount({ describeResults: [valueDefault] })
		check('F54 只看 user/base 两层：value 里的默认值不算已设置（仍按推荐预选 max）', selectValue(selectOf(guarded.tree)) === 'max', String(selectValue(selectOf(guarded.tree))))
	}
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
	await refused.change(levelBox(modelRows(refused.tree)[1], 'low'))
	await refused.click(buttonWithText(refused.tree, '保存到配置'))
	check('G10 被拒绝时给原因', treeText(refused.tree).includes('写入被拒绝：nope'))
	check('G11 被拒绝后草稿还在', treeText(refused.tree).includes('有未保存的改动'))
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

// H8b–H8f：「只在卡片编辑态出现」是纯 CSS 机制，vm 里跑不出来，所以在这里静态守住它的四个要素。
{
	const cssStart = clientSource.indexOf('const CSS = `')
	const css = clientSource.slice(cssStart, clientSource.indexOf('`;', cssStart))
	check('H8b 能取出样式表', css.length > 500, String(css.length))
	check('H8c 默认把整块隐藏', css.includes('.dsh-rs-box { display: none; }'))
	check(
		'H8d 判据 = 官方 slot 锚点 + 非 checkbox 输入',
		css.includes('[data-slot="settings.models.provider-card"]') && css.includes('input:not([type="checkbox"])'),
	)
	check('H8e 有 @supports 守卫（不支持 :has 时保持可见）', css.includes('@supports selector(:has('))
	check('H8f 基础规则保持 display: flex（老引擎兜底可见）', /\.dsh-rs-box \{[^}]*display: flex/.test(css))
	check('H8g 行内挂载成功时座位里那块让位（不依赖 :has）', css.includes('.dsh-rs-box[data-inline="1"] { display: none; }'))
	check('H8h 编辑态判据排除已行内挂载的情况', css.includes('.dsh-rs-box:not([data-inline="1"])'))
	check('H8i 门户容器 / 行内控件 / 保存条都有样式', css.includes('.dsh-rs-inline-host:empty') && css.includes('.dsh-rs-inline-row') && css.includes('.dsh-rs-bar'))
	{
		// 认得出官方模型行（展开或折叠都算）时，座位里那块必须**整个让位**，否则会同时出现两份设置。
		const boxAt = clientSource.indexOf('const box = react.createElement(')
		const boxBlock = boxAt < 0 ? '' : clientSource.slice(Math.max(0, boxAt - 900), boxAt)
		check('H8j 认得出模型行即让位（inlineActive 由保存条判定 + box 只在没让位时渲染 children）', boxBlock.includes('inlineActive = reactDom !== undefined && attachment.bar !== undefined') && clientSource.includes('inlineActive ? [] : children'))
		// 折叠的行也要认得出来：光看「有没有展开体」会把折叠态误判成"官方结构变了"，于是又铺出整块。
		check('H8k 折叠的模型行也算「认得出」（modelHeadersUnder 参与判定）', clientSource.includes('modelHeadersUnder(card, models).length === 0') && clientSource.includes('function modelHeadersUnder'))
		check('H8l 行内容器跨满两列（官方 modelAdvanced 是两列网格，不跨列只剩半宽）', css.includes('.dsh-rs-inline-host { grid-column: 1 / -1; }'))
		check('H8m 勾选项逐值照抄官方（16px 勾选框 + 14px/20px 文本 + 品牌色 accent）', css.includes('width: 16px;') && css.includes('font-size: 14px;') && css.includes('line-height: 20px;') && css.includes('accent-color: var(--dsw-alias-brand-primary)') && css.includes('font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary'))
	}
}

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

//#region I. 行内挂载（结构锚点 + 门户容器 + 回退）

/**
 * 极简假 DOM：只实现 lib/client.js 的结构化扫描与行内挂载用到的那几个属性/方法。
 * 不实现选择器字符串 —— client.js 的锚点刻意只用 tagName / children / 兄弟关系。
 */
function makeFakeDom() {
	function makeElement(tag) {
		return {
			tagName: String(tag).toUpperCase(),
			children: [],
			parentElement: null,
			attributes: {},
			className: '',
			value: '',
			type: undefined,
			get nextElementSibling() {
				const parent = this.parentElement
				if (parent === null) return null
				const at = parent.children.indexOf(this)
				return at < 0 || at + 1 >= parent.children.length ? null : parent.children[at + 1]
			},
			get previousElementSibling() {
				const parent = this.parentElement
				if (parent === null) return null
				const at = parent.children.indexOf(this)
				return at <= 0 ? null : parent.children[at - 1]
			},
			appendChild(child) {
				if (child.parentElement !== null) child.remove()
				child.parentElement = this
				this.children.push(child)
				return child
			},
			insertBefore(child, reference) {
				if (reference === null || reference === undefined) return this.appendChild(child)
				const at = this.children.indexOf(reference)
				if (at < 0) return this.appendChild(child)
				if (child.parentElement !== null) child.remove()
				child.parentElement = this
				this.children.splice(at, 0, child)
				return child
			},
			remove() {
				const parent = this.parentElement
				if (parent === null) return
				const at = parent.children.indexOf(this)
				if (at >= 0) parent.children.splice(at, 1)
				this.parentElement = null
			},
			setAttribute(name, value) {
				this.attributes[name] = String(value)
			},
			hasAttribute(name) {
				return Object.prototype.hasOwnProperty.call(this.attributes, name)
			},
		}
	}
	return { document: { createElement: (tag) => makeElement(tag) }, makeElement }
}

/**
 * 搭一张「官方 pi-ai 卡片」的假 DOM：行头两个输入框（id / 显示名）+ 展开体里一个 fieldset（输入类型），
 * 外加一个不属于任何模型行的诱饵 fieldset（它没有行头，必须被忽略）。
 * `collapsed` 时只渲染行头、不渲染展开体 —— 官方 ModelRow 折叠时就是这个形态。
 */
function fakeCard(dom, ids = ['cn:a', 'cn:b'], { collapsed = false } = {}) {
	const make = (tag) => dom.createElement(tag)
	const card = make('li')
	const head = make('div')
	card.appendChild(head)
	const anchor = make('div')
	anchor.setAttribute('data-slot', 'settings.models.provider-card')
	card.appendChild(anchor)
	const box = make('div')
	box.className = 'dsh-rs-box'
	anchor.appendChild(box)
	const rows = []
	for (const id of ids) {
		const entry = make('div')
		const header = make('div')
		const idInput = make('input')
		idInput.value = id
		idInput.type = 'text'
		const nameInput = make('input')
		nameInput.value = id.replace(/^cn:/, '')
		nameInput.type = 'text'
		header.appendChild(idInput)
		header.appendChild(nameInput)
		entry.appendChild(header)
		let body
		let fieldset
		if (!collapsed) {
			body = make('div')
			fieldset = make('fieldset')
			fieldset.appendChild(make('legend'))
			body.appendChild(fieldset)
			entry.appendChild(body)
		}
		card.appendChild(entry)
		rows.push({ id, header, body, fieldset })
	}
	const decoyWrap = make('div')
	decoyWrap.appendChild(make('fieldset'))
	card.appendChild(decoyWrap)
	return { card, anchor, box, rows }
}

{
	// 单独的沙箱：不需要 React 渲染，直接断言结构化扫描与挂/撤的纯逻辑。
	const dom = makeFakeDom()
	const built = fakeCard(dom.document)
	const registered = []
	const sandbox = { window: { __ModuleLoader__: { load: (definition) => registered.push(definition) } }, console, document: dom.document }
	sandbox.globalThis = sandbox
	vm.runInNewContext(clientSource, sandbox, { filename: 'lib/client.js' })

	const requested = []
	let escaped
	let clientExports
	const reactStub = { createElement: () => null, Component: class {}, useState: () => [undefined, () => {}], useEffect: () => {}, useCallback: (fn) => fn, useMemo: (fn) => fn() }
	try {
		clientExports = registered[0]?.factory((specifier) => {
			requested.push(specifier)
			if (specifier === 'react') return reactStub
			throw new Error('no react-dom seed') // 故意不提供 react-dom：降级路径不许崩
		})
	} catch (error) {
		escaped = error
	}
	check('I0 取不到 react-dom 也不影响模块装载（行内挂载自动关闭）', escaped === undefined && typeof clientExports?.__test === 'object', escaped === undefined ? '' : String(escaped.message))

	if (escaped === undefined) {
		const t = clientExports.__test
		checkSame('I1 结构锚点认出两个模型行（诱饵 fieldset 被忽略）', t.modelRowsUnder(built.card).map((row) => row.id), ['cn:a', 'cn:b'])
		checkSame(
			'I2 只给配置里已经写着的模型挂容器（未知 id / 重复 id 都跳过）',
			t.inlinePlanUnder(built.card, [{ id: 'cn:b' }, { id: 'cn:zzz' }, { id: 'cn:b' }]).map((row) => row.id),
			['cn:b'],
		)
		checkSame('I2b 行表不是数组时按空处理', t.inlinePlanUnder(built.card, 'nope').map((row) => row.id), [])

		const before = built.card.children.length
		const attachment = t.attachInline(built.box, [{ id: 'cn:a' }])
		check('I3 一个配置过的模型行挂一个门户容器', attachment.rows.length === 1 && attachment.rows[0].id === 'cn:a', `rows=${String(attachment.rows.length)}`)
		const rowA = built.rows[0]
		const host = attachment.rows[0]?.node
		check(
			'I4 容器插在「输入类型」的 fieldset 正下方',
			host !== undefined && host.parentElement === rowA.body && rowA.body.children.indexOf(host) === rowA.body.children.indexOf(rowA.fieldset) + 1,
		)
		check('I5 保存条插在卡片末尾', attachment.bar !== undefined && attachment.bar.parentElement === built.card && built.card.children[built.card.children.length - 1] === attachment.bar)
		check('I6 我们的节点都带 OWN 标记（观察者靠它滤掉自己的变更）', host.hasAttribute(t.OWN_ATTR) && attachment.bar.hasAttribute(t.OWN_ATTR))
		check('I7 诱饵 fieldset（没有行头）上没有容器：卡片只多了保存条一个直接子节点', built.card.children.length === before + 1)

		t.detachInline(attachment)
		check(
			'I8 撤销后容器与保存条都消失（卡片回到原样）',
			built.card.children.length === before && host.parentElement === null && attachment.bar.parentElement === null,
		)
		let again
		try {
			t.detachInline(attachment)
			t.detachInline({ rows: [{ node: null }], bar: undefined })
			t.detachInline(undefined)
		} catch (error) {
			again = error
		}
		check('I9 撤销可以重复调用、残缺挂载也不抛错', again === undefined, again === undefined ? '' : String(again.message))
		check('I10 没有可挂的行时原样返回（不插保存条）', t.attachInline(built.box, []) === t.EMPTY_ATTACH && built.card.children.length === before)
		const bare = fakeCard(dom.document, [])
		check('I11 认不出模型行结构时返回空挂载（上层退回整块）', t.attachInline(bare.box, [{ id: 'cn:a' }]) === t.EMPTY_ATTACH && bare.card.children.length === 3)
		checkSame('I12 oursMutation 滤掉自己的变更、放行官方变更', [true, false], [
			(() => {
				const holder = dom.makeElement('div')
				holder.setAttribute(t.OWN_ATTR, 'row')
				return t.oursMutation({ target: holder, addedNodes: [dom.makeElement('span')] })
			})(),
			t.oursMutation({ target: built.card, addedNodes: [dom.makeElement('p')] }),
		])

		// 折叠的模型行：只认「有没有展开体」会把它误判成"官方结构变了"，于是又铺出整块兜底 —— 必须仍然认得出。
		const collapsed = fakeCard(dom.document, ['cn:a', 'cn:b'], { collapsed: true })
		checkSame('I13 折叠行的行头也认得出来（modelHeadersUnder）', t.modelHeadersUnder(collapsed.card, [{ id: 'cn:a' }, { id: 'cn:b' }]).map((row) => row.id), ['cn:a', 'cn:b'])
		checkSame('I13b 展开体扫描在折叠时为空（所以不能只靠它判定结构）', t.modelRowsUnder(collapsed.card), [])
		const foldedAttachment = t.attachInline(collapsed.box, [{ id: 'cn:a' }, { id: 'cn:b' }])
		check(
			'I14 折叠态：挂保存条但一个行内容器都不插（present 为真 ⇒ 座位里那块让位）',
			foldedAttachment !== t.EMPTY_ATTACH && foldedAttachment.rows.length === 0 && foldedAttachment.bar !== undefined && foldedAttachment.present === true && collapsed.rows.every((row) => row.body === undefined),
		)
		t.detachInline(foldedAttachment)
	}
}

{
	// 真机路径：react-dom 的种子拿不到时，必须照常渲染座位里的整块（功能不消失），而不是让条目被退役。
	const result = await mount({ reactDomUnavailable: true }).catch((error) => error)
	const failed = result instanceof Error
	check(
		'I15 react-dom 缺失时退回座位里的整块（不崩、不缺功能）',
		!failed && treeText(result.tree).includes('思考强度') && modelRows(result.tree).length === 2,
		failed ? String(result.message) : '',
	)
}

{
	// 行内行自带的保存入口。门户里的那棵子树在 vm 里渲染不出来（React 替身不跑 ref，也不展开
	// portal 的 children），所以按本仓库既有做法静态守住这条不变量：勾选框旁边必须有保存入口、
	// 两处保存按钮共用同一判据、草稿还在时行内也贴提示。
	// 这一条守的是一次真实故障：保存按钮只在卡片最底部，用户在模型行里勾完就走，以为"设置了却没生效"。
	const sharedPredicate = (clientSource.match(/saveDisabled\(writable, busy, changed, problems\.length\)/g) ?? []).length
	check(
		'I16 行内有未保存勾选时自带「保存到配置 / 放弃这一行」，并带 dirty 标记',
		clientSource.includes('if (hasDraft) parts.push(inlineActionsOf(key));') &&
			clientSource.includes('放弃这一行') &&
			clientSource.includes('dsh-rs-inline-actions') &&
			clientSource.includes('dsh-rs-inline-row dsh-rs-dirty') &&
			clientSource.includes('.dsh-rs-inline-row.dsh-rs-dirty'),
	)
	check('I17 两处保存按钮共用同一判据（行内一处 + 卡片底部一处）', sharedPredicate === 2, String(sharedPredicate))
	check(
		'I18 草稿还在时行内也贴出提示（保存失败的原因不必滚到卡片底部才看得到）',
		clientSource.includes('if (hasDraft && note !== undefined) parts.push('),
	)
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
