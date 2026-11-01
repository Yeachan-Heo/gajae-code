import { beforeAll, describe, expect, it } from "bun:test";
import fc from "fast-check";
import { type LspServerInfo, WelcomeComponent } from "../src/modes/components/welcome";
import { getThemeByName, setThemeInstance } from "../src/modes/theme/theme";

const OSC52 = "\x1b]52;c;";
const OSC0 = "\x1b]0;";
const OSC8 = "\x1b]8;;https://example.invalid/";
const BEL = "\x07";
const CSI2K = "\x1b[2K";
const SEED = 697202610;
const WIDE = 4000;

beforeAll(async () => {
	const loaded = await getThemeByName("red-claw");
	if (!loaded) throw new Error("Failed to load red-claw theme");
	setThemeInstance(loaded);
});

function renderLsp(servers: LspServerInfo[], width = 240): string {
	const welcome = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], servers, "ascii", {
		reducedMotion: true,
	});
	return welcome.render(width).join("\n");
}

describe("welcome LSP labels", () => {
	it("does not draw a fileTypes terminal control sequence raw", () => {
		const raw = renderLsp([
			{
				name: "typescript-language-server",
				status: "idle",
				fileTypes: [`${OSC52}PAYLOAD${BEL}${OSC0}title${BEL}${OSC8}label${BEL}${CSI2K}ts\x1b]52;c;open`, "tsx"],
			},
		]);
		expect(raw).not.toContain(OSC52);
		expect(raw).not.toContain(OSC0);
		expect(raw).not.toContain(OSC8);
		expect(raw).not.toContain(CSI2K);
		expect(raw).toContain("ts");
		expect(raw).toContain("tsx");
		expect(raw).toContain("typescript-language-server");
	});

	it("does not draw an LSP server name terminal control sequence raw", () => {
		const welcome = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii", {
			reducedMotion: true,
		});
		welcome.setLspServers([
			{
				name: `${OSC0}title${BEL}${CSI2K}typescript-language-server`,
				status: "idle",
				fileTypes: ["ts"],
			},
		]);
		const raw = welcome.render(240).join("\n");
		expect(raw).not.toContain(OSC0);
		expect(raw).not.toContain(CSI2K);
		expect(raw).toContain("typescript-language-server");
		expect(raw).toContain("ts");
	});

	it("still allows ordinary LSP names, letter case, and spaced file types", () => {
		const raw = renderLsp([
			{
				name: " TypeScript ",
				status: "ready",
				fileTypes: [" ts ", ".TS", "c++"],
			},
		]);
		expect(raw).toContain("TypeScript");
		expect(raw).toContain("ts");
		expect(raw).toContain(".TS");
		expect(raw).toContain("c++");
	});

	it("does not draw an over-cap fileTypes control sequence raw", () => {
		const huge = "\x1bP".repeat(512);
		const started = performance.now();
		const raw = renderLsp([
			{
				name: "typescript-language-server",
				status: "idle",
				fileTypes: [huge, "ts"],
			},
		]);
		expect(performance.now() - started).toBeLessThan(1000);
		expect(raw).not.toContain("\x1bP");
		expect(raw).toContain("ts");
		expect(raw).toContain("typescript-language-server");
	});

	it("does not let a control-only file type reveal a later entry", () => {
		const raw = renderLsp([
			{
				name: "typescript-language-server",
				status: "idle",
				fileTypes: [`${OSC52}PAYLOAD${BEL}${CSI2K}`, "ts", "tsx", "SHOULD_HIDE"],
			},
		]);
		expect(raw).not.toContain(OSC52);
		expect(raw).not.toContain(CSI2K);
		expect(raw).toContain("ts");
		expect(raw).toContain("tsx");
		expect(raw).not.toContain("SHOULD_HIDE");
	});

	it("still allows the first three file types", () => {
		const raw = renderLsp([
			{
				name: "typescript-language-server",
				status: "connecting",
				fileTypes: ["ts", "tsx", "js", "HIDDENEXT"],
			},
		]);
		expect(raw).toContain("typescript-language-server");
		expect(raw).toContain("ts");
		expect(raw).toContain("tsx");
		expect(raw).toContain("js");
		expect(raw).not.toContain("HIDDENEXT");
	});

	it("still allows a long plain file type when a later entry is huge", () => {
		const plain = "typescript".repeat(6);
		const huge = "\x1bP".repeat(16000);
		const started = performance.now();
		const raw = renderLsp([
			{
				name: "typescript-language-server",
				status: "idle",
				fileTypes: [plain, "ts", "tsx", huge],
			},
		]);
		expect(performance.now() - started).toBeLessThan(1000);
		expect(raw).toContain(plain);
		expect(raw).toContain("ts");
		expect(raw).toContain("tsx");
		expect(raw).not.toContain("\x1bP");
	});

	it("keeps a 256 character plain LSP name", () => {
		const name = "Q".repeat(256);
		const raw = renderLsp([{ name, status: "idle", fileTypes: ["ts"] }], WIDE);
		expect(raw).toContain(name);
		expect(raw).toContain("ts");
	});

	it("omits a 257 character plain LSP name", () => {
		const name = "N".repeat(257);
		const raw = renderLsp([{ name, status: "idle", fileTypes: ["ts"] }], WIDE);
		expect(raw).not.toContain(name);
		expect(raw).toContain("ts");
	});

	it("omits a 512 character plain LSP name", () => {
		const name = "M".repeat(512);
		const raw = renderLsp([{ name, status: "idle", fileTypes: ["ts"] }], WIDE);
		expect(raw).not.toContain(name);
		expect(raw).toContain("ts");
	});

	it("keeps a 256 character plain file type", () => {
		const fileType = "T".repeat(256);
		const raw = renderLsp(
			[{ name: "typescript-language-server", status: "idle", fileTypes: [fileType, "tsx"] }],
			WIDE,
		);
		expect(raw).toContain(fileType);
		expect(raw).toContain("tsx");
		expect(raw).toContain("typescript-language-server");
	});

	it("omits a 257 character plain file type", () => {
		const fileType = "Y".repeat(257);
		const raw = renderLsp(
			[
				{
					name: "typescript-language-server",
					status: "idle",
					fileTypes: [fileType, "ts", "tsx", "SHOULD_HIDE"],
				},
			],
			WIDE,
		);
		expect(raw).not.toContain(fileType);
		expect(raw).toContain("ts");
		expect(raw).toContain("tsx");
		expect(raw).not.toContain("SHOULD_HIDE");
		expect(raw).toContain("typescript-language-server");
	});

	it("omits a 512 character plain file type", () => {
		const fileType = "X".repeat(512);
		const raw = renderLsp(
			[
				{
					name: "typescript-language-server",
					status: "idle",
					fileTypes: [fileType, "ts", "tsx", "SHOULD_HIDE"],
				},
			],
			WIDE,
		);
		expect(raw).not.toContain(fileType);
		expect(raw).toContain("ts");
		expect(raw).not.toContain("SHOULD_HIDE");
	});

	it("generated LSP labels do not include OSC or erase sequences", () => {
		fc.assert(
			fc.property(
				fc.string({ maxLength: 32 }),
				fc.array(fc.string({ maxLength: 16 }), { maxLength: 4 }),
				(extra, types) => {
					const raw = renderLsp([
						{
							name: `${OSC0}lsp${BEL}${extra}`,
							status: "error",
							fileTypes: types.map(type => `${OSC52}${extra}${BEL}${OSC8}x${BEL}${CSI2K}${type}`),
						},
					]);
					expect(raw).not.toContain(OSC52);
					expect(raw).not.toContain(OSC0);
					expect(raw).not.toContain(OSC8);
					expect(raw).not.toContain(CSI2K);
				},
			),
			{ seed: SEED, numRuns: 64 },
		);
	});
});
