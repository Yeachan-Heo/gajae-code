/**
 * CustomizationDashboard — the umbrella local-customization home opened by the
 * `/extensions` slash command (issue #4291).
 *
 * This is a standalone state model and component tree around local
 * Skills/Hooks/MCPs/Import. It is intentionally NOT built on the
 * provider/extension-module ExtensionDashboard; the two surfaces share only
 * generic TUI primitives (Container, Text, SelectList, DynamicBorder).
 *
 * The scope switch is a real management boundary: each list only shows rows
 * persisted at the active scope, and mutations refuse rows from the other
 * scope. All dynamic text is sanitized before rendering.
 *
 * Layout (narrow-terminal safe):
 *   title: /extensions — Configure skills, hooks, and MCPs.
 *   scope badge (Project .gjc / Global .gjc) — `s` switches
 *   section tabs: Skills | Hooks | MCPs — left/right switch
 *   inventory rows for the active section + scope with status + provenance
 *   footer key hints
 */
import { Container, matchesKey, type SelectItem, SelectList, Text } from "@gajae-code/tui";
import { getTrustedHomeDir, sanitizeText } from "@gajae-code/utils";
import { type CustomizationInventory, loadCustomizationInventory } from "../../../customization/inventory";
import {
	removeHookFile,
	removeMcpServerEntry,
	removeSkill,
	setMcpServerEnabled,
	setSkillEnabled,
} from "../../../customization/mutations";
import {
	CUSTOMIZATION_SURFACES,
	type CustomizationSurface,
	type GjcScope,
	type InventoryRow,
	resolveScopePaths,
	scopeLabel,
	surfaceLabel,
} from "../../../customization/types";
import type { SkillManagementPolicy } from "../../../extensibility/skill-management";
import { replaceTabs, truncateToWidth } from "../../../tools/render-utils";
import { getSelectListTheme, theme } from "../../theme/theme";
import { matchesAppInterrupt } from "../../utils/keybinding-matchers";
import { DynamicBorder } from "../dynamic-border";
import { ImportWizard } from "./import-wizard";

/** Minimal settings slice the dashboard reads and writes. */
export interface CustomizationSettingsSlice {
	get(key: string): unknown;
	getAgentDir?(): string;
	set?(key: string, value: unknown): void;
}

/** Sanitize + detab every dynamic string before it reaches a renderer. */
function safe(text: string): string {
	return replaceTabs(sanitizeText(text));
}

const STATUS_COLORS: Record<InventoryRow["status"], (text: string) => string> = {
	enabled: text => theme.fg("success", text),
	disabled: text => theme.fg("muted", text),
	invalid: text => theme.fg("error", text),
	shadowed: text => theme.fg("warning", text),
	quarantined: text => theme.fg("warning", text),
	imported: text => theme.fg("accent", text),
	"restart-required": text => theme.fg("warning", text),
};

function rowToSelectItem(row: InventoryRow): SelectItem {
	const color = STATUS_COLORS[row.status];
	const status = color(row.status);
	return {
		value: row.id,
		label: safe(row.displayName),
		description: `${status} ${theme.fg("muted", `· ${safe(row.provenance)}`)}${
			row.description ? theme.fg("muted", ` — ${safe(row.description)}`) : ""
		}${row.diagnostics?.length ? theme.fg("warning", ` — ${safe(row.diagnostics[0])}`) : ""}`,
	};
}

export class CustomizationDashboard extends Container {
	/** Called when the dashboard wants to close (Esc / q / interrupt). */
	onClose: (() => void) | undefined;
	/** Called whenever the dashboard needs a re-render. */
	onRequestRender: (() => void) | undefined;

	#cwd: string;
	#settings: CustomizationSettingsSlice | undefined;
	#scope: GjcScope = "project";
	#section: CustomizationSurface = "skills";
	#inventory: CustomizationInventory = { rows: [], warnings: [] };
	#lists = new Map<CustomizationSurface, SelectList>();
	#bodyContainer!: Container;
	#headerTexts: Text[] = [];
	#footerText!: Text;
	#wizard: ImportWizard | null = null;
	#confirmRemove: InventoryRow | null = null;
	#homeDir: string;
	#agentDir: string | undefined;
	#statusMessage: string | null = null;

	/** Use `create()` — async inventory load runs before chrome construction. */
	constructor(cwd: string, settings: CustomizationSettingsSlice | undefined, homeDir: string, agentDir?: string) {
		super();
		this.#cwd = cwd;
		this.#settings = settings;
		this.#homeDir = homeDir;
		this.#agentDir = agentDir;
	}

	static async create(
		cwd: string,
		settings?: CustomizationSettingsSlice,
		homeDir?: string,
		agentDir?: string,
	): Promise<CustomizationDashboard> {
		const dashboard = new CustomizationDashboard(cwd, settings, homeDir ?? getTrustedHomeDir(), agentDir);
		await dashboard.#reload();
		dashboard.#buildChrome();
		return dashboard;
	}

	get scope(): GjcScope {
		return this.#scope;
	}

	get section(): CustomizationSurface {
		return this.#section;
	}

	/** Current inventory snapshot (test-visible). */
	get inventory(): CustomizationInventory {
		return this.#inventory;
	}

	#getStringArray(key: string): string[] {
		const value = this.#settings?.get(key);
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
	}

	#skillPolicy(): SkillManagementPolicy {
		return {
			enabled: this.#settings?.get("skills.enabled") as boolean | undefined,
			trustProjectSkills: this.#settings?.get("skills.trustProjectSkills") as boolean | undefined,
			trustUserSkills: this.#settings?.get("skills.trustUserSkills") as boolean | undefined,
			ignoredSkills: this.#getStringArray("skills.ignoredSkills"),
			includeSkills: this.#getStringArray("skills.includeSkills"),
			disabledExtensions: this.#getStringArray("disabledExtensions"),
		};
	}

	async #reload(): Promise<void> {
		this.#inventory = await loadCustomizationInventory({
			cwd: this.#cwd,
			home: this.#homeDir,
			agentDir: this.#agentDir ?? this.#settings?.getAgentDir?.(),
			policy: this.#skillPolicy(),
			disabledExtensions: this.#getStringArray("disabledExtensions"),
		});
	}

	/** Rows visible under the active scope — the scope switch is a real boundary. */
	#visibleRows(surface: CustomizationSurface): InventoryRow[] {
		return this.#inventory.rows.filter(row => row.surface === surface && row.scope === this.#scope);
	}

	#buildChrome(): void {
		this.clear();
		this.#headerTexts = [];
		this.#lists.clear();

		this.addChild(new DynamicBorder());
		const title = new Text("", 0, 0);
		const scopeLine = new Text("", 0, 0);
		const tabs = new Text("", 0, 0);
		this.#headerTexts = [title, scopeLine, tabs];
		this.addChild(title);
		this.addChild(scopeLine);
		this.addChild(tabs);
		this.addChild(new DynamicBorder());

		this.#bodyContainer = new Container();
		for (const surface of CUSTOMIZATION_SURFACES) {
			const rows = this.#visibleRows(surface);
			const items: SelectItem[] =
				rows.length > 0
					? rows.map(rowToSelectItem)
					: [
							{
								value: `${surface}:empty`,
								label: theme.fg(
									"muted",
									`(no ${surfaceLabel(surface).toLowerCase()} at ${scopeLabel(this.#scope)})`,
								),
								description: theme.fg("muted", "switch scope with s, or import with i"),
								disabled: true,
							},
						];
			const list = new SelectList(items, Math.min(Math.max(items.length, 1), 8), getSelectListTheme());
			list.onCancel = () => this.onClose?.();
			this.#lists.set(surface, list);
			if (surface === this.#section) this.#bodyContainer.addChild(list);
		}
		this.addChild(this.#bodyContainer);

		this.addChild(new DynamicBorder());
		this.#footerText = new Text("", 0, 0);
		this.addChild(this.#footerText);
		this.addChild(new DynamicBorder());
		this.#refreshChrome();
	}

	#refreshChrome(): void {
		const [title, scopeLine, tabs] = this.#headerTexts;
		title.setText(
			theme.bold(theme.fg("accent", "/extensions")) + theme.fg("muted", " — Configure skills, hooks, and MCPs."),
		);
		const other: GjcScope = this.#scope === "project" ? "global" : "project";
		scopeLine.setText(
			`${theme.fg("muted", "scope:")} ${theme.bold(scopeLabel(this.#scope))}  ${theme.fg("muted", `(s: switch to ${scopeLabel(other)} — lists and actions follow the scope)`)}`,
		);
		const tabLine = CUSTOMIZATION_SURFACES.map(surface =>
			surface === this.#section
				? theme.bold(theme.fg("accent", `[${surfaceLabel(surface)}]`))
				: ` ${surfaceLabel(surface)} `,
		).join(theme.fg("muted", "│"));
		tabs.setText(tabLine);
		const warnings = this.#inventory.warnings.length;
		const status = this.#statusMessage ? ` · ${theme.fg("accent", safe(this.#statusMessage))}` : "";
		const confirm = this.#confirmRemove
			? ` · ${theme.fg("warning", `remove ${safe(this.#confirmRemove.displayName)}? y/n`)}`
			: "";
		this.#footerText.setText(
			theme.fg(
				"muted",
				`↑/↓ navigate · ←/→ section · s scope · e enable/disable · x remove · i import · esc close${
					warnings > 0 ? ` · ${theme.fg("warning", `${warnings} diagnostic${warnings === 1 ? "" : "s"}`)}` : ""
				}${confirm}${status}`,
			),
		);
	}

	#selectedRow(): InventoryRow | null {
		const selected = this.#lists.get(this.#section)?.getSelectedItem();
		if (!selected || selected.disabled) return null;
		return this.#visibleRows(this.#section).find(row => row.id === selected.value) ?? null;
	}

	#flashStatus(message: string): void {
		this.#statusMessage = message;
		this.#refreshChrome();
		this.onRequestRender?.();
	}

	async #applyMutation(action: () => Promise<{ ok: true } | { ok: false; reason: string }>): Promise<void> {
		const result = await action();
		this.#statusMessage = result.ok ? "done — reloaded inventory" : result.reason;
		await this.#reload();
		this.#buildChrome();
		this.onRequestRender?.();
	}

	/** Mutations may only target rows persisted at the active scope. */
	#guardScope(row: InventoryRow): boolean {
		if (row.scope !== this.#scope) {
			this.#flashStatus(
				`refusing to mutate a ${scopeLabel(row.scope)} entry while viewing ${scopeLabel(this.#scope)}`,
			);
			return false;
		}
		return true;
	}

	async #toggleSelected(): Promise<void> {
		const row = this.#selectedRow();
		if (!row || !this.#guardScope(row)) return;
		if (row.status === "invalid" || row.status === "shadowed" || row.status === "quarantined") {
			this.#flashStatus(`cannot toggle a ${row.status} entry; resolve its diagnostics first`);
			return;
		}
		const enable = row.status === "disabled";
		if (row.surface === "skills") {
			if (enable && this.#settings?.get("skills.enabled") === false) {
				this.#flashStatus("native skills are disabled globally; enable skills.enabled in /settings first");
				return;
			}
			const result = setSkillEnabled(row.name, enable, this.#getStringArray("disabledExtensions"));
			if (!result.ok) {
				this.#flashStatus(result.reason);
				return;
			}
			if (!this.#settings?.set) {
				this.#flashStatus("settings are read-only in this session; cannot persist the toggle");
				return;
			}
			this.#settings.set("disabledExtensions", result.disabledExtensions);
			await this.#applyMutation(async () => ({ ok: true }) as { ok: true });
		} else if (row.surface === "mcps") {
			const paths = resolveScopePaths(row.scope, this.#cwd, this.#agentDir ?? this.#settings?.getAgentDir?.());
			const result = await setMcpServerEnabled(
				paths.mcpConfigPath,
				row.name,
				enable,
				this.#getStringArray("disabledExtensions"),
			);
			if (!result.ok) {
				this.#flashStatus(result.reason);
				return;
			}
			if ("disabledExtensions" in result && this.#settings?.set) {
				this.#settings.set("disabledExtensions", result.disabledExtensions);
			}
			await this.#applyMutation(async () => ({ ok: true }) as { ok: true });
		} else {
			this.#flashStatus("hook enable/disable is not part of the canonical hook contract; remove instead");
		}
	}

	#beginRemove(): void {
		const row = this.#selectedRow();
		if (!row || !this.#guardScope(row)) return;
		this.#confirmRemove = row;
		this.#refreshChrome();
		this.onRequestRender?.();
	}

	async #confirmRemoveSelected(): Promise<void> {
		const row = this.#confirmRemove;
		this.#confirmRemove = null;
		if (!row || !this.#guardScope(row)) return;
		if (row.surface === "skills") {
			await this.#applyMutation(() => removeSkill({ name: row.name, path: row.path }));
		} else if (row.surface === "mcps") {
			await this.#applyMutation(() => removeMcpServerEntry(row.path, row.name));
		} else {
			await this.#applyMutation(() => removeHookFile(row.path));
		}
	}

	#openImportWizard(): void {
		const wizard = new ImportWizard(
			this.#cwd,
			this.#scope,
			this.#homeDir,
			this.#agentDir ?? this.#settings?.getAgentDir?.(),
		);
		this.#wizard = wizard;
		wizard.onRequestRender = () => this.onRequestRender?.();
		wizard.onClose = applied => {
			this.#wizard = null;
			this.#bodyContainer.clear();
			const list = this.#lists.get(this.#section);
			if (list) this.#bodyContainer.addChild(list);
			if (applied) {
				this.#statusMessage = "import applied — reloaded inventory";
				void this.#reload().then(() => {
					this.#buildChrome();
					this.onRequestRender?.();
				});
			} else {
				this.#refreshChrome();
				this.onRequestRender?.();
			}
		};
		this.#bodyContainer.clear();
		this.#bodyContainer.addChild(wizard);
		this.#statusMessage = null;
		this.onRequestRender?.();
	}

	#switchSection(next: CustomizationSurface): void {
		if (next === this.#section) return;
		this.#section = next;
		this.#bodyContainer.clear();
		const list = this.#lists.get(next);
		if (list) this.#bodyContainer.addChild(list);
		this.#refreshChrome();
		this.onRequestRender?.();
	}

	#switchScope(): void {
		this.#scope = this.#scope === "project" ? "global" : "project";
		// Rebuild the lists: the visible rows are scope-bound.
		this.#buildChrome();
		this.onRequestRender?.();
	}

	#cycleSection(direction: 1 | -1): void {
		const index = CUSTOMIZATION_SURFACES.indexOf(this.#section);
		const next =
			CUSTOMIZATION_SURFACES[(index + direction + CUSTOMIZATION_SURFACES.length) % CUSTOMIZATION_SURFACES.length];
		this.#switchSection(next);
	}

	handleInput(keyData: string): void {
		if (this.#wizard) {
			this.#wizard.handleInput(keyData);
			return;
		}
		if (this.#confirmRemove) {
			if (keyData === "y") {
				void this.#confirmRemoveSelected();
			} else {
				this.#confirmRemove = null;
				this.#statusMessage = "remove cancelled";
				this.#refreshChrome();
				this.onRequestRender?.();
			}
			return;
		}
		if (matchesAppInterrupt(keyData)) {
			this.onClose?.();
			return;
		}
		if (matchesKey(keyData, "left")) {
			this.#cycleSection(-1);
			return;
		}
		if (matchesKey(keyData, "right")) {
			this.#cycleSection(1);
			return;
		}
		if (keyData === "s") {
			this.#switchScope();
			return;
		}
		if (keyData === "e") {
			void this.#toggleSelected();
			return;
		}
		if (keyData === "x") {
			this.#beginRemove();
			return;
		}
		if (keyData === "i") {
			this.#openImportWizard();
			return;
		}
		if (keyData === "q") {
			this.onClose?.();
			return;
		}
		this.#lists.get(this.#section)?.handleInput(keyData);
	}

	override render(width: number): string[] {
		// Narrow-terminal guard: keep every chrome line inside the viewport.
		if (width < 24) {
			return [truncateToWidth(theme.fg("muted", "/extensions: terminal too narrow"), width)];
		}
		return super.render(width);
	}
}
