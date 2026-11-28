import { describe, expect, it } from "bun:test";
import { fuzzyFilter } from "@gajae-code/tui";

interface Model {
	id: string;
	provider: string;
}

interface Session {
	id: string;
	title?: string;
	cwd?: string;
	firstMessage?: string;
	recap?: string;
	allMessagesText: string;
	path: string;
}

function generateModels(count: number): Model[] {
	const providers = ["anthropic", "openai", "google", "claude", "gemini"];
	const models: Model[] = [];
	for (let i = 0; i < count; i++) {
		models.push({
			id: `model-${i % 100}-v${Math.floor(i / 100)}`,
			provider: providers[i % providers.length],
		});
	}
	return models;
}

function generateSessions(count: number): Session[] {
	const sessions: Session[] = [];
	for (let i = 0; i < count; i++) {
		sessions.push({
			id: `session-${i}`,
			title: `Session Title ${i}: some descriptive text`,
			cwd: `/home/user/project-${i % 50}/src`,
			firstMessage: `First message of session ${i}`,
			recap: `AI recap of session ${i}: summary of work done`,
			allMessagesText: `Message ${i} Message ${i + 1} Message ${i + 2}`,
			path: `/home/user/.gjc/sessions/session-${i}.json`,
		});
	}
	return sessions;
}

describe("selector performance", () => {
	it("should measure model fuzzy filter performance (300 models)", () => {
		const models = generateModels(300);
		const queries = ["claude", "pro", "sonnet", "opus", "vision"];

		const start = performance.now();
		for (let keystroke = 0; keystroke < 10; keystroke++) {
			for (const query of queries) {
				const text = `${query}${keystroke}`;
				fuzzyFilter(models, text, m => `${m.id} ${m.provider}`);
			}
		}
		const duration = performance.now() - start;
		console.log(`Model filtering (300 models, 50 keystrokes): ${duration.toFixed(2)}ms`);
		expect(duration).toBeLessThan(500); // Should be very fast
	});

	it("should measure session fuzzy filter performance (2000 sessions)", () => {
		const sessions = generateSessions(2000);

		// Simulate the current approach: rebuilding search text on each keystroke
		// User types: "p" -> "pr" -> "pro" -> "proj" -> "proje" -> "project"
		const queries = ["p", "pr", "pro", "proj", "proje", "project"];
		const start = performance.now();
		for (let round = 0; round < 10; round++) {
			for (const query of queries) {
				fuzzyFilter(sessions, query, session =>
					[
						session.id,
						session.title ?? "",
						session.cwd ?? "",
						session.firstMessage ?? "",
						session.recap ?? "",
						session.allMessagesText,
						session.path,
					]
						.filter(Boolean)
						.join(" "),
				);
			}
		}
		const duration = performance.now() - start;
		console.log(`Session filtering (2000 sessions, 60 realistic keystrokes): ${duration.toFixed(2)}ms`);
		console.log(`Per keystroke: ${(duration / 60).toFixed(2)}ms`);
		// This is where the lag happens - should be much faster after fix
		expect(duration).toBeLessThan(500); // Should be <8ms per keystroke
	});

	it("should measure model filter with many keystroke sequences", () => {
		const models = generateModels(300);
		const start = performance.now();

		// Simulate typing "vision" 100 times
		const queries = ["v", "vi", "vis", "visi", "visio", "vision"];
		for (let i = 0; i < 100; i++) {
			for (const query of queries) {
				fuzzyFilter(models, query, m => `${m.id} ${m.provider}`);
			}
		}
		const duration = performance.now() - start;
		console.log(`Model filtering (300 models, 600 keystrokes): ${duration.toFixed(2)}ms`);
		console.log(`Per keystroke: ${(duration / 600).toFixed(3)}ms`);
		expect(duration).toBeLessThan(300); // Should be <0.5ms per keystroke
	});

	it("should measure session filter with many keystroke sequences", () => {
		const sessions = generateSessions(2000);
		const start = performance.now();

		// Simulate typing "resume"
		const queries = ["r", "re", "res", "resu", "resum", "resume"];
		for (let i = 0; i < 100; i++) {
			for (const query of queries) {
				fuzzyFilter(sessions, query, session =>
					[
						session.id,
						session.title ?? "",
						session.cwd ?? "",
						session.firstMessage ?? "",
						session.recap ?? "",
						session.allMessagesText,
						session.path,
					]
						.filter(Boolean)
						.join(" "),
				);
			}
		}
		const duration = performance.now() - start;
		console.log(`Session filtering (2000 sessions, 600 keystrokes): ${duration.toFixed(2)}ms`);
		console.log(`Per keystroke: ${(duration / 600).toFixed(3)}ms`);
	});

	it("should measure the cost of string building in session search", () => {
		const sessions = generateSessions(2000);

		// Measure just the string building cost
		const start = performance.now();
		for (let i = 0; i < 1000; i++) {
			for (const session of sessions) {
				const _ = [
					session.id,
					session.title ?? "",
					session.cwd ?? "",
					session.firstMessage ?? "",
					session.recap ?? "",
					session.allMessagesText,
					session.path,
				]
					.filter(Boolean)
					.join(" ");
			}
		}
		const duration = performance.now() - start;
		console.log(`String building cost (2000 sessions x 1000): ${duration.toFixed(2)}ms`);
		console.log(`Per session: ${(duration / 1000 / 2000).toFixed(4)}ms`);
	});
});
