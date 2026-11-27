import * as path from "node:path";
import { ProcessTerminal, Spacer, TUI } from "@gajae-code/tui";
import { pathIsWithin } from "@gajae-code/utils";
import { createHeldSessionWarning, type HeldSessionChoice } from "../modes/components/session-held-warning";
import {
	type HeldSessionCheck,
	type SessionSelectionResult,
	SessionSelectorComponent,
} from "../modes/components/session-selector";
import { resolveSessionOwnership, withScopedSessionClaim } from "../session/internal/session-claim-set";
import { type SessionInfo, SessionManager } from "../session/session-manager";
import type { SessionHeldError } from "../session/session-ownership";
import { FileSessionStorage } from "../session/session-storage";

/** The bare picker runs before the process surface is set: its scoped claims name the terminal. */
const PICKER_OWNERSHIP = { surface: "terminal" } as const;

export async function deleteSessionPickerCandidate(
	session: Pick<SessionInfo, "id" | "path">,
	explicitSessionDir?: string,
): Promise<void> {
	if (!explicitSessionDir) {
		await SessionManager.deleteManagedCandidate(session.path, PICKER_OWNERSHIP);
		return;
	}
	const root = path.resolve(explicitSessionDir);
	const target = path.resolve(session.path);
	if (!pathIsWithin(root, target))
		throw new Error("Explicit session deletion escaped the configured session directory.");
	await withScopedSessionClaim(resolveSessionOwnership(PICKER_OWNERSHIP), session.id, "delete", () =>
		new FileSessionStorage().deleteSessionWithArtifacts(target),
	);
}

/**
 * The held-session warning before the TUI starts (design §3.1), as a one-shot TUI like the picker:
 * resolves once Fork or Cancel is chosen and the terminal is handed back.
 */
export async function promptHeldSession(error: SessionHeldError): Promise<HeldSessionChoice> {
	const { promise, resolve } = Promise.withResolvers<HeldSessionChoice>();
	const ui = new TUI(new ProcessTerminal());
	let settled = false;
	const warning = createHeldSessionWarning(error, choice => {
		if (settled) return;
		settled = true;
		// As in `selectSession`: finish the stdin dispatch before detaching, then resolve.
		setImmediate(() => {
			ui.stop();
			resolve(choice);
		});
	});
	// As the picker does: one blank row first, so the frame starts below the launch's `> ` line.
	ui.addChild(new Spacer(1));
	ui.addChild(warning);
	ui.setFocus(warning);
	ui.start();
	return promise;
}

/**
 * Show the session picker and return the user's resume consent intent. Under enforce, `held` marks
 * the rows other processes hold and choosing one shows the held-session warning (design §1 row 2).
 */
export async function selectSession(
	sessions: SessionInfo[],
	explicitSessionDir?: string,
	held?: { readonly sessions: ReadonlyMap<string, SessionHeldError>; readonly check: HeldSessionCheck },
): Promise<SessionSelectionResult> {
	const { promise, resolve } = Promise.withResolvers<SessionSelectionResult>();
	const ui = new TUI(new ProcessTerminal());

	let settled = false;
	const settle = (selection: SessionSelectionResult): void => {
		if (settled) return;
		settled = true;
		// Let the stdin dispatch finish before detaching its reader/raw mode.
		// A microtask is still inside that dispatch on Bun/Windows and can leave
		// the next TUI without input. Resolve only after teardown so it cannot
		// pause or restore the terminal underneath the next TUI's startup.
		setImmediate(() => {
			ui.stop();
			resolve(selection);
		});
	};
	const selector = new SessionSelectorComponent(
		sessions,
		() => {},
		() => settle({ kind: "cancelled" }),
		() => settle({ kind: "cancelled" }),
		async session => {
			await deleteSessionPickerCandidate(session, explicitSessionDir);
			return true;
		},
		SessionManager.inspectSessionTailReadOnly,
		settle,
		(session, starred) =>
			SessionManager.setSessionStarredForPicker(session, starred, explicitSessionDir, PICKER_OWNERSHIP),
	);
	selector.setOnRequestRender(() => ui.requestRender());
	if (held) selector.setHeldSessions(held.sessions, held.check);
	ui.addChild(selector);
	ui.setFocus(selector);
	ui.start();
	return promise;
}
