/**
 * ImportWizard — the guided Import-from-Claude-Code/Codex flow inside the
 * `/extensions` dashboard (issue #4291).
 *
 * Steps: source product → source scope → surfaces → collision policy →
 * normalized preview (paged, every entry reviewable) → apply result.
 * Selection lists are attached to the component tree so choices are actually
 * visible; the preview step is explicit-confirmation only — Enter applies
 * once (applying latch), Esc cancels without writing anything. Secret values
 * never appear in any rendered line, and `applied` is reported only when the
 * transaction succeeded. All dynamic text is sanitized before rendering.
 */
import * as os from "node:os";
import { Container, matchesKey, type SelectItem, SelectList, Text } from "@gajae-code/tui";
import { sanitizeText } from "@gajae-code/utils";
import { applyImport, type BuildImportPreviewOptions, buildImportPreview } from "../../../customization/import";
import type {
	CustomizationSurface,
	GjcScope,
	ImportCollisionPolicy,
	ImportPlan,
	ImportPreview,
	ImportProduct,
	ImportResult,
	ImportSourceScope,
} from "../../../customization/types";
import {
	IMPORT_PRODUCTS,
	IMPORT_SOURCE_SCOPES,
	productLabel,
	scopeLabel,
	sourceScopeLabel,
	surfaceLabel,
} from "../../../customization/types";
import { replaceTabs, truncateToWidth } from "../../../tools/render-utils";
import { getSelectListTheme, theme } from "../../theme/theme";
import { matchesAppInterrupt } from "../../utils/keybinding-matchers";
import { DynamicBorder } from "../dynamic-border";

type WizardStep = "product" | "sourceScope" | "surfaces" | "collision" | "preview" | "result";

const SURFACE_CHOICES: Array<{ value: string; label: string; surfaces: CustomizationSurface[] }> = [
	{ value: "all", label: "Skills + Hooks + MCPs", surfaces: ["skills", "hooks", "mcps"] },
	{ value: "skills", label: "Skills only", surfaces: ["skills"] },
	{ value: "hooks", label: "Hooks only", surfaces: ["hooks"] },
	{ value: "mcps", label: "MCPs only", surfaces: ["mcps"] },
];

const COLLISION_CHOICES: Array<{ value: ImportCollisionPolicy; hint: string }> = [
	{ value: "skip", hint: "keep existing .gjc entries; conflicting sources are skipped" },
	{ value: "rename", hint: "conflicting sources import under an -imported suffix" },
	{ value: "overwrite", hint: "replace existing .gjc entries (explicit, never silent)" },
];

const PREVIEW_PAGE_SIZE = 8;

/** Sanitize + detab every dynamic string before it reaches a renderer. */
function safe(text: string): string {
	return replaceTabs(sanitizeText(text));
}

export class ImportWizard extends Container {
	/** Called when the wizard finishes or is cancelled; `applied` is true only when an import succeeded. */
	onClose: ((applied: boolean) => void) | undefined;
	onRequestRender: (() => void) | undefined;

	#cwd: string;
	#homeDir: string;
	#agentDir: string | undefined;
	#destinationScope: GjcScope;
	#step: WizardStep = "product";
	#product: ImportProduct = "claude-code";
	#sourceScope: ImportSourceScope = "project";
	#surfaces: CustomizationSurface[] = ["skills", "hooks", "mcps"];
	#collisionPolicy: ImportCollisionPolicy = "skip";
	#plan: ImportPlan | null = null;
	#result: ImportResult | null = null;
	#applied = false;
	#applying = false;
	#previewPage = 0;

	#headerText: Text;
	#selectContainer: Container;
	#selectList: SelectList | null = null;
	#bodyText: Text;
	#footerText: Text;

	constructor(cwd: string, destinationScope: GjcScope, homeDir?: string, agentDir?: string) {
		super();
		this.#cwd = cwd;
		this.#destinationScope = destinationScope;
		this.#homeDir = homeDir ?? os.homedir();
		this.#agentDir = agentDir;

		this.addChild(new DynamicBorder());
		this.#headerText = new Text("", 0, 0);
		this.addChild(this.#headerText);
		this.addChild(new DynamicBorder());
		this.#selectContainer = new Container();
		this.addChild(this.#selectContainer);
		this.#bodyText = new Text("", 0, 0);
		this.addChild(this.#bodyText);
		this.addChild(new DynamicBorder());
		this.#footerText = new Text("", 0, 0);
		this.addChild(this.#footerText);
		this.addChild(new DynamicBorder());
		this.#renderStep();
	}

	/** Current step (test-visible). */
	get step(): WizardStep {
		return this.#step;
	}

	/** Last built preview DTO — redacted and serialization-safe (test-visible). */
	get preview(): ImportPreview | null {
		return this.#plan?.preview ?? null;
	}

	/** Last apply result (test-visible). */
	get result(): ImportResult | null {
		return this.#result;
	}

	/** Whether the wizard currently shows an attached selection list (test-visible). */
	get hasVisibleSelector(): boolean {
		return this.#selectList !== null;
	}

	#previewOptions(): BuildImportPreviewOptions {
		return {
			product: this.#product,
			sourceScope: this.#sourceScope,
			destinationScope: this.#destinationScope,
			surfaces: this.#surfaces,
			collisionPolicy: this.#collisionPolicy,
			cwd: this.#cwd,
			homeDir: this.#homeDir,
			agentDir: this.#agentDir,
		};
	}

	#setSelectStep(title: string, items: SelectItem[], onSelect: (value: string) => void): void {
		this.#selectContainer.clear();
		const list = new SelectList(items, Math.min(items.length, 8), getSelectListTheme());
		list.onSelect = item => onSelect(item.value);
		list.onCancel = () => this.onClose?.(this.#applied);
		this.#selectList = list;
		this.#selectContainer.addChild(list);
		this.#headerText.setText(theme.bold(theme.fg("accent", title)));
		this.#bodyText.setText("");
		this.#footerText.setText(theme.fg("muted", "↑/↓ navigate · enter select · esc cancel"));
		this.#requestRender();
	}

	#renderStep(): void {
		switch (this.#step) {
			case "product":
				this.#setSelectStep(
					`Import into ${scopeLabel(this.#destinationScope)} — choose source product`,
					IMPORT_PRODUCTS.map(product => ({ value: product, label: productLabel(product) })),
					value => {
						this.#product = value as ImportProduct;
						this.#step = "sourceScope";
						this.#renderStep();
					},
				);
				break;
			case "sourceScope":
				this.#setSelectStep(
					`Import from ${productLabel(this.#product)} — choose source scope`,
					IMPORT_SOURCE_SCOPES.map(scope => ({
						value: scope,
						label: sourceScopeLabel(scope),
						description:
							scope === "user"
								? "explicit selection required; nothing is scanned or injected automatically"
								: "current trusted project convention roots only",
					})),
					value => {
						this.#sourceScope = value as ImportSourceScope;
						this.#step = "surfaces";
						this.#renderStep();
					},
				);
				break;
			case "surfaces":
				this.#setSelectStep(
					"Choose surfaces to import",
					SURFACE_CHOICES.map(choice => ({ value: choice.value, label: choice.label })),
					value => {
						this.#surfaces = SURFACE_CHOICES.find(choice => choice.value === value)?.surfaces ?? this.#surfaces;
						this.#step = "collision";
						this.#renderStep();
					},
				);
				break;
			case "collision":
				this.#setSelectStep(
					"Collision policy for existing .gjc entries",
					COLLISION_CHOICES.map(choice => ({
						value: choice.value,
						label: choice.value,
						description: choice.hint,
					})),
					value => {
						this.#collisionPolicy = value as ImportCollisionPolicy;
						void this.#buildPreview();
					},
				);
				break;
			case "preview":
			case "result":
				break;
		}
	}

	async #buildPreview(): Promise<void> {
		this.#selectContainer.clear();
		this.#selectList = null;
		this.#headerText.setText(theme.fg("muted", "Reading source configuration…"));
		this.#requestRender();
		this.#plan = await buildImportPreview(this.#previewOptions());
		this.#previewPage = 0;
		this.#step = "preview";
		this.#renderPreview();
	}

	#previewPageCount(): number {
		const total = this.#plan?.preview.entries.length ?? 0;
		return Math.max(1, Math.ceil(total / PREVIEW_PAGE_SIZE));
	}

	#renderPreview(): void {
		const plan = this.#plan;
		if (!plan) return;
		const { preview } = plan;
		const writable = preview.entries.filter(
			e => e.status === "add" || e.status === "overwrite" || e.status === "redacted",
		);
		const skipped = preview.entries.filter(e => e.status === "conflict" || e.status === "unsupported");
		const pageCount = this.#previewPageCount();
		const page = Math.min(this.#previewPage, pageCount - 1);
		const pageEntries = preview.entries.slice(page * PREVIEW_PAGE_SIZE, (page + 1) * PREVIEW_PAGE_SIZE);

		const lines: string[] = [];
		lines.push(
			`${theme.bold("Preview:")} ${productLabel(preview.product)} ${sourceScopeLabel(preview.sourceScope)} → ${scopeLabel(preview.destinationScope)} · policy: ${this.#collisionPolicy}`,
		);
		lines.push("");
		if (preview.entries.length === 0) {
			lines.push(theme.fg("muted", "(nothing found to import at the selected source)"));
		}
		for (const entry of pageEntries) {
			const statusColor =
				entry.status === "add"
					? theme.fg("success", "+")
					: entry.status === "overwrite"
						? theme.fg("warning", "!")
						: entry.status === "redacted"
							? theme.fg("accent", "+")
							: theme.fg("muted", "-");
			const name =
				entry.destinationName === entry.sourceName
					? entry.sourceName
					: `${entry.sourceName} → ${entry.destinationName}`;
			lines.push(
				` ${statusColor} ${surfaceLabel(entry.surface)}: ${safe(name)}${entry.reason ? theme.fg("muted", ` — ${safe(entry.reason)}`) : ""}`,
			);
		}
		for (const warning of preview.warnings.slice(0, 3)) {
			lines.push(theme.fg("warning", ` ⚠ ${safe(warning)}`));
		}
		if (preview.warnings.length > 3) {
			lines.push(theme.fg("muted", ` … ${preview.warnings.length - 3} more diagnostics`));
		}
		this.#headerText.setText(theme.bold(theme.fg("accent", "Confirm import")));
		this.#bodyText.setText(lines.join("\n"));
		const paging = pageCount > 1 ? `←/→ page ${page + 1}/${pageCount} · ` : "";
		this.#footerText.setText(
			theme.fg(
				"muted",
				`${paging}enter: apply ${writable.length} entr${writable.length === 1 ? "y" : "ies"} (${skipped.length} skipped) · esc: cancel (no writes)`,
			),
		);
		this.#requestRender();
	}

	async #apply(): Promise<void> {
		if (!this.#plan || this.#applying) return;
		this.#applying = true;
		this.#footerText.setText(theme.fg("muted", "Applying import…"));
		this.#requestRender();
		try {
			this.#result = await applyImport(this.#plan, { cwd: this.#cwd });
		} catch (error) {
			this.#result = {
				entries: [
					{
						surface: "skills",
						sourceName: "",
						destinationName: "",
						outcome: "failed",
						reason: (error as Error).message,
					},
				],
				ok: false,
			};
		} finally {
			this.#applying = false;
		}
		this.#applied = this.#result.ok;
		this.#step = "result";
		const counts = new Map<string, number>();
		for (const entry of this.#result.entries) {
			counts.set(entry.outcome, (counts.get(entry.outcome) ?? 0) + 1);
		}
		const summary = [...counts.entries()].map(([outcome, count]) => `${count} ${outcome}`).join(", ");
		this.#headerText.setText(
			this.#result.ok
				? theme.bold(theme.fg("success", "Import complete"))
				: theme.bold(theme.fg("error", "Import failed — rolled back, no partial import")),
		);
		const failed = this.#result.entries.filter(e => e.outcome === "failed").slice(0, 5);
		this.#bodyText.setText(
			[
				summary,
				"",
				...failed.map(e => theme.fg("error", ` ✗ ${e.surface}: ${safe(e.sourceName)} — ${safe(e.reason ?? "")}`)),
				...(this.#result.ok
					? [theme.fg("muted", "Imported entries take effect after the documented reload/new-session boundary.")]
					: []),
			].join("\n"),
		);
		this.#footerText.setText(theme.fg("muted", "enter/esc: close"));
		this.#requestRender();
	}

	#requestRender(): void {
		this.onRequestRender?.();
	}

	handleInput(keyData: string): void {
		if (matchesAppInterrupt(keyData)) {
			if (this.#applying) return; // never interrupt an in-flight transaction
			this.onClose?.(this.#applied);
			return;
		}
		if (this.#step === "preview") {
			if (matchesKey(keyData, "left") || matchesKey(keyData, "right")) {
				const pageCount = this.#previewPageCount();
				const delta = matchesKey(keyData, "right") ? 1 : -1;
				this.#previewPage = (this.#previewPage + delta + pageCount) % pageCount;
				this.#renderPreview();
				return;
			}
			if (keyData === "\r" || keyData === "\n") {
				void this.#apply();
			}
			return;
		}
		if (this.#step === "result") {
			this.onClose?.(this.#applied);
			return;
		}
		this.#selectList?.handleInput(keyData);
	}

	override render(width: number): string[] {
		if (width < 24) {
			return [truncateToWidth(theme.fg("muted", "import: terminal too narrow"), width)];
		}
		return super.render(width);
	}
}
