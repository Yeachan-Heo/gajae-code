import * as fs from "node:fs/promises";
import * as path from "node:path";

export const MUPDF_VERSION = "1.28.0";
export const MUPDF_RELEASE_MATERIALS_ENV = "GJC_MUPDF_RELEASE_MATERIALS_DIR";
export const MUPDF_RELEASE_MATERIALS = [
	"mupdf-source.tar.gz",
	"mupdf-build-recipe.txt",
	"mupdf-notices.txt",
	"mupdf-provenance.json",
] as const;

interface MuPdfProvenance {
	schema: "gajae-mupdf-corresponding-source-v1";
	mupdfVersion: string;
	sourceArtifact: string;
	buildRecipe: string;
	notices: string;
}

async function requireFile(directory: string, name: string): Promise<void> {
	const filePath = path.join(directory, name);
	const metadata = await fs.stat(filePath).catch(() => undefined);
	if (!metadata?.isFile() || metadata.size <= 0) {
		throw new Error(`MuPDF release material is missing or empty: ${name}`);
	}
}

/**
 * Fail closed before a release binary embeds MuPDF unless maintainers have
 * supplied the exact corresponding-source package and its build evidence.
 */
export async function verifyMuPdfReleaseMaterials(directory = process.env[MUPDF_RELEASE_MATERIALS_ENV]): Promise<string> {
	if (!directory) {
		throw new Error(
			`MuPDF release materials are required before embedding; set ${MUPDF_RELEASE_MATERIALS_ENV} to a directory containing the corresponding source, recipe, notices, and provenance`,
		);
	}
	const resolved = path.resolve(directory);
	for (const name of MUPDF_RELEASE_MATERIALS) await requireFile(resolved, name);
	const provenance = JSON.parse(await Bun.file(path.join(resolved, "mupdf-provenance.json")).text()) as Partial<MuPdfProvenance>;
	if (provenance.schema !== "gajae-mupdf-corresponding-source-v1") {
		throw new Error("MuPDF release provenance has an unknown schema");
	}
	if (provenance.mupdfVersion !== MUPDF_VERSION) {
		throw new Error(`MuPDF release provenance targets ${provenance.mupdfVersion ?? "unknown"}, expected ${MUPDF_VERSION}`);
	}
	if (provenance.sourceArtifact !== "mupdf-source.tar.gz" || provenance.buildRecipe !== "mupdf-build-recipe.txt" || provenance.notices !== "mupdf-notices.txt") {
		throw new Error("MuPDF release provenance does not bind the required source, recipe, and notices");
	}
	return resolved;
}
