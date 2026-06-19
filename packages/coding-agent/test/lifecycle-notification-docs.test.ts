import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");

async function readRepoFile(...segments: string[]): Promise<string> {
	return await Bun.file(path.join(repoRoot, ...segments)).text();
}

describe("lifecycle notification docs", () => {
	it("documents the public opt-in lifecycle notification surface", async () => {
		const readme = await readRepoFile("packages", "coding-agent", "README.md");

		expect(readme).toContain("## External lifecycle notifications");
		expect(readme).toContain("`turn_end` — a model/tool turn finished");
		expect(readme).toContain("`agent_end` — the agent loop for a submitted prompt reached a terminal boundary");
		expect(readme).toContain('type: "turn_end"');
		expect(readme).toContain('type: "agent_end"');
		expect(readme).toContain('status: "finished" | "stopped" | "failed" | "blocked" | "waiting"');
		expect(readme).toContain("Current lifecycle events do not expose a separate structured waiting/blocked reason");
		expect(readme).toContain("Discord/Hermes/clawhip");
		expect(readme).toContain("opt-in");
		expect(readme).toContain("disabled unless the user configures an extension/hook handler");
	});

	it("keeps lifecycle notification guidance public-safe", async () => {
		const readme = await readRepoFile("packages", "coding-agent", "README.md");
		const section = readme.slice(
			readme.indexOf("## External lifecycle notifications"),
			readme.indexOf("## Memory backends"),
		);

		expect(section).toContain("Do not include raw prompts");
		expect(section).toContain("assistant transcripts");
		expect(section).toContain("hidden prompts");
		expect(section).toContain("tool outputs");
		expect(section).toContain("raw logs");
		expect(section).toContain("host paths");
		expect(section).toContain("webhook URLs");
		expect(section).toContain("channel IDs");
		expect(section).toContain("tokens, or secrets");
		expect(section).toContain("summary: string");
		expect(section).not.toContain("https://discord.com/api/webhooks/");
		expect(section).not.toContain("WEBHOOK_URL=");
		expect(section).not.toContain("channel_id");
	});
});
