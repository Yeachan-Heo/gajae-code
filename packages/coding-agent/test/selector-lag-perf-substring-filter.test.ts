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

describe("selector performance - with substring prefilter", () => {
	it("should measure session fuzzy filter with substring prefilter (2000 sessions)", () => {
		const sessions = generateSessions(2000);

		// Pre-build search text cache (simulates the constructor behavior)
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

		// Measure filtering with substring prefilter + fuzzy (simulates per-keystroke cost)
		const start = performance.now();
		for (let keystroke = 0; keystroke < 10; keystroke++) {
			const query = `project`;
			const queryLower = query.toLowerCase();

			// Fast substring pre-filter
			const prescreened = sessions.filter(session => {
				const searchText = searchTextCache.get(session)!;
				return searchText.toLowerCase().includes(queryLower);
			});

			// Apply fuzzy ranking to prescreened results
			fuzzyFilter(prescreened, query, session => searchTextCache.get(session)!);
		}
		const duration = performance.now() - start;
		console.log(`Session filtering with prefilter (2000 sessions, 10 keystrokes): ${duration.toFixed(2)}ms`);
		console.log(`Per keystroke: ${(duration / 10).toFixed(2)}ms`);
		expect(duration).toBeLessThan(300);
	});

	it("should measure session filter with many keystroke sequences (with prefilter)", () => {
		const sessions = generateSessions(2000);

		// Pre-build search text cache
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

		// Simulate typing "project"
		const queries = ["p", "pr", "pro", "proj", "proje", "project"];
		for (let i = 0; i < 10; i++) {
			for (const query of queries) {
				const queryLower = query.toLowerCase();

				// Fast substring pre-filter
				const prescreened = sessions.filter(session => {
					const searchText = searchTextCache.get(session)!;
					return searchText.toLowerCase().includes(queryLower);
				});

				// Apply fuzzy ranking to prescreened results
				fuzzyFilter(prescreened, query, session => searchTextCache.get(session)!);
			}
		}
		const duration = performance.now() - start;
		console.log(`Session filtering with prefilter (2000 sessions, 60 keystrokes): ${duration.toFixed(2)}ms`);
		console.log(`Per keystroke: ${(duration / 60).toFixed(3)}ms`);
		expect(duration).toBeLessThan(300);
	});
});
