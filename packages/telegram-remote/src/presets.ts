/**
 * Preset-only session model. A preset binds a fixed workdir + fixed session
 * command + optional fixed task template. The single chat-supplied value is a
 * task string, which is length-capped and control-char-stripped before it is
 * substituted into the one `{{task}}` slot (docs/telegram-remote.md).
 */
import type { GatewayPreset } from "./types";

/** The single substitution token allowed in a preset task template. */
export const TASK_SLOT = "{{task}}";

export function presetName(preset: GatewayPreset): string {
	return preset.name?.trim() || preset.id;
}

/** Outcome of resolving a chat-supplied preset id + task into a prompt. */
export type PresetResolution =
	| { ok: true; preset: GatewayPreset; prompt: string | undefined }
	| { ok: false; reason: "unknown_preset" | "task_too_long" };

/**
 * Strip control characters (C0/C1 except nothing) and collapse the result to a
 * single trimmed line. Telegram task text must never carry terminal control
 * sequences into a prompt.
 */
export function sanitizeTask(raw: string): string {
	const stripped = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
	return stripped.replace(/\s+/g, " ").trim();
}

/**
 * Resolve a preset id and raw task string into the prompt passed to the
 * coordinator. Returns a typed rejection for unknown presets and over-length
 * tasks; never derives workdir or command from chat input.
 */
export function resolvePreset(
	presets: ReadonlyMap<string, GatewayPreset>,
	presetId: string,
	rawTask: string | null,
): PresetResolution {
	const preset = presets.get(presetId);
	if (!preset) {
		return { ok: false, reason: "unknown_preset" };
	}

	// No template: the task argument is ignored. The session starts with no prompt.
	if (!preset.taskTemplate) {
		return { ok: true, preset, prompt: undefined };
	}

	const task = sanitizeTask(rawTask ?? "");
	if (task.length > preset.taskMaxLen) {
		return { ok: false, reason: "task_too_long" };
	}

	// Single-slot substitution. `replace` with a string pattern replaces only the
	// first occurrence, and a malicious task cannot inject a second slot because
	// the task is the replacement value, not the pattern.
	const prompt = preset.taskTemplate.replace(TASK_SLOT, task);
	return { ok: true, preset, prompt };
}

/**
 * Validate a preset definition at config time. Throws on structural problems
 * so misconfiguration fails fast instead of at the first chat command.
 */
export function assertValidPreset(preset: GatewayPreset): void {
	if (!preset.id || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,63}$/.test(preset.id)) {
		throw new Error(`telegram_remote_invalid_preset_id:${preset.id}`);
	}
	if (!preset.workdir?.startsWith("/")) {
		throw new Error(`telegram_remote_preset_workdir_must_be_absolute:${preset.id}`);
	}
	if (!preset.sessionCommand || preset.sessionCommand.trim().length === 0) {
		throw new Error(`telegram_remote_preset_session_command_required:${preset.id}`);
	}
	if (preset.taskTemplate !== undefined) {
		const slotCount = preset.taskTemplate.split(TASK_SLOT).length - 1;
		if (slotCount !== 1) {
			throw new Error(`telegram_remote_preset_task_template_needs_one_slot:${preset.id}`);
		}
	}
	if (!Number.isInteger(preset.taskMaxLen) || preset.taskMaxLen <= 0) {
		throw new Error(`telegram_remote_preset_task_max_len_invalid:${preset.id}`);
	}
}
