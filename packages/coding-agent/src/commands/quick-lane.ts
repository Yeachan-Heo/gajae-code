/**
 * Quick-lane task classification (issue #3984).
 *
 * Read-only classification surface for the quick lane: prints whether a task
 * request is eligible for the quick lane (bounded, direct execution) or must
 * keep the existing deep path (planning/interview). This performs no routing
 * and mutates nothing — it only exposes the deterministic classifier so task
 * classification can be inspected, audited, and consumed by tooling.
 */
import { Args, Command, Flags } from "@gajae-code/utils/cli";
import { classifyQuickLane } from "../quick-lane/classify";

export default class QuickLane extends Command {
	static description =
		"Classify a task into the quick lane (bounded, direct execution) or the deep path (planning/interview)";

	static args = {
		action: Args.string({ description: "Action", required: true, options: ["classify"] }),
		text: Args.string({ description: "Task text", required: true, multiple: true }),
	};

	static flags = {
		json: Flags.boolean({ description: "Output the decision as JSON" }),
	};

	static examples = [
		`$ gjc quick-lane classify "add validation to processKeywordDetector"`,
		`$ gjc quick-lane classify --json "fix src/hooks/bridge.ts"`,
		`$ gjc quick-lane classify "autoresearch the caching layer"`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(QuickLane);
		const text = (Array.isArray(args.text) ? args.text.join(" ") : (args.text ?? "")).trim();
		const decision = classifyQuickLane(text);

		if (flags.json) {
			process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
			return;
		}

		const lines = [`lane: ${decision.lane}`];
		if (decision.reasons.length > 0) {
			lines.push(`reasons:\n${decision.reasons.map(reason => `  - ${reason}`).join("\n")}`);
		}
		if (decision.exclusions.length > 0) {
			lines.push(`exclusions:\n${decision.exclusions.map(exclusion => `  - ${exclusion}`).join("\n")}`);
		}
		process.stdout.write(`${lines.join("\n")}\n`);
	}
}
