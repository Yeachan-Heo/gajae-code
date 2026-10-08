import { loadNative } from "./loader-state.js";

// The package root eagerly loads the native addon. Keep path utilities importable
// before the addon is built by resolving these bindings only when called.
let pathIdentityBindings;

function getPathIdentityBindings() {
	if (pathIdentityBindings) return pathIdentityBindings;

	const bindings = loadNative();
	const directoryCaseSensitive = bindings.directoryCaseSensitive;
	const windowsOrdinalCaseFold = bindings.windowsOrdinalCaseFold;
	if (typeof directoryCaseSensitive !== "function" || typeof windowsOrdinalCaseFold !== "function") {
		throw new Error("The native addon lacks Windows path identity bindings.");
	}

	pathIdentityBindings = { directoryCaseSensitive, windowsOrdinalCaseFold };
	return pathIdentityBindings;
}

export function directoryCaseSensitive(directoryPath) {
	return getPathIdentityBindings().directoryCaseSensitive(directoryPath);
}

export function windowsOrdinalCaseFold(value) {
	return getPathIdentityBindings().windowsOrdinalCaseFold(value);
}
