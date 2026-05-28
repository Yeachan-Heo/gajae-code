import { Command } from "@gajae-code/utils/cli";
import { syncSkillActiveState } from "../skill-state/active-state";
import { runGjcRuntimeBridgeWithHudSidecar } from "./gjc-runtime-bridge";

export default class Ralplan extends Command {
	static description = "Run private GJC RALPLAN workflow commands";
	static strict = false;
	static examples = ["$ gjc ralplan --help"];

	async run(): Promise<void> {
		const cwd = process.cwd();
		const result = await runGjcRuntimeBridgeWithHudSidecar("ralplan", this.argv, {
			cwd,
			sidecarSkill: "ralplan",
			onHudPayload: payload =>
				syncSkillActiveState({
					cwd,
					skill: "ralplan",
					active: payload.active ?? true,
					phase: payload.phase,
					sessionId: payload.session_id,
					threadId: payload.thread_id,
					turnId: payload.turn_id,
					hud: payload.hud,
					source: "gjc-runtime-bridge",
				}),
		});
		if (result.error) process.stderr.write(`${result.error}\n`);
		process.exitCode = result.status;
	}
}
