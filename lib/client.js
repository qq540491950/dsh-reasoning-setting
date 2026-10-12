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
		/** 每个模型的三种声明姿态。 */
		const MODES = ["inherit", "none", "declare"];
		const MODE_LABELS = { inherit: "继承", none: "非推理", declare: "自定义" };
		const MODE_TITLES = {
			inherit: "不写这个字段：继承已安装目录的能力（手写路由等于不提供思考档位）",
			none: "写入 reasoningEfforts: false，明确声明这是非推理模型",
			declare: "写入 reasoningEfforts 字典，勾选该模型可用的档位",
		};
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

		/** 一个模型条目当前声明成什么姿态、勾了哪些档位。 */
		function effortState(model) {
			const value = model === null || typeof model !== "object" ? undefined : model[FIELD];
			if (value === false) return { mode: "none", levels: [] };
			if (value === undefined) return { mode: "inherit", levels: [] };
			if (value === null || typeof value !== "object" || Array.isArray(value)) return { mode: "declare", levels: [] };
			return { mode: "declare", levels: LEVELS.filter((level) => Object.prototype.hasOwnProperty.call(value, level)) };
		}

		/**
		 * 草稿 → 要写进配置的值。`undefined` 表示「删掉这个字段」（继承）。
		 * 已声明的自定义拼写（例如 `max: "ultra"`）在重新勾选时保留，不会被改成档位名。
		 */
		function effortsOf(draft, previous) {
			if (draft.mode === "inherit") return undefined;
			if (draft.mode === "none") return false;
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

		/** 一份草稿能不能写；返回中文原因，或 undefined。 */
		function draftProblem(draft) {
			if (draft.mode !== "declare") return undefined;
			if (!draft.levels.some((level) => level !== "off")) {
				return "至少勾选一个 off 之外的档位（只有 off 的字典会被配置校验拒绝；非推理模型请选「非推理」）";
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
.dsh-rs-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.dsh-rs-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-rs-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-rs-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.dsh-rs-model { display: flex; flex-direction: column; gap: 6px; }
.dsh-rs-name {
	font-size: 12px;
	color: var(--dsw-alias-label-primary);
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	word-break: break-all;
}
.dsh-rs-modes {
	display: inline-flex;
	width: max-content;
	border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.24));
	border-radius: 6px;
	overflow: hidden;
}
.dsh-rs-mode {
	appearance: none;
	border: 0;
	background: transparent;
	color: var(--dsw-alias-label-secondary);
	font-size: 11px;
	line-height: 1.5;
	padding: 3px 10px;
	cursor: pointer;
}
.dsh-rs-mode + .dsh-rs-mode { border-left: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.24)); }
.dsh-rs-mode[aria-checked="true"] { color: var(--dsw-alias-brand-primary); font-weight: 600; }
.dsh-rs-mode:disabled { opacity: 0.5; cursor: not-allowed; }
.dsh-rs-levels { display: flex; flex-wrap: wrap; gap: 4px 12px; }
.dsh-rs-level {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	font-size: 11px;
	color: var(--dsw-alias-label-secondary);
	cursor: pointer;
}
.dsh-rs-level input { margin: 0; }
.dsh-rs-level:has(input:disabled) { opacity: 0.5; cursor: not-allowed; }
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
.dsh-rs-reset {
	appearance: none;
	border: 0;
	background: transparent;
	color: var(--dsw-alias-label-secondary);
	font-size: 11px;
	padding: 0;
	cursor: pointer;
	text-decoration: underline;
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

				const models = view.status === "ready" && Array.isArray(view.models) ? view.models : [];
				const nextModels = applyDrafts(models, drafts);
				const problems = collectProblems(models, drafts);
				const changed = view.status === "ready" && JSON.stringify(nextModels) !== JSON.stringify(models);
				const writable = view.status === "ready" && view.writable === true;

				/** 改一个模型的草稿。 */
				const setDraft = (key, updater) => {
					setDrafts((current) => {
						const model = models.find((row) => String(row === null || typeof row !== "object" ? "" : row.id) === key);
						const base = Object.prototype.hasOwnProperty.call(current, key) ? current[key] : effortState(model);
						return { ...current, [key]: updater(base) };
					});
				};

				/** 切姿态；切到「自定义」时保留原有勾选。 */
				const pickMode = (key, mode) => {
					setNote(undefined);
					setDraft(key, (base) => ({ mode, levels: base.levels }));
				};

				/** 勾/去勾一个档位（隐式切到「自定义」）。 */
				const toggleLevel = (key, level) => {
					setNote(undefined);
					setDraft(key, (base) => {
						const levels = base.levels.includes(level) ? base.levels.filter((item) => item !== level) : [...base.levels, level];
						return { mode: "declare", levels: LEVELS.filter((item) => levels.includes(item)) };
					});
				};

				/** 写入 profile 配置：一次 mutate 只带一个数组 set，与官方编辑器同一种最小写法。 */
				const save = async () => {
					if (path === undefined || view.status !== "ready") return;
					setBusy(true);
					setNote(undefined);
					try {
						const answer = await ctx.remote.settings.mutate(ns, [modelsOp(settingsPath, nextModels)], view.revision);
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
						setNote("已写入 profile 的 cordis.patch.yml（模型选择器随即生效）");
					} catch (error) {
						setNote(`写入失败：${describeError(error)}`);
					} finally {
						setBusy(false);
					}
				};

				if (route === undefined || path === undefined) return null;
				if (provider.settingsNs !== undefined && provider.settingsNs !== ns) return null;
				if (view.status === "ready" && models.length === 0 && provider.declared !== true) return null;

				const children = [];

				children.push(
					react.createElement(
						"div",
						{ className: "dsh-rs-head", key: "head" },
						react.createElement("span", { className: "dsh-rs-title" }, "思考强度"),
						react.createElement("span", { className: "dsh-rs-hint" }, "按模型勾选可用档位"),
					),
				);

				if (view.status === "loading") {
					children.push(react.createElement("p", { className: "dsh-rs-note", key: "loading" }, "读取配置…"));
				} else if (view.status === "error") {
					children.push(
						react.createElement(
							"p",
							{ className: "dsh-rs-error", key: "load-error" },
							`读取配置失败：${view.message}`,
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
							"这个提供商还没有写进配置的模型：先在「自定义设置 → 模型选项」保存模型，再回来勾选思考强度。",
						),
					);
				} else {
					const rows = models.map((model, index) => {
						const key = String(model === null || typeof model !== "object" ? "" : model.id);
						const draft = Object.prototype.hasOwnProperty.call(drafts, key) ? drafts[key] : effortState(model);
						const label = model !== null && typeof model === "object" && typeof model.name === "string" && model.name.length > 0 ? model.name : key;
						const parts = [
							react.createElement("span", { className: "dsh-rs-name", key: "name" }, label === key ? key : `${label}（${key}）`),
							react.createElement(
								"div",
								{ className: "dsh-rs-modes", role: "radiogroup", "aria-label": `${label} 的思考强度声明方式`, key: "modes" },
								MODES.map((mode) =>
									react.createElement(
										"button",
										{
											className: "dsh-rs-mode",
											key: mode,
											type: "button",
											role: "radio",
											"aria-checked": draft.mode === mode,
											title: MODE_TITLES[mode],
											disabled: !writable || busy,
											onClick: () => pickMode(key, mode),
										},
										MODE_LABELS[mode],
									),
								),
							),
						];
						if (draft.mode === "declare") {
							parts.push(
								react.createElement(
									"div",
									{ className: "dsh-rs-levels", key: "levels" },
									LEVELS.map((level) =>
										react.createElement(
											"label",
											{ className: "dsh-rs-level", key: level, title: LEVEL_TITLES[level] },
											react.createElement("input", {
												type: "checkbox",
												checked: draft.levels.includes(level),
												disabled: !writable || busy,
												onChange: () => toggleLevel(key, level),
											}),
											level,
										),
									),
								),
							);
							const problem = draftProblem(draft);
							if (problem !== undefined) {
								parts.push(react.createElement("p", { className: "dsh-rs-problem", key: "problem" }, problem));
							}
							// 路由默认档位（providers.<route>.reasoning）决定「没显式选档位」时发什么；
							// 它不在本次勾选里的话，请求会撞 UNSUPPORTED_REASONING_EFFORT。只提示，不拦。
							if (typeof view.routeDefault === "string" && !draft.levels.includes(view.routeDefault)) {
								parts.push(
									react.createElement(
										"p",
										{ className: "dsh-rs-warn", key: "warn" },
										`该路由的默认档位是 ${view.routeDefault}，这里没有勾选它：未显式选择档位时请求可能被拒，建议一并勾上。`,
									),
								);
							}
						}
						return react.createElement("li", { className: "dsh-rs-model", key: `${key}#${String(index)}` }, parts);
					});
					children.push(react.createElement("ul", { className: "dsh-rs-list", key: "list" }, rows));
					children.push(
						react.createElement(
							"div",
							{ className: "dsh-rs-foot", key: "foot" },
							react.createElement(
								"button",
								{
									className: "dsh-rs-save",
									type: "button",
									disabled: !writable || busy || !changed || problems.length > 0,
									title: writable ? "把勾选写入 profile 配置" : "当前配置只读",
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
									},
								},
								"放弃改动",
							),
							changed ? react.createElement("span", { className: "dsh-rs-hint" }, "有未保存的勾选") : null,
						),
					);
					if (!writable) {
						children.push(react.createElement("p", { className: "dsh-rs-note", key: "readonly" }, "当前 profile 配置只读，无法写入。"));
					}
					if (problems.length > 0) {
						children.push(
							react.createElement("p", { className: "dsh-rs-problem", key: "problems" }, `还有 ${String(problems.length)} 个模型不能保存：${problems.join("；")}`),
						);
					}
				}

				if (note !== undefined) children.push(react.createElement("p", { className: "dsh-rs-note", key: "note" }, note));

				return react.createElement("div", { className: "dsh-rs-box" }, children);
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
			MODES,
			FIELD,
			effortState,
			effortsOf,
			draftProblem,
			applyDrafts,
			collectProblems,
			modelsOp,
			getPath,
			makeSection,
		};
		return module.exports;
	},
});
