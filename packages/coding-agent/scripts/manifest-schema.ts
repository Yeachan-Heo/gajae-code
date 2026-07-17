export type ManifestCommand = {
	argv: string[];
};

export type ManifestExclusion = {
	file: string;
	reason: string;
};

export type ManifestAdapterRow = {
	adapterTestId: string;
	sdkId: string;
	adapter: "telegram" | "discord" | "slack" | "mcp" | "acp" | "daemonCli";
	disposition: "native_alias" | "generic_safe" | "machine_only" | "provider_only" | "prohibited";
	testFile: string;
	testNamePattern: string;
	expected: "forwarded" | "rejected_before_send" | "internal_only";
	argv: string[];
};

export type Manifest = {
	version: 1;
	commands: ManifestCommand[];
	excluded: ManifestExclusion[];
	required?: string[];
	rows?: ManifestAdapterRow[];
};

export function validateManifest(value: unknown): Manifest {
	if (typeof value !== "object" || value === null) throw new Error("Manifest must be an object.");
	if (!("version" in value) || value.version !== 1) {
		throw new Error(
			`Manifest version must be 1; received ${"version" in value ? JSON.stringify(value.version) : "missing"}.`,
		);
	}
	if (!("commands" in value) || !Array.isArray(value.commands)) throw new Error("Manifest commands must be an array.");
	if (!("excluded" in value) || !Array.isArray(value.excluded)) throw new Error("Manifest excluded must be an array.");
	if ("required" in value && !Array.isArray(value.required)) throw new Error("Manifest required must be an array.");
	if ("rows" in value && !Array.isArray(value.rows)) throw new Error("Manifest rows must be an array.");

	if (value.commands.length === 0) throw new Error("Manifest must contain at least one command.");

	for (const [index, command] of value.commands.entries()) {
		if (
			typeof command !== "object" ||
			command === null ||
			!("argv" in command) ||
			!Array.isArray(command.argv) ||
			command.argv.length === 0 ||
			!command.argv.every((argument: unknown) => typeof argument === "string")
		) {
			throw new Error(`Manifest command ${index} must contain a non-empty string argv array.`);
		}
	}

	for (const [index, exclusion] of value.excluded.entries()) {
		if (
			typeof exclusion !== "object" ||
			exclusion === null ||
			!("file" in exclusion) ||
			typeof exclusion.file !== "string" ||
			exclusion.file.length === 0 ||
			!("reason" in exclusion) ||
			typeof exclusion.reason !== "string" ||
			exclusion.reason.trim().length === 0
		) {
			throw new Error(`Manifest excluded entry ${index} must contain non-empty string file and reason fields.`);
		}
	}

	const required: unknown[] = "required" in value && Array.isArray(value.required) ? value.required : [];
	for (const [index, file] of required.entries()) {
		if (typeof file !== "string" || file.length === 0) {
			throw new Error(`Manifest required entry ${index} must be a non-empty string.`);
		}
	}

	const rows: unknown[] = "rows" in value && Array.isArray(value.rows) ? value.rows : [];
	const adapters = new Set(["telegram", "discord", "slack", "mcp", "acp", "daemonCli"]);
	const dispositions = new Set(["native_alias", "generic_safe", "machine_only", "provider_only", "prohibited"]);
	const expected = new Set(["forwarded", "rejected_before_send", "internal_only"]);
	for (const [index, row] of rows.entries()) {
		if (
			typeof row !== "object" ||
			row === null ||
			!("adapterTestId" in row) ||
			typeof row.adapterTestId !== "string" ||
			!row.adapterTestId ||
			!("sdkId" in row) ||
			typeof row.sdkId !== "string" ||
			!row.sdkId ||
			!("adapter" in row) ||
			typeof row.adapter !== "string" ||
			!adapters.has(row.adapter) ||
			!("disposition" in row) ||
			typeof row.disposition !== "string" ||
			!dispositions.has(row.disposition) ||
			!("testFile" in row) ||
			typeof row.testFile !== "string" ||
			!row.testFile ||
			!("testNamePattern" in row) ||
			typeof row.testNamePattern !== "string" ||
			!row.testNamePattern.trim() ||
			!("argv" in row) ||
			!Array.isArray(row.argv) ||
			!row.argv.every(argument => typeof argument === "string") ||
			!("expected" in row) ||
			typeof row.expected !== "string" ||
			!expected.has(row.expected)
		)
			throw new Error(`Manifest row ${index} must contain valid adapter coverage fields.`);
		if (
			row.argv.length !== 5 ||
			row.argv[0] !== "bun" ||
			row.argv[1] !== "test" ||
			row.argv[2] !== row.testFile ||
			row.argv[3] !== "--test-name-pattern" ||
			row.argv[4].trim().length === 0
		)
			throw new Error(`Manifest row ${index} must contain an exact bun test receipt argv.`);
	}

	return value as Manifest;
}
