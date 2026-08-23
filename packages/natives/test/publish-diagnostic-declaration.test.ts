import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const temporaryDirectories: string[] = [];
const nativeDeclaration = path.resolve(import.meta.dir, "../native/index.d.ts");

const typeRoots = path.resolve(import.meta.dir, "../../../node_modules/@types");
afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

it("typechecks generated native declarations as a strict consumer", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-diagnostic-types-"));
	temporaryDirectories.push(directory);
	const config = path.join(directory, "tsconfig.json");
	const consumer = path.join(directory, "consumer.ts");
	await fs.writeFile(
		consumer,
		`import type {
	RecoveryFsPublishDiagnostic,
	RecoveryFsPublishResult,
	RecoveryFsPublishSyncFailure,
	NativeSecureSkillWriteResult,
} from ${JSON.stringify(nativeDeclaration)};

const failure: RecoveryFsPublishSyncFailure = {
	phase: "source_parent_sync",
	parentRole: "source",
	osCode: 5,
	kind: "io",
};
const diagnostic: RecoveryFsPublishDiagnostic = {
	schemaVersion: 1,
	collectionState: "partial",
	syncFailures: [failure],
};
const result: RecoveryFsPublishResult = {
	ok: false,
	mutationState: "committed",
	durabilityState: "not_provable",
	reason: "durability_not_provable",
	primitive: "renameat2_noreplace",
	phase: "source_parent_sync",
	diagnostic,
};
const createdSkill: NativeSecureSkillWriteResult = {
	ok: true,
	path: "C:/skills/managed/SKILL.md",
};
const rejectedSkill: NativeSecureSkillWriteResult = {
	ok: false,
	code: "reparse_point",
};
void result;
void createdSkill;
void rejectedSkill;
`,
	);
	await fs.writeFile(
		config,
		JSON.stringify({
			compilerOptions: {
				strict: true,
				skipLibCheck: false,
				module: "NodeNext",
				moduleResolution: "NodeNext",
				target: "ES2022",
				types: ["node"],
				typeRoots: [typeRoots],
			},
			files: ["consumer.ts"],
		}),
	);
	const proc = Bun.spawn({
		cmd: ["bunx", "tsc", "--noEmit", "--project", config],
		cwd: path.resolve(import.meta.dir, "../../.."),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
});
