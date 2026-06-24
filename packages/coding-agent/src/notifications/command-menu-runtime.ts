/**
 * Session-side runtime for the Telegram `/menu` button surface.
 */

import {
	makeSyntheticActionId,
	type PendingMenuAction,
	type SyntheticActionKind,
	TOP_LEVEL_MENU,
} from "./command-menu";
import { isAllowedSkillInvocation, type MenuCategory } from "./command-policy";

/** A model option shown in the picker. */
export interface ModelOption {
	ref: string;
	label: string;
	current?: boolean;
}

/** Result of switching the temporary model, for user feedback. */
export interface ModelSwitchResult {
	previous?: string;
	next: string;
}

/** Injected session capabilities + side effects. */
export interface MenuRuntimeDeps {
	/** Skill ids the session exposes (already filtered to non-hidden). */
	allowedSkillIds(): string[];
	/** Recent models (current marked) for the picker, most-recent first. */
	recentModels(): ModelOption[];
	/** Register an answerable synthetic ask (maps to server.registerAsk). `options` empty = force-reply text ask. */
	registerAsk(id: string, question: string, options: string[]): void;
	/** Post a plain result/guidance message into the session thread. */
	postMessage(text: string): void;
	/** Run a skill with the collected prompt (maps to the shared text-mode executor). */
	runSkill(skillName: string, prompt: string): Promise<void>;
	/** Switch only the current session's temporary model. */
	setModelTemporary(ref: string): Promise<ModelSwitchResult>;
}

/** Outcome of routing a reply, for the caller to resolve/reject the native action. */
export type MenuReplyOutcome =
	| { kind: "resolved" }
	| { kind: "rejected"; reason: string }
	| { kind: "not_menu_action" };

export class CommandMenuRuntime {
	private readonly pending = new Map<string, PendingMenuAction>();
	/** Skill awaiting the user's free-text prompt (not a registered ask). */
	private pendingSkillPrompt: string | undefined;

	constructor(private readonly deps: MenuRuntimeDeps) {}

	/** True when `actionId` belongs to this runtime's pending registry. */
	owns(actionId: string): boolean {
		return this.pending.has(actionId);
	}

	private register(kind: SyntheticActionKind, action: PendingMenuAction, question: string, options: string[]): string {
		const id = makeSyntheticActionId(kind);
		this.pending.set(id, action);
		this.deps.registerAsk(id, question, options);
		return id;
	}

	/** Open the top-level Skills/Model/Notify menu. Returns the action id. */
	openTopLevelMenu(): string {
		const categories = TOP_LEVEL_MENU.map(e => e.category);
		return this.register(
			"menu",
			{ type: "menu", optionCategories: categories },
			"Commands",
			TOP_LEVEL_MENU.map(e => e.label),
		);
	}

	private openSkillsSubmenu(): void {
		const skills = this.deps.allowedSkillIds();
		if (skills.length === 0) {
			this.deps.postMessage("No skills are available for this session.");
			return;
		}
		this.register("submenu", { type: "submenu", category: "skills", optionIds: skills }, "Skills", skills);
	}

	private openModelPicker(): void {
		const models = this.deps.recentModels();
		if (models.length === 0) {
			this.deps.postMessage("No recent models to choose from yet.");
			return;
		}
		const labels = models.map(m => (m.current ? `${m.label} (current)` : m.label));
		this.register("model", { type: "model", modelRefs: models.map(m => m.ref) }, "Recent models", labels);
	}

	private openSkillPrompt(skillName: string): void {
		this.pendingSkillPrompt = skillName;
		this.deps.postMessage(`Enter the prompt for /skill:${skillName}, then send it as your next message.`);
	}

	/** Consume the next free-text message as a pending skill prompt, if any. */
	async consumePendingSkillPrompt(text: string): Promise<boolean> {
		const skillName = this.pendingSkillPrompt;
		if (!skillName) return false;
		this.pendingSkillPrompt = undefined;

		const prompt = text.trim();
		if (!prompt) {
			this.deps.postMessage("Empty prompt; skill not run. Send /menu to try again.");
			return true;
		}

		try {
			await this.deps.runSkill(skillName, prompt);
		} catch (e) {
			this.deps.postMessage(`Skill run failed: ${e instanceof Error ? e.message : String(e)}`);
		}
		return true;
	}

	/** True when the runtime is waiting for the user's skill-prompt free text. */
	get hasPendingSkillPrompt(): boolean {
		return this.pendingSkillPrompt !== undefined;
	}

	private handleCategory(category: MenuCategory): MenuReplyOutcome {
		switch (category) {
			case "skills":
				this.openSkillsSubmenu();
				return { kind: "resolved" };
			case "model":
				this.openModelPicker();
				return { kind: "resolved" };
			case "notify":
				this.deps.postMessage("Notify: send /notify status, /notify on, or /notify off.");
				return { kind: "resolved" };
		}
	}

	/**
	 * Route a reply to a synthetic action. `answer` is the chosen option index
	 * (number) for option asks, or free text (string) for a skill prompt.
	 * Returns `not_menu_action` when the id is not ours so the caller can fall
	 * through to real ask/gate handling.
	 */
	async handleReply(actionId: string, answer: number | string): Promise<MenuReplyOutcome> {
		const action = this.pending.get(actionId);
		if (!action) return { kind: "not_menu_action" };
		// Consume the action; selecting opens follow-ups which register fresh ids.
		this.pending.delete(actionId);
		switch (action.type) {
			case "menu": {
				const index = typeof answer === "number" ? answer : Number.parseInt(String(answer), 10);
				const category = action.optionCategories[index];
				if (category === undefined) return { kind: "rejected", reason: "unknown menu option" };
				return this.handleCategory(category);
			}
			case "submenu": {
				const index = typeof answer === "number" ? answer : Number.parseInt(String(answer), 10);
				const skillName = action.optionIds[index];
				if (skillName === undefined) return { kind: "rejected", reason: "unknown submenu option" };
				if (action.category === "skills") {
					if (!isAllowedSkillInvocation(skillName, this.deps.allowedSkillIds())) {
						return { kind: "rejected", reason: "skill is not allowed" };
					}
					this.openSkillPrompt(skillName);
				}
				return { kind: "resolved" };
			}
			case "model": {
				const index = typeof answer === "number" ? answer : Number.parseInt(String(answer), 10);
				const ref = action.modelRefs[index];
				if (ref === undefined) return { kind: "rejected", reason: "unknown model option" };
				try {
					const result = await this.deps.setModelTemporary(ref);
					const prev = result.previous ?? "(unset)";
					this.deps.postMessage(`Model: ${prev} → ${result.next} (this session only)`);
					return { kind: "resolved" };
				} catch (e) {
					return {
						kind: "rejected",
						reason: `model switch failed: ${e instanceof Error ? e.message : String(e)}`,
					};
				}
			}
		}
	}
}
