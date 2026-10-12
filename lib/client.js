/**
 * 浏览器半边（Client half）：在「设置 → 模型」的提供商卡片里，为每个模型勾选思考强度。
 *
 * ## 为什么不遮蔽官方界面
 *
 * 官方 `@deepseek-ai/dsh-client-ui-settings-models` 在自己的 `settings.section`
 * 声明里放了一个 keyed 子座位：
 *
 *   renderSlot("settings.models.provider-card", { provider, configured, keyConfigured },
 *              { entryKey: row.entry.settingsNs })
 *
 * 它在每一张「展示目录行的卡片」内部渲染（已保存行的卡片、首次运行 setup 形态、
 * 以及「添加提供商」草稿卡），按 `settingsNs` 分发。所以我们只要以某个适配器家族的
 * settings 命名空间注册一次，就接管了那张卡片里的一块**新增**区域——不改官方任何
 * 代码、不抢 priority、卸载即消失。官方刻意不做这件事：推理等级是**按模型**的能力，
 * 同一 provider 下的模型各不相同，provider 级控件只会被设成某些模型拒绝的值。
 *
 * ## 挂载位置（两段式）
 *
 * 官方给的插入点是「卡片头之后、编辑器之前」，离模型行很远；而 `输入类型` 所在的展开体是官方组件
 * 硬编码的，没有座位可以插。所以这里做两段式：
 *
 *   1. **行内（正身）**：用 `react-dom` 的门户把每个模型的勾选组挂进**该模型行**展开体里 `输入类型`
 *      那个 `fieldset` 的正下方；`MutationObserver` 跟随展开/折叠/增删行；保存/放弃按钮挂在卡片末尾
 *      （官方编辑器页脚下方），**并且每一行有未保存勾选时，行内勾选框下面也会出现一份「保存到配置 /
 *      放弃这一行」**——保存条隔着整个官方编辑器，只有卡片底部那一个入口时，用户勾完就走、
 *      以为"设置了却没生效"（草稿只活在组件 state 里，重开配置页就还原）。
 *   2. **整块（仅兜底）**：**认不出官方模型行**时（拿不到 `react-dom`、官方改了行结构、
 *      卡片折叠着）才渲染在座位里，作为功能保底 —— 这种情况下不会同时出现两份设置，因为此时没有行内
 *      控件可看。保存条与行内控件共用同一份草稿，折叠所有行后保存入口仍在卡片底部。
 *
 * 行内挂载的锚点**只用结构**，不看 hashed class、也不认任何文案：展开体里唯一的 `fieldset` 就是
 * `输入类型`，它的父节点是展开体、展开体的前一个兄弟是行头（行头的前两个输入框是模型 id 与显示名）。
 * 对不上就一个都不插，自动退回整块。
 *
 * ## 数据面
 *
 * 读取：`ctx.remote.settings.describe()`（`@deepseek-ai/dsh-api-settings-controller`
 * 发布的 `settings` namespace）。每个 namespace 视图带 `value`（生效值）、
 * `base`（继承层）、`user`（profile 覆盖层）与 `revision`。
 *
 * 写入：`ctx.remote.settings.mutate(ns, ops, revision)`，ops 是
 * `[{ op: "set" | "unset", path: string[], value? }]` 的路径编辑，落到
 * `@deepseek-ai/dsh-settings`，最终由 `dsh-config-editor` 外科手术式写入 profile 的
 * `cordis.patch.yml` 并热重载。写入只带 revision，陈旧写入被拒（`settings/conflict`）。
 *
 * 字段：`llm-pi-ai` 的 `providers.<route>.models[i].reasoningEfforts`，
 * 值为 `false | { <level>: <wire> }`：
 *   - 缺省            → 继承该模型在已安装目录里的能力（手写路由等于没有）；
 *   - `false`         → 明确声明「非推理模型」；
 *   - `{ low: "low" }`→ 每个键是选择器提供的档位，值是分发时实际发送的拼写，
 *                       因此 `max: "ultra"` 可以为自有词汇的网关重命名档位。
 * 另外还能写路由级 `providers.<route>.reasoning`（默认档位）：切到这条路由的模型时，选择器
 * 「默认」那一格落在哪、以及请求没带显式档位时实际发送的值。它必须是**每个模型都声明过的**
 * 档位 —— 取并集会让没声明它的模型在请求时被拒（UNSUPPORTED_REASONING_EFFORT），所以 UI 的
 * 下拉只列共同档位，默认推荐"共同档位里最高的那个"（max 有就用 max，没有依次向下）。
 * 校验（`dsh-llm-pi-ai` 的 resolveModelReasoning）：空字典与 `null` 非法；
 * 除 `off` 外每个档位都必须有非空字符串值；必须至少声明一个 `off` 之外的档位。
 *
 * ## 硬规则
 *
 * keyed 座位是遮蔽型座位：条目抛错会被退役（要刷新页面才恢复）。所以
 *   - `inject` 工厂里只注册座位，不做任何可能抛错的事；
 *   - 座位子树被 `SeatBoundary` 包住，失败降级成一行提示，条目不被退役。
 */
window.__ModuleLoader__.load({
	id: "dsh-reasoning-setting",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");

		/**
		 * 取门户能力。种子模块表由 shell 固化（官方 `dsh-client-ui-renderer` 就在取 `react-dom`），
		 * 但拿不到时必须关掉行内挂载、退回座位里的整块，而不是让整个插件崩掉。
		 */
		function loadReactDom() {
			try {
				return require("react-dom");
			} catch (error) {
				if (typeof console !== "undefined" && typeof console.warn === "function") {
					console.warn("[dsh-reasoning-setting] 取不到 react-dom，行内挂载关闭（退回卡片面板块）：", error);
				}
				return undefined;
			}
		}

		//#region 常量

		/** 座位名（官方 `ui-settings-models` 声明）。 */
		const SEAT = "settings.models.provider-card";
		/**
		 * 注册用的 key = 提供商的 settings 命名空间（= Loader 条目 id，见
		 * `dsh-llm-pi-ai` 的 `settingsNs = ctx.fiber.entry?.options.id`）。
		 * 加一个命名空间 = 加一项；`llm-deepseek` 家族的模型没有按模型的推理字段，
		 * 所以这里只列 pi-ai（自定义/第三方模型路由）。
		 */
		const NAMESPACES = ["llm-pi-ai"];
		/** `reasoningEfforts` 允许的键，升序（`dsh-llm-pi-ai` 的 THINKING_LEVELS）。 */
		const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
		/** 「非推理模型」勾选框的文案（对应 `reasoningEfforts: false`）。 */
		const NONE_LABEL = "非推理模型";
		const LEVEL_TITLES = {
			off: "off：关闭思考，不发送任何推理参数",
			minimal: "minimal：发送 minimal",
			low: "low：发送 low",
			medium: "medium：发送 medium",
			high: "high：发送 high",
			xhigh: "xhigh：发送 xhigh（必须显式声明才有）",
			max: "max：发送 max（必须显式声明才有）",
		};
		/** 模型条目里承载思考强度的字段名。 */
		const FIELD = "reasoningEfforts";
		const STYLE_ID = "dsh-reasoning-setting:styles";
		const PLUGIN = "dsh-reasoning-setting";

		const reactDom = loadReactDom();
		/** 我们自己插进 DOM 的节点的标记：用来把「自己造成的 childList 变更」滤掉，避免自触发重挂载。 */
		const OWN_ATTR = "data-dsh-rs-own";
		/** 官方模型行展开体里「输入类型」那一组的标签名 —— 唯一的结构锚点（不看 class、不认文案）。 */
		const FIELD_TAG = "FIELDSET";
		const INPUT_TAG = "INPUT";
		/** 空挂载：常量对象，靠引用相等避免无谓的重渲染。 */
		const EMPTY_ATTACH = { rows: [], bar: undefined, present: false };

		//#endregion

		//#region 纯逻辑（tools/verify.mjs 直接断言这一段）

		/** 读一层视图里的路径；任何一段缺失都返回 undefined。 */
		function getPath(source, path) {
			let node = source;
			for (const key of path) {
				if (node === null || typeof node !== "object") return undefined;
				node = node[key];
				if (node === undefined) return undefined;
			}
			return node;
		}

		/**
		 * 一个模型条目映射到界面上的状态：`disabled` = 明确声明非推理（写 `false`），
		 * `levels` = 勾选的档位（空 = 不写这个字段 / 恢复继承）。
		 */
		function effortState(model) {
			const value = model === null || typeof model !== "object" ? undefined : model[FIELD];
			if (value === false) return { disabled: true, levels: [] };
			if (value === null || typeof value !== "object" || Array.isArray(value)) return { disabled: false, levels: [] };
			return { disabled: false, levels: LEVELS.filter((level) => Object.prototype.hasOwnProperty.call(value, level)) };
		}

		/**
		 * 草稿 → 要写进配置的值。`undefined` 表示「删掉这个字段」（继承），
		 * `false` 表示非推理模型，字典则是勾选的档位。
		 * 已声明的自定义拼写（例如 `max: "ultra"`）在重新勾选时保留，不会被改成档位名。
		 */
		function effortsOf(draft, previous) {
			if (draft.disabled === true) return false;
			if (draft.levels.length === 0) return undefined;
			const prior = previous !== null && typeof previous === "object" && !Array.isArray(previous) ? previous : {};
			const out = {};
			for (const level of LEVELS) {
				if (!draft.levels.includes(level)) continue;
				const wire = prior[level];
				if (level === "off") {
					out[level] = typeof wire === "string" && wire.length > 0 ? wire : null;
					continue;
				}
				out[level] = typeof wire === "string" && wire.length > 0 ? wire : level;
			}
			return out;
		}

		/** 一份草稿能不能写；返回中文原因，或 undefined。全不勾是合法的（= 恢复继承）。 */
		function draftProblem(draft) {
			if (draft.disabled === true) return undefined;
			if (draft.levels.length > 0 && !draft.levels.some((level) => level !== "off")) {
				return "至少再勾一个 off 之外的档位（只勾 off 的字典会被配置校验拒绝；要表示非推理模型请勾「非推理模型」）";
			}
			return undefined;
		}

		/** 只对被改过的模型套用草稿；没改过的行原样保留（逐字节不动）。 */
		function applyDrafts(models, drafts) {
			return models.map((model) => {
				const key = String(model === null || typeof model !== "object" ? "" : model.id);
				const draft = Object.prototype.hasOwnProperty.call(drafts, key) ? drafts[key] : undefined;
				if (draft === undefined) return model;
				const next = effortsOf(draft, model === null || typeof model !== "object" ? undefined : model[FIELD]);
				const copy = { ...model };
				if (next === undefined) delete copy[FIELD];
				else copy[FIELD] = next;
				return copy;
			});
		}

		/** 逐模型检查待写入的草稿。 */
		function collectProblems(models, drafts) {
			const problems = [];
			for (const model of models) {
				const key = String(model === null || typeof model !== "object" ? "" : model.id);
				if (!Object.prototype.hasOwnProperty.call(drafts, key)) continue;
				const problem = draftProblem(drafts[key]);
				if (problem !== undefined) problems.push(`${key}：${problem}`);
			}
			return problems;
		}

		/**
		 * 保存按钮的禁用判据。整块（座位里那块）与行内（模型行里那份）**必须共用这一份** ——
		 * 判据一旦分叉，就会出现"看得见的按钮点不动、点得动的按钮看不见"这种最难查的坏法。
		 * @param writable - 当前 profile 是否可写。
		 * @param busy - 是否正在写入。
		 * @param changed - 待写入的数组与已保存的是否不同。
		 * @param problems - 待写入的草稿里有几项校验不通过。
		 * @returns 是否禁用。
		 */
		function saveDisabled(writable, busy, changed, problems) {
			return writable !== true || busy === true || changed !== true || problems > 0;
		}

		/**
		 * 只丢掉**一个模型**的草稿（行内「放弃这一行」用）。没有这个键时原样返回同一个引用，
		 * 让 React 的状态更新自然短路。
		 * @param drafts - 当前草稿表。
		 * @param key - 模型 id。
		 * @returns 新的草稿表（或原表）。
		 */
		function dropDraft(drafts, key) {
			if (!Object.prototype.hasOwnProperty.call(drafts, key)) return drafts;
			const next = { ...drafts };
			delete next[key];
			return next;
		}

		/**
		 * 路由默认档位该取的值：该路由**每一个模型都声明过的**档位里，从高到低的第一个
		 * （`max` 有就用 `max`，没有依次 `xhigh / high / medium / low / minimal`，一个都没有就不设）。
		 *
		 * 为什么必须"每一个模型都声明过"：路由默认档位是"请求没有显式档位时"的兜底，
		 * `resolveReasoningLevel(model, undefined ?? profile.reasoning)` 只要遇到不认这一档的模型
		 * 就直接抛 `UNSUPPORTED_REASONING_EFFORT`——所以取并集（比如"有模型声明 max 就写 max"）
		 * 会让同路由其余模型全部不可用。
		 *
		 * `off` 不进候选：写 `off` 与不写在派发上等价（都是不发推理参数），却要求每个模型都声明
		 * `off`，还会把选择器里的"默认"显示成 Off，比不设更难懂。
		 * @param models - 该路由在配置里的模型数组。
		 * @returns 候选档位，或 undefined（没有共同档位 / 没有任何模型声明档位）。
		 */
		function routeDefaultLevel(models) {
			const rows = Array.isArray(models) ? models : [];
			if (rows.length === 0) return undefined;
			for (const level of [...LEVELS].reverse()) {
				if (level === "off") continue;
				if (rows.every((model) => effortState(model).levels.includes(level))) return level;
			}
			return undefined;
		}

		/** `settings.mutate` 的一次路径编辑：整段数组换新（与官方编辑器同一种最小写法）。 */
		function modelsOp(settingsPath, models) {
			return { op: "set", path: [...settingsPath, "models"], value: models };
		}

		/** 错误 → 一行中文。 */
		function describeError(error) {
			if (error instanceof Error) return error.message;
			if (typeof error === "string") return error;
			try {
				return JSON.stringify(error);
			} catch (ignored) {
				return String(error);
			}
		}

		//#endregion

		//#region 行内挂载（只用结构锚点；对不上就退回座位里的整块）

		/** 元素子节点。`children` 是 HTMLCollection，展开成数组；不用选择器字符串（少一层脆弱面）。 */
		function childElementsOf(node) {
			const children = node === null || node === undefined ? undefined : node.children;
			if (children === undefined || children === null) return [];
			const out = [];
			for (const child of children) out.push(child);
			return out;
		}

		/** 标签名比较（大小写无关）。 */
		function isTag(node, tag) {
			return node !== null && node !== undefined && typeof node.tagName === "string" && node.tagName.toUpperCase() === tag;
		}

		/** 子树里的全部元素，深度优先。 */
		function allElementsOf(node, out) {
			const list = out === undefined ? [] : out;
			for (const child of childElementsOf(node)) {
				list.push(child);
				allElementsOf(child, list);
			}
			return list;
		}

		/** 是不是文本框（行头里的两个就是模型 id 与显示名）。 */
		function isTextInput(node) {
			if (!isTag(node, INPUT_TAG)) return false;
			const type = node.type;
			return type === undefined || type === null || type === "" || String(type).toLowerCase() === "text" || String(type).toLowerCase() === "search";
		}

		/** 一个容器里的**直接子**输入框里，第一个当文本框用的（行头的第一个就是模型 id）。 */
		function textInputOf(node) {
			for (const child of childElementsOf(node)) {
				if (isTextInput(child)) return child;
			}
			return undefined;
		}

		/**
		 * 卡片里所有「模型行」——不管它现在是展开还是折叠。官方 `ModelRow` 的行头始终渲染
		 * （id、名称两个文本框 + 两个图标按钮），折叠时只是后面没有展开体。判据：直接子节点里有
		 * 两个以上文本框，且第一个的值是**配置里已经写着的模型 id**。
		 * 认不出来就返回空表 —— 上层退回座位里的整块。
		 */
		function modelHeadersUnder(card, models) {
			const known = new Set();
			for (const model of Array.isArray(models) ? models : []) {
				if (model !== null && typeof model === "object" && typeof model.id === "string" && model.id.length > 0) known.add(model.id);
			}
			const headers = [];
			if (card === null || card === undefined || known.size === 0) return headers;
			for (const element of allElementsOf(card)) {
				const inputs = childElementsOf(element).filter(isTextInput);
				if (inputs.length < 2) continue;
				const value = inputs[0].value;
				const id = typeof value === "string" ? value.trim() : "";
				if (id.length === 0 || !known.has(id)) continue;
				headers.push({ id, element });
			}
			return headers;
		}

		/**
		 * 卡片里所有「模型行的展开体」。判据全是结构：
		 * `输入类型` 是展开体里唯一的 `fieldset`；展开体的前一个兄弟是行头；行头的第一个输入框是模型 id。
		 * 认不出来（官方改了结构）就返回空表 —— 上层自动退回座位里的整块。
		 */
		function modelRowsUnder(card) {
			const rows = [];
			if (card === null || card === undefined) return rows;
			for (const element of allElementsOf(card)) {
				if (!isTag(element, FIELD_TAG)) continue;
				const body = element.parentElement;
				const header = body === null || body === undefined ? undefined : body.previousElementSibling;
				const input = textInputOf(header);
				const value = input === undefined ? undefined : input.value;
				const id = typeof value === "string" ? value.trim() : "";
				if (id.length === 0) continue;
				rows.push({ id, fieldset: element, body });
			}
			return rows;
		}

		/** 官方 SlotOutlet 渲染的是 `div[data-slot]`，它的父节点就是这张卡片。 */
		function cardElementOf(boxNode) {
			const anchor = boxNode === null || boxNode === undefined ? undefined : boxNode.parentElement;
			const card = anchor === null || anchor === undefined ? undefined : anchor.parentElement;
			return card === null || card === undefined ? undefined : card;
		}

		/** 该挂容器的行：只认配置里已经写着的模型 id（官方行里可能还带着没保存的草稿）。 */
		function inlinePlanUnder(card, models) {
			const known = new Set();
			for (const model of Array.isArray(models) ? models : []) {
				if (model !== null && typeof model === "object" && typeof model.id === "string" && model.id.length > 0) known.add(model.id);
			}
			const plan = [];
			const seen = new Set();
			for (const row of modelRowsUnder(card)) {
				if (!known.has(row.id) || seen.has(row.id)) continue;
				seen.add(row.id);
				plan.push(row);
			}
			return plan;
		}

		/** 把节点插到参考节点后面 —— 这就是「输入类型下方」。 */
		function insertAfter(reference, node) {
			const parent = reference.parentElement;
			if (parent === null || parent === undefined) return false;
			try {
				const next = reference.nextElementSibling;
				parent.insertBefore(node, next === undefined ? null : next);
				return true;
			} catch (error) {
				return false;
			}
		}

		/**
		 * 行内挂载：每个模型行插一个门户容器（紧跟在 `输入类型` 后面），卡片末尾再插一个保存条容器。
		 * 只建容器、登记引用；内容由 React 门户渲染。一个容器都插不上就返回空挂载（上层退回整块）。
		 */
		function attachInline(boxNode, models) {
			if (typeof document === "undefined" || document === null || boxNode === null || boxNode === undefined) return EMPTY_ATTACH;
			const card = cardElementOf(boxNode);
			if (card === undefined) return EMPTY_ATTACH;
			// 认不出官方模型行（卡片折叠着、或官方改了行结构）⇒ 空挂载，上层渲染座位里的整块兜底。
			if (modelHeadersUnder(card, models).length === 0) return EMPTY_ATTACH;
			const attachment = { rows: [], bar: undefined, present: true };
			for (const row of inlinePlanUnder(card, models)) {
				const holder = document.createElement("div");
				holder.className = "dsh-rs-inline-host";
				holder.setAttribute(OWN_ATTR, "row");
				if (!insertAfter(row.fieldset, holder)) continue;
				attachment.rows.push({ id: row.id, node: holder });
			}
			// 保存条**只要认得出模型行就挂**：全部折叠时它仍要待命（勾选后的保存入口不能跟着行一起消失）。
			const bar = document.createElement("div");
			bar.className = "dsh-rs-bar";
			bar.setAttribute(OWN_ATTR, "bar");
			card.appendChild(bar);
			attachment.bar = bar;
			return attachment;
		}

		/** 撤掉行内挂载。节点可能已经被官方卸载带走，所以每一步都容忍失败、可以重复调用。 */
		function detachInline(attachment) {
			if (attachment === null || attachment === undefined) return;
			const nodes = [];
			if (Array.isArray(attachment.rows)) {
				for (const row of attachment.rows) nodes.push(row.node);
			}
			nodes.push(attachment.bar);
			for (const node of nodes) {
				if (node === null || node === undefined || typeof node.remove !== "function") continue;
				try {
					node.remove();
				} catch (error) {
					// 已经不在这棵树里了：忽略
				}
			}
		}

		/** 这个节点（或它的祖先）是不是我们自己插的。 */
		function ownsNode(node) {
			let current = node;
			while (current !== null && current !== undefined) {
				if (typeof current.hasAttribute === "function" && current.hasAttribute(OWN_ATTR)) return true;
				current = current.parentElement;
			}
			return false;
		}

		/** 一次 childList 变更是不是我们自己造成的 —— 是就滤掉，否则会自己把自己的容器反复重挂。 */
		function oursMutation(record) {
			if (record === null || record === undefined) return false;
			if (ownsNode(record.target)) return true;
			const nodes = [];
			const added = record.addedNodes;
			const removed = record.removedNodes;
			if (added !== null && added !== undefined) for (const node of added) nodes.push(node);
			if (removed !== null && removed !== undefined) for (const node of removed) nodes.push(node);
			if (nodes.length === 0) return false;
			return nodes.every((node) => ownsNode(node));
		}

		//#endregion

		//#region 样式

		const CSS = `
.dsh-rs-box {
	margin: 8px 0 0;
	padding: 10px 12px;
	border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.24));
	border-radius: var(--dsw-radius-md, 8px);
	background: var(--dsw-alias-bg-layer-2, transparent);
	display: flex;
	flex-direction: column;
	gap: 8px;
}
/* 整块只在卡片处于**编辑态**时出现。官方这句 renderSlot 在卡片折叠态也会渲染，而座位契约只给
   provider / configured / keyConfigured，拿不到"卡片是否在编辑"。判据取结构性的两个条件，都不
   依赖 hashed class：
     a) 官方 slot 锚点 div[data-slot]（渲染器明说这个锚点就是可寻址面）是某张卡片的直接子节点；
     b) 同一张卡片里出现了**非 checkbox** 的输入控件——官方编辑器/凭据输入的必然产物；我们自己
        的勾选框都是 checkbox，不会自我触发。
   :has() 不被支持时保持默认可见（宁多不少，不会把功能藏没）。 */
@supports selector(:has(*)) {
	.dsh-rs-box { display: none; }
	:is(li, div):has(> [data-slot="settings.models.provider-card"]):has(input:not([type="checkbox"])) .dsh-rs-box:not([data-inline="1"]) { display: flex; }
}
/* 行内挂载成功：座位里那块让位。这条不依赖 :has，老引擎下也不会和行内控件重复。 */
.dsh-rs-box[data-inline="1"] { display: none; }
/* 门户容器：内容到位之前是空的，别让空行占位。 */
.dsh-rs-inline-host:empty { display: none; }
/* 官方 modelAdvanced 是**两列网格**（上下文窗口 / 最大输出 token 数各占一列），而「输入类型」是用
   grid-column:1/-1 跨满两列的。我们的容器同样是它的直接子节点，不跨列就只拿到半宽 —— 八个勾选框会被
   挤成三行。非网格父级上这个属性无效、无副作用。 */
.dsh-rs-inline-host { grid-column: 1 / -1; }
.dsh-rs-inline-row { margin: 0; }
/* 有未保存勾选的行：左边一条告警色竖条 —— 与「未保存」小字一起，让"这行还没存"一眼可见
   （行内勾选与卡片底部保存条隔着整个官方编辑器，光靠小字很容易被忽略）。 */
.dsh-rs-inline-row.dsh-rs-dirty {
	border-left: 2px solid var(--dsw-alias-state-warn-primary);
	padding-left: 8px;
}
/* 行内的保存/放弃：贴在勾选框正下方。 */
.dsh-rs-inline-actions { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.dsh-rs-bar { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
/* 路由默认档位那一行：字段标签 + 下拉 + 一句说明（为什么下拉里只有共同档位）。 */
.dsh-rs-routedefault { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 2px; }
.dsh-rs-routedefault-field { display: inline-flex; align-items: center; gap: 6px; }
.dsh-rs-routedefault-select {
	font: inherit;
	font-size: 12px;
	line-height: 18px;
	color: var(--dsw-alias-label-primary);
	background: var(--dsw-alias-bg-layer-2, transparent);
	border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.24));
	border-radius: var(--dsw-radius-sm, 6px);
	padding: 2px 6px;
	cursor: pointer;
}
.dsh-rs-routedefault-select:disabled { opacity: 0.5; cursor: not-allowed; }
.dsh-rs-pending { font-size: 11px; color: var(--dsw-alias-state-warn-primary); }
.dsh-rs-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.dsh-rs-model { display: flex; flex-direction: column; gap: 6px; }
.dsh-rs-name {
	font-size: 12px;
	color: var(--dsw-alias-label-primary);
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	word-break: break-all;
}
/* 以下四条逐值照抄官方「输入类型」那一组（_3nPmjq_modelFieldLabel / _3nPmjq_modelInputChoices
   / _checkbox_1wz3s_1），不是目测：字段标签 12px/18px 三级色（官方 legend 另有 4px 下边距）；勾选行
   gap 16px、min-height 32px；单个勾选项 inline-flex + gap 6px + 14px/20px 主文本色；勾选框 16×16 + 品牌色。 */
.dsh-rs-field { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
.dsh-rs-fieldlabel { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dsh-rs-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
/* 官方勾选行是 flex+wrap：它那行只有「文本 / 图片」两项，所以永远一行。我们有八个档位，按官方尺寸一行
   约需 590px、可用宽度约 500px —— 折行是必然的。改成等宽网格，让它排成整齐的 4+4，而不是 7+1 参差。 */
.dsh-rs-choices { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); align-items: center; gap: 8px 16px; min-height: 32px; }
.dsh-rs-choice {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	font-size: 14px;
	line-height: 20px;
	color: var(--dsw-alias-label-primary);
	cursor: pointer;
}
.dsh-rs-choice input {
	box-sizing: border-box;
	flex: 0 0 auto;
	width: 16px;
	height: 16px;
	margin: 0;
	accent-color: var(--dsw-alias-brand-primary);
	cursor: inherit;
}
.dsh-rs-choice:has(input:disabled) { opacity: 0.5; cursor: not-allowed; }
.dsh-rs-none { color: var(--dsw-alias-label-primary); }
.dsh-rs-problem { margin: 0; font-size: 11px; color: var(--dsw-alias-state-error-primary); }
.dsh-rs-warn { margin: 0; font-size: 11px; color: var(--dsw-alias-state-warn-primary); }
.dsh-rs-foot { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dsh-rs-save {
	appearance: none;
	border: 1px solid var(--dsw-alias-brand-primary);
	border-radius: 6px;
	background: transparent;
	color: var(--dsw-alias-brand-primary);
	font-size: 11px;
	line-height: 1.5;
	padding: 3px 12px;
	cursor: pointer;
}
.dsh-rs-save:disabled { opacity: 0.5; cursor: not-allowed; }
/* 官方 linkButton（_3nPmjq_linkButton）：28px 高、0 10px 内边距、圆角、三级色、无下划线。 */
.dsh-rs-reset {
	appearance: none;
	box-sizing: border-box;
	display: inline-flex;
	align-items: center;
	height: 28px;
	padding: 0 10px;
	border: 0;
	border-radius: var(--dsw-radius-sm, 6px);
	background: transparent;
	color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
	font: inherit;
	font-size: 12px;
	line-height: 18px;
	cursor: pointer;
}
.dsh-rs-reset:disabled { opacity: 0.5; cursor: not-allowed; }
.dsh-rs-note { font-size: 11px; color: var(--dsw-alias-label-secondary); margin: 0; }
.dsh-rs-error { font-size: 11px; color: var(--dsw-alias-state-error-primary); margin: 0; }
`;

		/** 幂等的样式注入：已经存在就就地更新（HMR 后内容也会跟上）。 */
		function ensureStyles() {
			if (typeof document === "undefined") return;
			const existing = document.getElementById(STYLE_ID);
			if (existing !== null) {
				if (existing.textContent !== CSS) existing.textContent = CSS;
				return;
			}
			const element = document.createElement("style");
			element.id = STYLE_ID;
			element.textContent = CSS;
			document.head.appendChild(element);
		}

		//#endregion

		//#region 座位组件

		/** 座位边界：keyed 座位上的条目抛错会被退役，所以失败必须降级成一行提示。 */
		class SeatBoundary extends react.Component {
			constructor(props) {
				super(props);
				this.state = { failed: false, message: "" };
			}

			static getDerivedStateFromError(error) {
				return { failed: true, message: describeError(error) };
			}

			componentDidCatch(error) {
				if (typeof console !== "undefined" && typeof console.error === "function") {
					console.error(`[${PLUGIN}] 思考强度面板渲染失败（条目已降级，不会被退役）：`, error);
				}
			}

			render() {
				if (this.state.failed) {
					return react.createElement(
						"p",
						{ className: "dsh-rs-error" },
						`思考强度面板加载失败：${this.state.message}`,
					);
				}
				return this.props.children;
			}
		}

		/**
		 * 造一个座位组件：闭包持有注入得到的 ctx 与本卡片所属的 settings 命名空间。
		 * @param ctx - 注入了 slots / remote / remote.settings 的作用域。
		 * @param ns - 本插件注册时用的 settings 命名空间。
		 */
		function makeSection(ctx, ns) {
			/** 真正的座位体。 */
			function Body(props) {
				const seat = props !== null && typeof props === "object" ? props : {};
				const provider = seat.provider !== null && typeof seat.provider === "object" ? seat.provider : undefined;
				const route = provider !== undefined && typeof provider.provider === "string" ? provider.provider : undefined;
				const settingsPath = provider !== undefined && Array.isArray(provider.settingsPath) ? provider.settingsPath : undefined;
				const path = settingsPath === undefined ? undefined : [...settingsPath, "models"];
				const pathKey = path === undefined ? "" : path.join(".");

				const [view, setView] = react.useState({ status: "loading" });
				const [drafts, setDrafts] = react.useState({});
				const [note, setNote] = react.useState(undefined);
				const [busy, setBusy] = react.useState(false);

				const [boxNode, setBoxNode] = react.useState(null);
				const [attachment, setAttachment] = react.useState(EMPTY_ATTACH);
				/**
				 * 路由默认档位（`providers.<route>.reasoning`）的草稿。`undefined` = 跟随保存过的值，
				 * 字符串 = 用户这一次选的档位，`null` = 这次要 unset 掉。它和逐模型勾选**共用一次保存**
				 * （同一个按钮、同一批 ops）：`mutate` 的每条 op 都带 revision，分两次写反而更容易撞
				 * `settings/conflict`。
				 * 这个 hook 必须与其它 hook 排在一起（在所有提前 `return null` 之前）：挂在守卫分支
				 * 之后，命中守卫时就少一个 hook，整棵树会降级成一行动能错误。
				 */
				const [routeDraft, setRouteDraft] = react.useState(undefined);
				/**
				 * 座位节点的回调 ref。用回调而不是 useRef：拿到真实 DOM 才能往上找卡片、往下找模型行。
				 * 离线自检里没有 DOM，这条路径自然不跑（自检用假 DOM 直接断言纯函数）。
				 */
				const attachBox = react.useCallback((node) => {
					const next = node === undefined ? null : node;
					setBoxNode((current) => (current === next ? current : next));
				}, []);

				/** 读一次配置：优先 profile 覆盖层，其次继承层（与官方编辑器的取值口径一致）。 */
				const load = react.useCallback(async () => {
					if (path === undefined) return undefined;
					try {
						const answer = await ctx.remote.settings.describe();
						if (answer === null || typeof answer !== "object") throw new Error("settings/describe 没有返回结果");
						if (answer.ok !== true) throw new Error(answer.error !== undefined && answer.error !== null && typeof answer.error.message === "string" ? answer.error.message : "settings/describe 被拒绝");
						const namespaces = answer.value !== null && typeof answer.value === "object" && Array.isArray(answer.value.namespaces) ? answer.value.namespaces : [];
						const descriptor = namespaces.find((row) => row !== null && typeof row === "object" && row.ns === ns);
						if (descriptor === undefined) throw new Error(`设置命名空间 ${ns} 不可用`);
						const stored = getPath(descriptor.user, path);
						const inherited = getPath(descriptor.base, path);
						const models = Array.isArray(stored) ? stored : Array.isArray(inherited) ? inherited : [];
						// 路由级默认档位（`providers.<route>.reasoning`）。它决定模型选择器切过来时带的档位；
						// 若某个模型没有声明这一档，未显式选择档位的请求会被适配器拒（UNSUPPORTED_REASONING_EFFORT）。
						const routeDefault = getPath(descriptor.value, [...path.slice(0, -1), "reasoning"]);
						setView({
							status: "ready",
							writable: answer.value.writable === true,
							revision: typeof descriptor.revision === "number" ? descriptor.revision : undefined,
							models,
							fromUser: Array.isArray(stored),
							routeDefault: typeof routeDefault === "string" ? routeDefault : undefined,
						});
						return true;
					} catch (error) {
						setView({ status: "error", message: describeError(error) });
						return false;
					}
				}, [ns, pathKey]);

				react.useEffect(() => {
					let cancelled = false;
					let dispose;
					void load();
					try {
						dispose = ctx.remote.$on("settings/document-updated", () => {
							if (!cancelled) void load();
						});
					} catch (error) {
						// 订阅只是「别人改了配置也能跟上」的锦上添花；订阅不了不影响读写。
						if (typeof console !== "undefined" && typeof console.warn === "function") {
							console.warn(`[${PLUGIN}] 订阅 settings/document-updated 失败（忽略）：`, error);
						}
					}
					return () => {
						cancelled = true;
						if (typeof dispose === "function") dispose();
					};
				}, [load]);

				/**
				 * 行内挂载的对账循环：座位节点 → 卡片 → 每个模型行插一个门户容器 → 卡片末尾插保存条，
				 * 再用 MutationObserver 跟随官方展开/折叠/增删行。任何一步出问题都退回座位里的整块
				 * （setAttachment(EMPTY_ATTACH)），绝不抛出：keyed 座位上的条目抛错会被退役。
				 */
				// 布局期而不是普通 effect：挂载结果要在**绘制前**落到 DOM，否则开卡片会闪一下兜底整块。
				react.useLayoutEffect(() => {
					if (reactDom === undefined || typeof document === "undefined" || boxNode === null || view.status !== "ready" || path === undefined) {
						setAttachment((current) => (current === EMPTY_ATTACH ? current : EMPTY_ATTACH));
						return undefined;
					}
					const modelsNow = Array.isArray(view.models) ? view.models : [];
					let current = EMPTY_ATTACH;
					let scheduled = false;
					let disposed = false;
					const sync = () => {
						if (disposed) return;
						let next;
						try {
							detachInline(current);
							next = attachInline(boxNode, modelsNow);
						} catch (error) {
							next = EMPTY_ATTACH;
							if (typeof console !== "undefined" && typeof console.warn === "function") {
								console.warn(`[${PLUGIN}] 行内挂载失败，退回卡片面板块：`, error);
							}
						}
						current = next;
						setAttachment(next);
					};
					sync();
					const root = cardElementOf(boxNode);
					let observer;
					if (root !== undefined && typeof MutationObserver === "function") {
						observer = new MutationObserver((records) => {
							if (scheduled || disposed) return;
							let relevant = false;
							for (const record of records) {
								if (!oursMutation(record)) relevant = true;
							}
							if (!relevant) return;
							scheduled = true;
							const flush = () => {
								scheduled = false;
								sync();
							};
							if (typeof queueMicrotask === "function") queueMicrotask(flush);
							else setTimeout(flush, 0);
						});
						try {
							observer.observe(root, { childList: true, subtree: true });
						} catch (error) {
							observer = undefined;
						}
					}
					return () => {
						disposed = true;
						if (observer !== undefined) observer.disconnect();
						detachInline(current);
						current = EMPTY_ATTACH;
					};
				}, [boxNode, view, pathKey]);

				const models = view.status === "ready" && Array.isArray(view.models) ? view.models : [];
				/** 保存路由默认档位的路径：与 models 同一层的兄弟字段（`providers.<route>.reasoning`）。 */
				const routeReasoningPath = settingsPath === undefined ? undefined : [...settingsPath, "reasoning"];
				/** 该路由自动算出来的候选档位：每个模型都声明过的最高档；没有就是 undefined（= 不设置）。 */
				const routeSuggestion = routeDefaultLevel(models);
				/** 用户选一次路由默认档位；选「不设置」= unset 掉这个字段。 */
				const chooseRouteDraft = (value) => {
					setNote(undefined);
					setRouteDraft(value);
				};
				const nextModels = applyDrafts(models, drafts);
				const problems = collectProblems(models, drafts);
				const modelsChanged = view.status === "ready" && JSON.stringify(nextModels) !== JSON.stringify(models);
				// 路由默认档位也算改动：只选它不动任何勾选时，保存按钮也必须可用。
				const routeChanged = routeDraft !== undefined && routeDraft !== (view.routeDefault === undefined ? undefined : view.routeDefault);
				const changed = modelsChanged || routeChanged;
				const writable = view.status === "ready" && view.writable === true;

				/** 改一个模型的草稿。 */
				const setDraft = (key, updater) => {
					setDrafts((current) => {
						const model = models.find((row) => String(row === null || typeof row !== "object" ? "" : row.id) === key);
						const base = Object.prototype.hasOwnProperty.call(current, key) ? current[key] : effortState(model);
						return { ...current, [key]: updater(base) };
					});
				};

				/** 勾/去勾一个档位（勾了就表示"这是可推理模型"，因此自动取消「非推理模型」）。 */
				const toggleLevel = (key, level) => {
					setNote(undefined);
					setDraft(key, (base) => {
						const levels = base.levels.includes(level) ? base.levels.filter((item) => item !== level) : [...base.levels, level];
						return { disabled: false, levels: LEVELS.filter((item) => levels.includes(item)) };
					});
				};

				/** 「非推理模型」：写 `reasoningEfforts: false`。原有勾选保留成休眠状态，取消勾选即恢复。 */
				const toggleNone = (key) => {
					setNote(undefined);
					setDraft(key, (base) => ({ disabled: base.disabled !== true, levels: base.levels }));
				};

				/** 「恢复默认」：删掉这个字段，回到继承。 */
				const resetModel = (key) => {
					setNote(undefined);
					setDraft(key, () => ({ disabled: false, levels: [] }));
				};

				/** 「放弃这一行」：只丢掉这一个模型的草稿，其它行的未保存改动保留。 */
				const discardDraft = (key) => {
					setNote(undefined);
					setDrafts((current) => dropDraft(current, key));
				};

				/**
				 * 写入 profile 配置：逐模型勾选是**一个**数组 set（与官方编辑器同一种最小写法），
				 * 路由默认档位是同一层的兄弟字段，两条 op 共用一次 `mutate`。
				 */
				const save = async () => {					if (path === undefined || view.status !== "ready") return;
					const ops = [modelsOp(settingsPath, nextModels)];
					if (routeReasoningPath !== undefined && routeDraft !== undefined) {
						// 「不设置」= unset 掉这个字段（回到不写语义）；具体档位 = set。
						ops.push(routeDraft === null
							? { op: "unset", path: routeReasoningPath }
							: { op: "set", path: routeReasoningPath, value: routeDraft });
					}
					setBusy(true);
					setNote(undefined);
					try {
						const answer = await ctx.remote.settings.mutate(ns, ops, view.revision);
						if (answer === null || typeof answer !== "object") throw new Error("settings/mutate 没有返回结果");
						if (answer.ok !== true) {
							const code = answer.error !== undefined && answer.error !== null ? answer.error.code : undefined;
							const message = answer.error !== undefined && answer.error !== null && typeof answer.error.message === "string" ? answer.error.message : String(code);
							// 官方 Remote 把陈旧写入映射成 `settings/conflict`；兼容横线写法以防上游改名。
							const conflict = code === "settings/conflict" || code === "settings-conflict";
							setNote(conflict ? `配置已在别处修改，请重新勾选：${message}` : `写入被拒绝：${message}`);
							if (conflict) await load();
							return;
						}
						const stored = getPath(answer.value === null || typeof answer.value !== "object" ? undefined : answer.value.user, path);
						setView({
							status: "ready",
							writable: true,
							revision: answer.value !== null && typeof answer.value === "object" && typeof answer.value.revision === "number" ? answer.value.revision : view.revision,
							models: Array.isArray(stored) ? stored : nextModels,
							fromUser: true,
						});
						setDrafts({});
						setRouteDraft(undefined);
						setNote("已写入 profile 的 cordis.patch.yml：模型选择器里选一次档位，请求才会带上它");
					} catch (error) {
						setNote(`写入失败：${describeError(error)}`);
					} finally {
						setBusy(false);
					}
				};

				if (route === undefined || path === undefined) return null;
				if (provider.settingsNs !== undefined && provider.settingsNs !== ns) return null;
				if (view.status === "ready" && models.length === 0 && provider.declared !== true) return null;

				// 每个模型自带「思考强度」字段标签（下面每行一个 fieldset 的样子），所以不需要全局标题。

				/** 勾选行：七个档位 + 「非推理模型」。座位里的整块与模型行内共用同一份。 */
				const choicesOf = (key, draft) =>
					react.createElement(
						"div",
						{ className: "dsh-rs-choices", key: "choices" },
						LEVELS.map((level) =>
							react.createElement(
								"label",
								{ className: "dsh-rs-choice", key: level, title: LEVEL_TITLES[level] },
								react.createElement("input", {
									type: "checkbox",
									checked: draft.levels.includes(level),
									disabled: !writable || busy || draft.disabled === true,
									onChange: () => toggleLevel(key, level),
								}),
								level,
							),
						),
						react.createElement(
							"label",
							{
								className: "dsh-rs-choice dsh-rs-none",
								key: "none",
								title: "写入 reasoningEfforts: false，明确声明这是非推理模型（上面的勾选会休眠，取消勾选即恢复）",
							},
							react.createElement("input", {
								type: "checkbox",
								checked: draft.disabled === true,
								disabled: !writable || busy,
								onChange: () => toggleNone(key),
							}),
							NONE_LABEL,
						),
					);

				/**
				 * 路由默认档位那一行：一个「默认档位」下拉 + 说明。
				 *
				 * 它写 `providers.<route>.reasoning`（`llm-pi-ai` schema 的合法字段），就是模型选择器
				 * 切到这条路由时"默认"那一格落在哪、以及请求没带显式档位时实际发送的值。
				 * 候选取"每个模型都声明过的最高档"（max 优先，没有依次向下，全都没有就只有一个
				 * 「不设置」可选项）——取并集会撞 `UNSUPPORTED_REASONING_EFFORT`，那会让同路由
				 * 其它模型全部不可用。
				 */
				const routeDefaultRow = () => {
					// 候选档位：从自动推荐档位往上取到该路由所有模型共同声明过的最高档。
					const candidates = LEVELS.filter((level) => level !== "off" && models.every((model) => effortState(model).levels.includes(level)));
					const options = [react.createElement("option", { key: "none", value: "" }, "不设置")];
					for (const level of candidates) options.push(react.createElement("option", { key: level, value: level }, level));
					return react.createElement(
						"div",
						{ className: "dsh-rs-routedefault", key: "routedefault" },
						react.createElement(
							"label",
							{ className: "dsh-rs-routedefault-field", key: "field" },
							react.createElement("span", { className: "dsh-rs-label" }, "默认档位"),
							react.createElement(
								"select",
								{
									className: "dsh-rs-routedefault-select",
									key: "select",
									value: routeDraft === undefined ? (view.routeDefault ?? "") : routeDraft,
									disabled: !writable || busy,
									title: "切到这条路由的模型时，选择器「默认」那一格落在哪；请求没带显式档位时发送这个值",
									onChange: (event) => chooseRouteDraft(event.target.value === "" ? null : String(event.target.value)),
								},
								options,
							),
						),
						react.createElement(
							"span",
							{ className: "dsh-rs-note", key: "hint" },
							candidates.length === 0
								? "这条路由的模型还没有共同的档位，默认档位保持不设置。"
								: `下拉里只有每个模型都勾过的档位（最高 ${candidates[candidates.length - 1]}），选其它档位会让没勾它的模型请求被拒。`,
						),
					);
				};

				/** 校验与提示：只勾 off 不合法；路由默认档位没勾上时请求可能被拒。只提示、不拦，与整块模式一致。 */
				const notesOf = (key, draft) => {
					const parts = [];
					const problem = draftProblem(draft);
					if (problem !== undefined) {
						parts.push(react.createElement("p", { className: "dsh-rs-problem", key: "problem" }, problem));
					}
					if (draft.disabled !== true && draft.levels.length > 0 && typeof view.routeDefault === "string" && !draft.levels.includes(view.routeDefault)) {
						parts.push(
							react.createElement(
								"p",
								{ className: "dsh-rs-warn", key: "warn" },
								`该路由的默认档位是 ${view.routeDefault}，这里没有勾选它：未显式选择档位时请求可能被拒，建议一并勾上。`,
							),
						);
					}
					return parts;
				};

				/**
				 * 行内的「保存到配置 / 放弃这一行」：**只有这一行有未保存草稿时**才出现。
				 *
				 * 为什么必须有它：行内形态下勾选框在模型行里，而卡片底部那条保存条要滚过整个
				 * 官方编辑器才看得到 —— 用户勾完就走，会以为"设置了却没生效"（草稿只活在组件
				 * state 里，重开配置页就被还原）。保存动作与底部那个按钮是同一个 `save`，
				 * 禁用判据也共用 `saveDisabled`，两处不会分叉。
				 */
				const inlineActionsOf = (key) =>
					react.createElement(
						"div",
						{ className: "dsh-rs-inline-actions", key: "actions" },
						react.createElement(
							"button",
							{
								className: "dsh-rs-save",
								key: "save",
								type: "button",
								title: writable ? "把这张卡上所有未保存的勾选写入 profile 配置" : "当前配置只读",
								disabled: saveDisabled(writable, busy, changed, problems.length),
								onClick: () => void save(),
							},
							busy ? "写入中…" : "保存到配置",
						),
						react.createElement(
							"button",
							{
								className: "dsh-rs-reset",
								key: "discard",
								type: "button",
								title: "放弃这一行的勾选（其它行的未保存改动保留）",
								disabled: !writable || busy,
								onClick: () => discardDraft(key),
							},
							"放弃这一行",
						),
					);

				/** 模型行内的控件：不重复模型名（官方那一行已经写了），并标出这一行有未保存的改动。 */
				const inlineControlsOf = (key, model) => {
					const stored = effortState(model);
					const hasDraft = Object.prototype.hasOwnProperty.call(drafts, key);
					const draft = hasDraft ? drafts[key] : stored;
					const declared = stored.disabled === true || stored.levels.length > 0;
					const parts = [
						react.createElement(
							"div",
							{ className: "dsh-rs-field", key: "field" },
							react.createElement(
								"span",
								{ className: "dsh-rs-fieldlabel", key: "label" },
								react.createElement("span", { className: "dsh-rs-label" }, "思考强度"),
								hasDraft ? react.createElement("span", { className: "dsh-rs-pending" }, "未保存") : null,
							),
							react.createElement(
								"button",
								{
									className: "dsh-rs-reset",
									key: "reset",
									type: "button",
									title: "删掉这个模型的 reasoningEfforts，回到继承（不写这个字段）",
									disabled: !writable || busy || !declared,
									onClick: () => resetModel(key),
								},
								"恢复默认",
							),
						),
						choicesOf(key, draft),
					];
					// 有未保存的勾选就把保存入口放在勾选框正下方（原来的保存按钮只在卡片最底部）。
					if (hasDraft) parts.push(inlineActionsOf(key));
					parts.push(...notesOf(key, draft));
					// 保存失败的原因也贴在这一行：草稿还在时那行提示才与这一行有关。
					if (hasDraft && note !== undefined) parts.push(react.createElement("p", { className: "dsh-rs-note", key: "note" }, note));
					return parts;
				};
				const children = [];

				if (view.status === "loading") {
					children.push(react.createElement("p", { className: "dsh-rs-note", key: "loading" }, "思考强度 · 读取配置…"));
				} else if (view.status === "error") {
					children.push(
						react.createElement(
							"p",
							{ className: "dsh-rs-error", key: "load-error" },
							`思考强度 · 读取配置失败：${view.message}`,
						),
					);
					children.push(
						react.createElement(
							"button",
							{ className: "dsh-rs-save", key: "retry", type: "button", onClick: () => void load() },
							"重试",
						),
					);
				} else if (models.length === 0) {
					children.push(
						react.createElement(
							"p",
							{ className: "dsh-rs-note", key: "empty" },
							"思考强度：这个提供商还没有写进配置的模型 —— 先在「自定义设置 → 模型选项」保存模型，再回来勾选。",
						),
					);
				} else {
					const rows = models.map((model, index) => {
						const key = String(model === null || typeof model !== "object" ? "" : model.id);
						const stored = effortState(model);
						const draft = Object.prototype.hasOwnProperty.call(drafts, key) ? drafts[key] : stored;
						const label = model !== null && typeof model === "object" && typeof model.name === "string" && model.name.length > 0 ? model.name : key;
						const parts = [
							// 字段标签行：模型身份 + 「思考强度」（与官方「输入类型」同一语法），已声明时可恢复默认
							react.createElement(
								"div",
								{ className: "dsh-rs-field", key: "field" },
								react.createElement(
									"span",
									{ className: "dsh-rs-fieldlabel", key: "label" },
									react.createElement("span", { className: "dsh-rs-name" }, label === key ? key : `${label}（${key}）`),
									react.createElement("span", { className: "dsh-rs-label" }, "思考强度"),
								),
								stored.disabled === false && stored.levels.length === 0
									? null
									: react.createElement(
											"button",
											{
												className: "dsh-rs-reset",
												key: "reset",
												type: "button",
												title: "删掉这个模型的 reasoningEfforts，回到继承（不写这个字段）",
												disabled: !writable || busy,
												onClick: () => resetModel(key),
											},
											"恢复默认",
										),
							),
							choicesOf(key, draft),
						];
						parts.push(...notesOf(key, draft));
						return react.createElement("li", { className: "dsh-rs-model", key: `${key}#${String(index)}` }, parts);
					});
					children.push(react.createElement("ul", { className: "dsh-rs-list", key: "list" }, rows));
					// 路由默认档位：切到这条路由的模型时，选择器"默认"那一格落在哪。
					children.push(routeDefaultRow());
					children.push(
						react.createElement(
							"p",
							{ className: "dsh-rs-note", key: "legend" },
							"未勾选任何档位 = 不写这个字段（继承适配器/目录的能力）；勾「非推理模型」= 写 reasoningEfforts: false。",
						),
					);
					children.push(
						react.createElement(
							"div",
							{ className: "dsh-rs-foot", key: "foot" },
							react.createElement(
								"button",
								{
									className: "dsh-rs-save",
									type: "button",
									disabled: saveDisabled(writable, busy, changed, problems.length),
									title: writable ? "把这张卡上所有未保存的勾选写入 profile 配置" : "当前配置只读",
									onClick: () => void save(),
								},
								busy ? "写入中…" : "保存到配置",
							),
							react.createElement(
								"button",
								{
									className: "dsh-rs-reset",
									type: "button",
									disabled: !writable || busy || Object.keys(drafts).length === 0,
									onClick: () => {
										setNote(undefined);
										setDrafts({});
										setRouteDraft(undefined);
									},
								},
								"放弃改动",
							),
							changed ? react.createElement("span", { className: "dsh-rs-pending", key: "pending" }, "有未保存的勾选") : null,
						),
					);
				}

				if (view.status === "ready" && models.length > 0 && !writable) {
					children.push(react.createElement("p", { className: "dsh-rs-note", key: "readonly" }, "当前 profile 配置只读，无法写入。"));
				}
				if (problems.length > 0) {
					children.push(
						react.createElement("p", { className: "dsh-rs-problem", key: "problems" }, `还有 ${String(problems.length)} 个模型不能保存：${problems.join("；")}`),
					);
				}
				if (note !== undefined) children.push(react.createElement("p", { className: "dsh-rs-note", key: "note" }, note));

				/**
				 * 认得出官方模型行 ⇒ 座位里那块**整个让位**（CSS 用 data-inline="1" 隐藏）：勾选组由门户
				 * 进模型行，保存/放弃/提示由门户进卡片末尾的保存条（有未保存勾选的行里另有一份，
				 * 见 `inlineActionsOf`）。认不出（卡片折叠着、官方改了行结构、拿不到 react-dom）才渲染
				 * 整块兜底 —— 所以正常情况下看不到"上方那块设置"。
				 */
				const inlineActive = reactDom !== undefined && attachment.bar !== undefined;
				const barKeys = ["legend", "foot", "readonly", "problems", "note", "routedefault"];
				const barChildren = [];
				for (const child of children) {
					if (child !== null && child !== undefined && barKeys.includes(child.key)) barChildren.push(child);
				}
				const box = react.createElement(
					"div",
					{
						className: "dsh-rs-box",
						"data-inline": inlineActive ? "1" : "0",
						"data-dsh-rs-own": "box",
						ref: attachBox,
						key: "box",
					},
					inlineActive ? [] : children,
				);
				if (!inlineActive) return box;
				const portals = [box];
				for (const row of attachment.rows) {
					const model = models.find((candidate) => String(candidate === null || typeof candidate !== "object" ? "" : candidate.id) === row.id);
					if (model === undefined) continue;
					const dirty = Object.prototype.hasOwnProperty.call(drafts, row.id);
					portals.push(
						reactDom.createPortal(
							react.createElement("div", { className: dirty ? "dsh-rs-model dsh-rs-inline-row dsh-rs-dirty" : "dsh-rs-model dsh-rs-inline-row" }, inlineControlsOf(row.id, model)),
							row.node,
							`row:${row.id}`,
						),
					);
				}
				portals.push(reactDom.createPortal(barChildren, attachment.bar, "bar"));
				return react.createElement(react.Fragment, null, portals);
			}

			/** 座位条目：边界包住整棵子树。 */
			return function Section(props) {
				return react.createElement(SeatBoundary, null, react.createElement(Body, props));
			};
		}

		//#endregion

		/**
		 * 客户端插件体：只注入所需服务，只注册座位。
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			ensureStyles();
			// 座位由官方 ui-settings-models 的 settings.section 声明；注册进未声明的座位会抛错，
			// 所以必须走 slots.inject。inject 工厂里不做任何可能抛错的事。
			ctx.inject(["slots", "remote", "remote.settings"], (scope) => {
				scope.slots.inject(SEAT, () => {
					for (const ns of NAMESPACES) {
						scope.slots.register({ name: SEAT, key: ns }, makeSection(scope, ns));
					}
				});
			});
		}

		exports.apply = apply;
		// tools/verify.mjs 用的内部钩子：这些纯函数是写入正确性的全部风险所在，
		// 离线自检直接断言它们，而不是靠"看起来对"。不属于对外契约。
		exports.__test = {
			SEAT,
			NAMESPACES,
			LEVELS,
			FIELD,
			OWN_ATTR,
			EMPTY_ATTACH,
			effortState,
			effortsOf,
			draftProblem,
			applyDrafts,
			collectProblems,
			saveDisabled,
			dropDraft,
			routeDefaultLevel,
			modelsOp,
			getPath,
			makeSection,
			modelRowsUnder,
			modelHeadersUnder,
			cardElementOf,
			inlinePlanUnder,
			attachInline,
			detachInline,
			oursMutation,
		};
		return module.exports;
	},
});
