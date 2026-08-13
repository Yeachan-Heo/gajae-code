/**
 * Master-mode session-start hook: an internal inline extension registered only
 * for master sessions. On `session_start` it injects (a) the SDK supervision
 * usage guidelines and (b) a bounded snapshot of the current resident-session
 * inventory from the authoritative SDK broker, so the master session begins
 * with supervision context instead of a cold start.
 *
 * The hook never throws into session startup: when the broker is unavailable
 * the injection fails closed — the guidelines are still delivered alongside an
 * explicit "inventory unavailable" notice, and no session action is taken.
 */
import { logger } from "@gajae-code/utils";
import type { ExtensionFactory } from "../extensibility/extensions/types";
import { loadResidentSessionInventory, type ResidentSessionInventory, renderInventoryMarkdown } from "./inventory";
import sdkSupervisionGuidance from "./sdk-supervision-guidance.md" with { type: "text" };

/** Custom-message type used for the master-mode session-start injection. */
export const MASTER_SESSION_CONTEXT_CUSTOM_TYPE = "master-supervision-context";

export interface MasterModeExtensionDeps {
	/** SDK broker state directory the inventory is read from. */
	agentDir: string;
	/** Test seam: overrides the broker-backed inventory loader. */
	loadInventory?: (agentDir: string) => Promise<ResidentSessionInventory>;
	/** Test seam: clock used for classification and rendering. */
	now?: () => number;
}

/** Compose the session-start injection body (guidance + bounded inventory). */
export async function composeMasterSessionStartContent(
	deps: MasterModeExtensionDeps,
	selfSessionId?: string,
): Promise<string> {
	const guidance = sdkSupervisionGuidance.trim();
	const load = deps.loadInventory ?? loadResidentSessionInventory;
	const now = deps.now ?? Date.now;
	let inventorySection: string;
	try {
		const inventory = await load(deps.agentDir);
		inventorySection = renderInventoryMarkdown(inventory, selfSessionId, now());
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		inventorySection = [
			"Resident-session inventory is UNAVAILABLE: the SDK broker snapshot could not be loaded",
			`(${reason}). Fail closed: do not prompt, steer, answer, or retire any session until`,
			"`gjc sdk session list` succeeds and you hold a fresh authoritative inventory.",
		].join(" ");
	}
	return [
		"# Master mode session-start context",
		"",
		guidance,
		"",
		"## Current resident sessions (authoritative broker snapshot)",
		"",
		inventorySection,
	].join("\n");
}

/**
 * Internal extension factory for master sessions. Registers the session-start
 * hook that injects the SDK usage guidelines plus the current resident-session
 * inventory as a hidden (display:false) context message without starting a turn.
 */
export function createMasterModeExtension(deps: MasterModeExtensionDeps): ExtensionFactory {
	return api => {
		api.on("session_start", async (_event, ctx) => {
			try {
				const selfSessionId = ctx.sessionManager.getSessionId() || undefined;
				const content = await composeMasterSessionStartContent(deps, selfSessionId);
				api.sendMessage(
					{
						customType: MASTER_SESSION_CONTEXT_CUSTOM_TYPE,
						content,
						display: false,
						attribution: "agent",
					},
					{ triggerTurn: false },
				);
			} catch (error) {
				// The session-start hook must never break session startup.
				logger.warn("Master-mode session-start injection failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});
	};
}
