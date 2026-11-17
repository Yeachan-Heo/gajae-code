/**
 * Biome CLI-based linter client.
 * Uses Biome's CLI with JSON output instead of LSP (which has stale diagnostics issues).
 */
import path from "node:path";
import { projectSafeSpawnEnv } from "@gajae-code/utils/shell-config";
import type { Diagnostic, DiagnosticSeverity, LinterClient, ServerConfig } from "../../lsp/types";

// =============================================================================
// Biome JSON Output Types
// =============================================================================

interface BiomeJsonOutput {
	diagnostics: BiomeDiagnostic[];
}

interface BiomeDiagnostic {
	category: string; // e.g., "lint/correctness/noUnusedVariables"
	severity: "error" | "warning" | "info" | "hint";
	description: string;
	location?: {
		path?: { file: string };
		span?: [number, number]; // [startOffset, endOffset] in bytes
		sourceCode?: string;
	};
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Convert byte offset to line:column using source code.
 */
function offsetToPosition(source: string, offset: number): { line: number; column: number } {
	let line = 1;
	let column = 1;
	let byteIndex = 0;

	for (const ch of source) {
		const byteLen = Buffer.byteLength(ch);
		if (byteIndex + byteLen > offset) {
			break;
		}
		if (ch === "\n") {
			line++;
			column = 1;
		} else {
			column++;
		}
		byteIndex += byteLen;
	}

	return { line, column };
}

/**
 * Parse Biome severity to LSP DiagnosticSeverity.
 */
function parseSeverity(severity: string): DiagnosticSeverity {
	switch (severity) {
		case "error":
			return 1;
		case "warning":
			return 2;
		case "info":
			return 3;
		case "hint":
			return 4;
		default:
			return 2;
	}
}

/**
 * Run a Biome CLI command.
 */
async function runBiome(
	args: string[],
	cwd: string,
	resolvedCommand?: string,
): Promise<{ stdout: string; stderr: string; success: boolean }> {
	const command = resolvedCommand ?? "biome";

	try {
		const proc = Bun.spawn([command, ...args], {
			cwd,
			env: projectSafeSpawnEnv(),
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});

		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const exitCode = await proc.exited;

		return { stdout, stderr, success: exitCode === 0 };
	} catch (err) {
		return { stdout: "", stderr: String(err), success: false };
	}
}

// =============================================================================
// Biome Client
// =============================================================================

/**
 * Biome CLI-based linter client.
 * Parses Biome's --reporter=json output into LSP Diagnostic format.
 */
export class BiomeClient implements LinterClient {
	/** Factory method for creating BiomeClient instances */
	static create(config: ServerConfig, cwd: string): LinterClient {
		return new BiomeClient(config, cwd);
	}

	constructor(
		private readonly config: ServerConfig,
		private readonly cwd: string,
	) {}

	async format(filePath: string, content: string): Promise<string> {
		// Write content to file first
		await Bun.write(filePath, content);

		// Run biome format --write
		const result = await runBiome(["format", "--write", filePath], this.cwd, this.config.resolvedCommand);

		if (result.success) {
			// Read back formatted content
			return await Bun.file(filePath).text();
		}

		// Format failed, return original
		return content;
	}

	async lint(filePath: string): Promise<Diagnostic[]> {
		// Run biome lint with JSON reporter
		const result = await runBiome(["lint", "--reporter=json", filePath], this.cwd, this.config.resolvedCommand);

		return this.#parseJsonOutput(result.stdout, filePath);
	}

	/**
	 * Parse Biome's JSON output into LSP Diagnostics.
	 */
	#parseJsonOutput(jsonOutput: string, targetFile: string): Diagnostic[] {
		const diagnostics: Diagnostic[] = [];

		try {
			const parsed: BiomeJsonOutput = JSON.parse(jsonOutput);

			for (const diag of parsed.diagnostics) {
				const location = diag.location;
				if (!location?.path?.file) continue;

				// Resolve file path
				const diagFile = path.isAbsolute(location.path.file)
					? location.path.file
					: path.join(this.cwd, location.path.file);

				// Only include diagnostics for the target file
				if (path.resolve(diagFile) !== path.resolve(targetFile)) {
					continue;
				}

				// Convert byte offset to line:column
				let startLine = 1;
				let startColumn = 1;
				let endLine = 1;
				let endColumn = 1;

				if (location.span && location.sourceCode) {
					const startPos = offsetToPosition(location.sourceCode, location.span[0]);
					const endPos = offsetToPosition(location.sourceCode, location.span[1]);
					startLine = startPos.line;
					startColumn = startPos.column;
					endLine = endPos.line;
					endColumn = endPos.column;
				}

				diagnostics.push({
					range: {
						start: { line: startLine - 1, character: startColumn - 1 },
						end: { line: endLine - 1, character: endColumn - 1 },
					},
					severity: parseSeverity(diag.severity),
					message: diag.description,
					source: "biome",
					code: diag.category,
				});
			}
		} catch {
			// JSON parse failed, return empty
		}

		return diagnostics;
	}

	dispose(): void {
		// Nothing to dispose for CLI client
	}
}
