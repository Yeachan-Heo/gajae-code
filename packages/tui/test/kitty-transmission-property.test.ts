import { describe, expect, it } from "bun:test";
import { encodeKittyTransmission } from "@gajae-code/tui/terminal-capabilities";

const MAX_ESCAPE = 4096;
const HEADERS = [
	"a=T,f=100,q=2",
	"a=T,f=100,c=2,r=2,i=42,p=43,q=2,C=1",
	"a=T,f=100,c=3,r=2,i=42,q=2,C=1,Y=1",
	"a=t,f=100,q=2,i=42",
] as const;

function decodeChunks(encoded: string): Array<{ params: string; payload: string }> {
	if (encoded.length === 0) return [];
	const chunks: Array<{ params: string; payload: string }> = [];
	let rest = encoded;
	while (rest.length > 0) {
		const terminator = rest.indexOf("\x1b\\");
		expect(terminator).toBeGreaterThan(0);
		const frame = rest.slice(0, terminator);
		expect(frame.startsWith("\x1b_G")).toBe(true);
		const semicolon = frame.indexOf(";");
		expect(semicolon).toBeGreaterThan(0);
		chunks.push({ params: frame.slice(3, semicolon), payload: frame.slice(semicolon + 1) });
		rest = rest.slice(terminator + 2);
	}
	return chunks;
}

function assertTransmission(header: string, bytes: Uint8Array): void {
	const base64 = Buffer.from(bytes).toString("base64");
	const encoded = encodeKittyTransmission(header, base64);
	const chunks = decodeChunks(encoded);
	expect(chunks.length).toBeGreaterThan(0);
	expect(chunks.map(chunk => chunk.payload).join("")).toBe(base64);
	for (const chunk of chunks) expect(chunk.payload.length + chunk.params.length + 6).toBeLessThanOrEqual(MAX_ESCAPE);

	if (chunks.length === 1) {
		expect(chunks[0]!.params).toBe(header);
		return;
	}
	expect(chunks[0]!.params.startsWith(`${header},m=`)).toBe(true);
	for (const [index, chunk] of chunks.entries()) {
		const more = chunk.params.match(/(?:^|,)m=([01])(?:,|$)/)?.[1];
		expect(more).toBe(index === chunks.length - 1 ? "0" : "1");
		if (index === 0) continue;
		expect(chunk.params.startsWith("m=")).toBe(true);
		expect(chunk.params.includes(header)).toBe(false);
		if (index < chunks.length - 1) expect(chunk.payload.length % 4).toBe(0);
	}
}

function seededBytes(next: () => number, length: number): Uint8Array {
	return Uint8Array.from({ length }, () => Math.floor(next() * 256));
}

describe("encodeKittyTransmission generated payloads", () => {
	it("round-trips bytes and keeps escape bounds across generated lengths and headers", () => {
		let state = 0x6888;
		const next = () => {
			state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
			return state / 4_294_967_296;
		};
		// Chunk boundaries depend on header length; sweep dense lengths around the
		// 4096-char budget for every caller header.
		const lengths = new Set<number>([0, 1, 2, 3, 4, 5, 7, 8, 15, 16]);
		for (let offset = -8; offset <= 8; offset += 1) {
			for (const header of HEADERS) {
				const budget = MAX_ESCAPE - 6 - 6 - header.length;
				const base64Length = Math.max(0, budget - (budget % 4));
				lengths.add(Math.max(0, Math.floor((base64Length * 3) / 4) + offset));
				lengths.add(Math.max(0, Math.floor(((base64Length + 4) * 3) / 4) + offset));
			}
		}
		for (let sample = 0; sample < 120; sample += 1) lengths.add(Math.floor(next() * 12_000));

		for (const length of [...lengths].sort((a, b) => a - b)) {
			const bytes = seededBytes(next, length);
			for (const header of HEADERS) assertTransmission(header, bytes);
		}
	});
});
