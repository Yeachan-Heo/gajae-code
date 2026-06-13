import { Args, Command, Flags } from "@gajae-code/utils/cli";
import {
	attachGjcTmuxSession,
	createGjcTmuxSession,
	listGjcTmuxSessions,
	removeGjcTmuxSession,
	statusGjcTmuxSession,
} from "../gjc-runtime/tmux-sessions";

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeText(lines: string[]): void {
	process.stdout.write(`${lines.join("\n")}\n`);
}

function writeJsonFailure(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	const [reason = "session_error"] = message.split(":");
	const hintIndex = message.indexOf(" — ");
	const detail = hintIndex >= 0 ? message.slice(hintIndex + " — ".length).trim() : "";
	writeJson(detail ? { ok: false, reason, detail } : { ok: false, reason });
}

interface SessionJsonDto {
	name: string;
	attached: boolean;
	windows: number;
	panes: number;
	bindings: string;
	createdAt: string;
}

function sessionJson(session: SessionJsonDto): SessionJsonDto {
	return {
		name: session.name,
		attached: session.attached,
		windows: session.windows,
		panes: session.panes,
		bindings: session.bindings,
		createdAt: session.createdAt,
	};
}

export default class Session extends Command {
	static description = "List, inspect, attach, and remove tagged GJC-managed tmux sessions";
	static strict = false;

	static args = {
		action: Args.string({
			description: "list (default), status, create, attach, or remove",
			required: false,
		}),
		session: Args.string({
			description: "Session name for status, attach, or remove",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON", default: false }),
	};

	static examples = [
		"gjc session list",
		"gjc session create",
		"gjc session status <session>",
		"gjc session attach <session>",
		"gjc session remove <session>",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Session);
		const action = args.action ?? "list";
		const sessionName = args.session;
		const json = flags.json ?? false;
		try {
			if (action === "list") {
				const sessions = listGjcTmuxSessions();
				if (json) {
					writeJson({ ok: true, sessions: sessions.map(sessionJson) });
					return;
				}
				writeText(
					sessions.map(session =>
						[
							session.name,
							`windows=${session.windows}`,
							`attached=${session.attached}`,
							`createdAt=${session.createdAt}`,
							`panes=${session.panes}`,
							`bindings=${session.bindings || "none"}`,
						].join("\t"),
					),
				);
				return;
			}

			if (action === "create") {
				const session = createGjcTmuxSession();
				if (json) {
					writeJson({ ok: true, session: sessionJson(session) });
					return;
				}
				writeText([`created: ${session.name}`]);
				return;
			}

			if (!sessionName) throw new Error("missing_session_name");

			if (action === "status") {
				const session = statusGjcTmuxSession(sessionName);
				if (json) {
					writeJson({ ok: true, session: sessionJson(session) });
					return;
				}
				writeText([
					`session: ${session.name}`,
					`windows: ${session.windows}`,
					`attached: ${session.attached}`,
					`createdAt: ${session.createdAt}`,
					`panes: ${session.panes}`,
					`bindings: ${session.bindings || "none"}`,
				]);
				return;
			}

			if (action === "remove" || action === "rm" || action === "delete") {
				const removed = removeGjcTmuxSession(sessionName);
				if (json) {
					writeJson({ ok: true, session: sessionJson(removed) });
					return;
				}
				writeText([`removed: ${removed.name}`]);
				return;
			}

			if (action === "attach") {
				attachGjcTmuxSession(sessionName);
				return;
			}
			throw new Error(`unknown_session_action:${action}`);
		} catch (error) {
			if (json) {
				writeJsonFailure(error);
				return;
			}
			throw error;
		}
	}
}
