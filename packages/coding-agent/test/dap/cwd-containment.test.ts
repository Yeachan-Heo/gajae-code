import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { cwdEscapesWorkspace } from "../../src/dap/session";

function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

describe("DAP runInTerminal workspace containment", () => {
	test("holds seeded path containment properties with native separators (seed 0x6858c0de)", () => {
		const random = seededRandom(0x6858c0de);
		const randomInt = (max: number): number => Math.floor(random() * max);

		for (let caseIndex = 0; caseIndex < 64; caseIndex++) {
			const rootSegments = Array.from(
				{ length: 1 + randomInt(4) },
				(_, segmentIndex) => `dir-${caseIndex}-${segmentIndex}-${randomInt(36_000).toString(36)}`,
			);
			const workspaceSegment = `workspace-${caseIndex}-${randomInt(36_000).toString(36)}`;
			const root = path.resolve(os.tmpdir(), "gjc-dap-containment", ...rootSegments, workspaceSegment);
			const child = `child-${randomInt(36_000).toString(36)}`;
			const leaf = `file-${randomInt(36_000).toString(36)}.txt`;

			expect(cwdEscapesWorkspace(root, root)).toBe(false);

			const descendant = path.resolve(root, `discard-${caseIndex}`, "..", child, leaf);
			expect(cwdEscapesWorkspace(root, descendant)).toBe(false);

			const normalizedTraversal = path.resolve(root, `discard-${caseIndex}`, "..", child, "nested", "..", leaf);
			expect(cwdEscapesWorkspace(root, normalizedTraversal)).toBe(false);

			expect(cwdEscapesWorkspace(root, path.dirname(root))).toBe(true);
			const traversalParent = path.resolve(root, child, "..", "..");
			expect(cwdEscapesWorkspace(root, traversalParent)).toBe(true);

			const sibling = path.resolve(`${root}Sibling`, child, leaf);
			expect(cwdEscapesWorkspace(root, sibling)).toBe(true);

			let otherRoot: string;
			if (process.platform === "win32") {
				const otherDrive = path.parse(root).root[0]?.toUpperCase() === "Z" ? "Y:" : "Z:";
				otherRoot = path.win32.resolve(`${otherDrive}${path.win32.sep}`, child, leaf);
			} else {
				otherRoot = path.resolve(path.parse(root).root, `gjc-dap-other-${caseIndex}`, child, leaf);
			}
			expect(path.isAbsolute(otherRoot)).toBe(true);
			expect(cwdEscapesWorkspace(root, otherRoot)).toBe(true);

			const caseVariantRoot = path.join(path.dirname(root), workspaceSegment.replace("workspace", "Workspace"));
			const caseVariantCandidate = path.join(caseVariantRoot, child, leaf);
			expect(cwdEscapesWorkspace(root, caseVariantCandidate)).toBe(process.platform !== "win32");
		}
	});
});
