import { describe, expect, it } from "bun:test";
import { fuzzyFilter } from "@gajae-code/tui";

interface Session {
	id: string;
	title?: string;
	cwd?: string;
	firstMessage?: string;
	recap?: string;
	allMessagesText: string;
	path: string;
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

describe("selector performance - cached version", () => {
	it("should measure session fuzzy filter with cached search text (2000 sessions)", () => {
		const sessions = generateSessions(2000);

		// Pre-build cache (simulates the constructor behavior)
		const searchTextCache = new Map<Session, string>();
		for (const session of sessions) {
			const searchText = [
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
			searchTextCache.set(session, searchText);
		}

		// Now measure filtering with cached text (simulates per-keystroke cost)
		const start = performance.now();
		for (let keystroke = 0; keystroke < 10; keystroke++) {
			const query = `session${keystroke}`;
			fuzzyFilter(sessions, query, session => searchTextCache.get(session)!);
		}
		const duration = performance.now() - start;
		console.log(`Session filtering with cache (2000 sessions, 10 keystrokes): ${duration.toFixed(2)}ms`);
		console.log(`Per keystroke: ${(duration / 10).toFixed(2)}ms`);
		expect(duration).toBeLessThan(300); // Should be much faster
	});

	it("should measure session filter with many keystroke sequences (cached)", () => {
		const sessions = generateSessions(2000);

		// Pre-build cache
		const searchTextCache = new Map<Session, string>();
		for (const session of sessions) {
			const searchText = [
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
			searchTextCache.set(session, searchText);
		}

		const start = performance.now();

		// Simulate typing "resume"
		const queries = ["r", "re", "res", "resu", "resum", "resume"];
		for (let i = 0; i < 100; i++) {
			for (const query of queries) {
				fuzzyFilter(sessions, query, session => searchTextCache.get(session)!);
			}
		}
		const duration = performance.now() - start;
		console.log(`Session filtering with cache (2000 sessions, 600 keystrokes): ${duration.toFixed(2)}ms`);
		console.log(`Per keystroke: ${(duration / 600).toFixed(3)}ms`);
		// Should be under 1 second now (was ~13 seconds before)
		expect(duration).toBeLessThan(1000);
	});
});
