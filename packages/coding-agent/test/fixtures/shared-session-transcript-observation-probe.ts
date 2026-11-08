import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type TranscriptEntry = { type?: string; id?: string; parentId?: string | null };

/** The two-TUI test's original parser and matcher, shared with the diagnostic probe. */
export function parseTranscript(raw: string) {
	const lines = raw.split("\n").filter(line => line.trim().length > 0);
	const header = JSON.parse(lines[0]!) as { id?: string };
	const entries = lines.slice(1).map(line => JSON.parse(line) as TranscriptEntry);
	return { header, lines, entries };
}

/** Entries whose serialized form contains the prompt as a complete JSON string value. */
export function promptEntries(entries: TranscriptEntry[], prompt: string) {
	const needle = `"${prompt}"`;
	return entries.filter(entry => entry.type === "message" && JSON.stringify(entry).includes(needle));
}

export type TranscriptObservation = {
	phase: "wait-satisfied" | "assertion";
	sequence: number;
	relativePath: string;
	buffer: Buffer;
};

// Probe only: the cause of the two-TUI failure remains unresolved. Reads are separate observations.
export function transcriptObservationDiagnostics(observations: TranscriptObservation[], prompts: string[]) {
	const snapshots = observations.map(observation => {
		const raw = observation.buffer.toString("utf8");
		const parseErrors: { line: number | null; error: string }[] = [];
		const matchingLines: {
			line: number;
			raw: string;
			prompts: string[];
			parsed: unknown;
		}[] = [];
		for (const [index, line] of raw.split("\n").entries()) {
			if (!line.trim()) continue;
			let parsed: unknown = null;
			try {
				const entry = JSON.parse(line);
				parsed = {
					type: entry?.type ?? null,
					id: entry?.id ?? null,
					parentId: entry?.parentId ?? null,
					messageRole: entry?.message?.role ?? null,
					content: entry?.message?.content ?? null,
				};
			} catch (error) {
				parseErrors.push({ line: index + 1, error: String(error) });
			}
			const matches = prompts.filter(prompt => line.includes(prompt));
			if (matches.length) matchingLines.push({ line: index + 1, raw: line, prompts: matches, parsed });
		}
		let ids: string[] | null = null;
		let exactMatchCounts: Record<string, number> | null = null;
		try {
			const transcript = parseTranscript(raw);
			ids = transcript.entries.flatMap(entry => (typeof entry.id === "string" ? [entry.id] : []));
			exactMatchCounts = Object.fromEntries(
				prompts.map(prompt => [prompt, promptEntries(transcript.entries, prompt).length]),
			);
		} catch (error) {
			// Never substitute a partially parsed transcript or zero counts for a failed parse.
			parseErrors.push({ line: null, error: String(error) });
		}
		return {
			phase: observation.phase,
			sequence: observation.sequence,
			relativePath: observation.relativePath,
			bytes: observation.buffer.byteLength,
			sha256: createHash("sha256").update(observation.buffer).digest("hex"),
			matchingLines,
			exactMatchCounts,
			ids,
			parseErrors,
		};
	});
	const before = snapshots.find(snapshot => snapshot.phase === "wait-satisfied");
	const after = snapshots.find(snapshot => snapshot.phase === "assertion");
	return {
		probe: "shared-session-transcript-observation",
		causeUnresolved: true,
		snapshots,
		addedIds: before?.ids && after?.ids ? after.ids.filter(id => !before.ids!.includes(id)) : null,
		removedIds: before?.ids && after?.ids ? before.ids.filter(id => !after.ids!.includes(id)) : null,
	};
}

export async function transcriptObservationFailure(
	cause: unknown,
	observations: TranscriptObservation[],
	prompts: string[],
) {
	const diagnostics = transcriptObservationDiagnostics(observations, prompts);
	const repo = path.resolve(import.meta.dirname, "../../../..");
	let artifactDirectory: string | null = null;
	let retentionError: string | null = null;
	try {
		const directory = path.join(repo, "artifacts", "shared-session-transcript-observation-probe");
		await fs.mkdir(directory, { recursive: true });
		const destination = await fs.mkdtemp(path.join(directory, "failure-"));
		artifactDirectory = path.relative(repo, destination);
		for (const observation of observations) {
			await Bun.write(
				path.join(destination, `${observation.sequence}-${observation.phase}.jsonl`),
				observation.buffer,
			);
		}
		await Bun.write(path.join(destination, "diagnostics.json"), JSON.stringify(diagnostics));
	} catch (error) {
		retentionError = String(error);
	}
	return new Error("Two-TUI transcript observation probe (cause unresolved)", {
		cause: new Error(JSON.stringify({ ...diagnostics, artifactDirectory, retentionError }), { cause }),
	});
}
