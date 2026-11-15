import { expect, test } from "bun:test";
import * as path from "node:path";
import { releaseEntrypoints } from "../../coding-agent/scripts/compile-args";
import { buildHost } from "../scripts/build-host";
import { buildAdHocBundleSignCommand } from "../scripts/sign-bundle";

const root = path.resolve(import.meta.dir, "../../..");
const resets = [
	[process.execPath, "--cwd=packages/natives", "run", "embed:native", "--reset"],
	[process.execPath, "--cwd=packages/stats", "scripts/generate-client-bundle.ts", "--reset"],
];

function commandStage(command: string[]): string {
	if (command.includes("--reset")) {
		return command.includes("--cwd=packages/natives") ? "native reset" : "stats reset";
	}
	if (command[0] === "codesign") return "sign";
	if (command[1] === "build") return "compile";
	return command.includes("--generate") ? "generate" : "embed";
}

test("ad-hoc app signing delegates requirement generation to codesign without an override", () => {
	const app = "/owned packaging fixture/Untrusted Identifier.app";
	// No custom -r/--requirements or identifier-only requirement may replace
	// codesign's default CDHash binding, even for apps claiming the same ID.
	expect(buildAdHocBundleSignCommand(app)).toEqual(["codesign", "--force", "--deep", "--sign", "-", app]);
});

test("host packaging preserves both canonical worker inventories, signing, and cleanup order", async () => {
	const commands: string[][] = [];
	const compileEnvironments: (NodeJS.ProcessEnv | undefined)[] = [];
	await buildHost(async (command, env) => {
		commands.push(command);
		if (command[1] === "build") compileEnvironments.push(env);
	});
	expect(commands.map(commandStage)).toEqual([
		"generate",
		"embed",
		"compile",
		"sign",
		"compile",
		"sign",
		"native reset",
		"stats reset",
	]);
	const builds = commands.filter(command => command[1] === "build");
	expect(builds).toHaveLength(2);
	for (const [index, command] of builds.entries()) {
		const firstEntrypoint = command.findIndex(arg => arg.startsWith("./packages/"));
		expect(firstEntrypoint).toBeGreaterThan(0);
		expect(command.slice(firstEntrypoint, command.indexOf("--outfile"))).toEqual(
			index === 0 ? ["./packages/desktop-host/src/entry.ts", ...releaseEntrypoints.slice(1)] : releaseEntrypoints,
		);
		expect(command.at(-1)).toBe(
			path.join(
				root,
				"packages/desktop/src-tauri/binaries",
				`${index === 0 ? "gjc-desktop-host" : "gjc"}-aarch64-apple-darwin`,
			),
		);
		expect(compileEnvironments[index]?.BUN_NO_CODESIGN_MACHO_BINARY).toBe("1");
	}
	expect(commands.filter(command => command[0] === "codesign").map(command => command.at(-1))).toEqual(
		builds.map(command => command.at(-1)),
	);
	expect(commands.slice(-2)).toEqual(resets);
});

for (const { failedBuildStage, nativeResetFails, statsResetFails } of [
	{ failedBuildStage: "generate", nativeResetFails: false, statsResetFails: false },
	{ failedBuildStage: "embed", nativeResetFails: true, statsResetFails: false },
	{ failedBuildStage: "compile", nativeResetFails: true, statsResetFails: true },
	{ failedBuildStage: "sign", nativeResetFails: false, statsResetFails: true },
	{ failedBuildStage: undefined, nativeResetFails: true, statsResetFails: false },
	{ failedBuildStage: undefined, nativeResetFails: false, statsResetFails: true },
	{ failedBuildStage: undefined, nativeResetFails: true, statsResetFails: true },
]) {
	test(`host packaging attempts both resets and retains failures: build=${failedBuildStage ?? "success"}, native=${nativeResetFails}, stats=${statsResetFails}`, async () => {
		const commands: string[][] = [];
		const buildFailure = new Error(`original ${failedBuildStage} failure`);
		const nativeFailure = new Error("native embed reset failed");
		const statsFailure = new Error("stats embed reset failed");
		const expectedErrors = [
			...(failedBuildStage ? [buildFailure] : []),
			...(nativeResetFails ? [nativeFailure] : []),
			...(statsResetFails ? [statsFailure] : []),
		];
		let failure: unknown;
		try {
			await buildHost(async command => {
				commands.push(command);
				const stage = commandStage(command);
				if (stage === failedBuildStage) throw buildFailure;
				if (stage === "native reset" && nativeResetFails) throw nativeFailure;
				if (stage === "stats reset" && statsResetFails) throw statsFailure;
			});
		} catch (error) {
			failure = error;
		}
		expect(commands.slice(-2)).toEqual(resets);
		if (failedBuildStage) {
			expect(commandStage(commands.at(-3)!)).toBe(failedBuildStage);
		}
		if (expectedErrors.length === 1) {
			expect(failure).toBe(expectedErrors[0]);
		} else {
			expect(failure).toBeInstanceOf(AggregateError);
			if (!(failure instanceof AggregateError)) throw new Error("Expected all failures to be aggregated");
			expect(failure.errors).toHaveLength(expectedErrors.length);
			for (const [index, expected] of expectedErrors.entries()) {
				expect(failure.errors[index]).toBe(expected);
			}
			expect(failure.cause).toBe(expectedErrors[0]);
		}
	});
}
