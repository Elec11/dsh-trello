/**
 * Browser half of the dsh-trello plugin.
 *
 * Registers a configuration page in the plugin manager's `plugins.bundle.config`
 * slot (keyed by the bundle package name, `dsh-trello`) that exposes a single
 * toggle for the `passive` (read-only) setting. The page reads and writes the
 * shared settings form for the `tool-trello` entry through the `configForms`
 * service, so a change flows through the normal settings pipeline:
 *
 *   toggle → configForms.set("passive", …) → remote.settings.mutate
 *         → cordis.patch.yml → hot reload → apply() re-runs with the new value
 *         → the tool set is rebuilt (read-only tools only when passive).
 *
 * This is a plain-JavaScript browser bundle: it registers itself through
 * `window.__ModuleLoader__` and builds elements with `React.createElement`
 * (no JSX). It is compiled to CommonJS by `tsconfig.client.json` and shipped
 * as `dist/src/client.js` (the package's `./client` export).
 */

/** The browser module system's require: resolves platform seeds and graph rows. */
type RequireFn = (spec: string) => any;

/** One sync snapshot of a shared settings form (see ConfigFormController). */
interface FormSnapshot {
	status: "loading" | "unavailable" | "ready";
	value?: Record<string, unknown>;
	base?: unknown;
	user?: unknown;
	revision?: number;
	writable: boolean;
	mode?: string;
}

/** The per-entry form face returned by `configForms.get(entryId)`. */
interface FormController {
	getSnapshot(): FormSnapshot;
	subscribe(listener: (snapshot: FormSnapshot) => void): () => void;
	set(field: string, value: unknown): Promise<boolean>;
}

interface ConfigFormsService {
	get(entryId: string): FormController;
}

interface SlotsService {
	inject(slot: string, factory: () => unknown): void;
	register(options: Record<string, unknown>, component: unknown): void;
}

interface ClientContext {
	configForms: ConfigFormsService;
	slots: SlotsService;
}

/** Unique Host plugin entry id (matches `name` in src/index.ts and the patch row). */
const ENTRY_ID = "tool-trello";
/** The bundle package name: the key the plugin manager dispatches on. */
const BUNDLE_KEY = "dsh-trello";

(window as any).__ModuleLoader__.load({
	id: BUNDLE_KEY,
	factory: (require: RequireFn) => {
		const module = { exports: {} as Record<string, unknown> };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// `react` is a platform seed word; primitives is a shell-provided module
		// (it has no `dsh.client` of its own, so it is not a graph row and is
		// resolved from the shell's static modules, exactly as the shipped
		// ui-settings-* companion packages do).
		const React = require("react") as {
			createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown;
			useSyncExternalStore(subscribe: (onStoreChange: () => void) => () => void, getSnapshot: () => FormSnapshot): FormSnapshot;
		};
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives") as {
			Switch(props: {
				checked: boolean;
				onChange: (next: boolean) => void;
				label: string;
				disabled?: boolean;
				title?: string;
				className?: string;
			}): unknown;
		};
		const { createElement, useSyncExternalStore } = React;
		const { Switch: SwitchControl } = primitives;

		function apply(ctx: ClientContext): void {
			const form = ctx.configForms.get(ENTRY_ID);

			// The page is only rendered by the plugin manager once this slot is
			// registered and the bundle is open, so `form` is always set by the
			// time the component mounts.
			function TrelloConfigPage(): unknown {
				const snapshot = useSyncExternalStore(
					(onStoreChange) => form.subscribe(onStoreChange),
					() => form.getSnapshot(),
				);

				if (snapshot.status === "loading") {
					return createElement("p", { role: "status" }, "Loading Trello settings…");
				}
				if (snapshot.status === "unavailable") {
					return createElement("p", { role: "status" }, "This plugin is not active.");
				}

				const passive = (snapshot.value?.passive as unknown) === true;
				const writable = snapshot.writable;

				return createElement(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: "10px", padding: "8px 0" } },
					createElement(
						"div",
						{ style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px" } },
						createElement("span", { style: { fontSize: "14px" } }, "Read-only mode"),
						createElement(SwitchControl, {
							checked: passive,
							label: "Read-only mode",
							disabled: !writable,
							onChange: (next: boolean) => {
								void form.set("passive", next);
							},
						}),
					),
					createElement(
						"p",
						{ style: { margin: 0, fontSize: "12px", opacity: 0.7 } },
						passive
							? "Only read-only Trello tools are available; the model cannot create, update, or comment."
							: "All Trello tools are available, including creating, updating, and commenting.",
					),
				);
			}

			ctx.slots.inject("plugins.bundle.config", () =>
				ctx.slots.register(
					{
						name: "plugins.bundle.config",
						key: BUNDLE_KEY,
					},
					TrelloConfigPage,
				),
			);
		}

		// Required services (cordis fiber inject): the slot registrar and the
		// shared settings forms.
		const inject = ["slots", "configForms"];

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
