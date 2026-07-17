import * as path from "node:path";
import { ProcessTerminal, TUI } from "@gajae-code/tui";
import { pathIsWithin } from "@gajae-code/utils";
import { type SessionSelectionResult, SessionSelectorComponent } from "../modes/components/session-selector";
import { type SessionInfo, SessionManager } from "../session/session-manager";
import { FileSessionStorage } from "../session/session-storage";

export async function deleteSessionPickerCandidate(sessionPath: string, explicitSessionDir?: string): Promise<void> {
	if (!explicitSessionDir) {
		await SessionManager.deleteManagedCandidate(sessionPath);
		return;
	}
	const root = path.resolve(explicitSessionDir);
	const target = path.resolve(sessionPath);
	if (!pathIsWithin(root, target))
		throw new Error("Explicit session deletion escaped the configured session directory.");
	await new FileSessionStorage().deleteSessionWithArtifacts(target);
}

/** Show the read-only TUI session picker and return the user's consent intent. */
export async function selectSession(
	sessions: SessionInfo[],
	explicitSessionDir?: string,
): Promise<SessionSelectionResult> {
	const { promise, resolve } = Promise.withResolvers<SessionSelectionResult>();
	const ui = new TUI(new ProcessTerminal());

	let settled = false;
	const settle = (selection: SessionSelectionResult): void => {
		if (settled) return;
		settled = true;
		ui.stop();
		resolve(selection);
	};
	const selector = new SessionSelectorComponent(
		sessions,
		() => {},
		() => settle({ kind: "cancelled" }),
		() => settle({ kind: "cancelled" }),
		async session => {
			await deleteSessionPickerCandidate(session.path, explicitSessionDir);
			return true;
		},
		SessionManager.inspectSessionTailReadOnly,
		settle,
	);
	selector.setOnRequestRender(() => ui.requestRender());
	ui.addChild(selector);
	ui.setFocus(selector);
	ui.start();
	return promise;
}
