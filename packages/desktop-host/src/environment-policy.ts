const runtimeVariables = new Set([
	"PATH",
	"HOME",
	"USERPROFILE",
	"USER",
	"USERNAME",
	"LOGNAME",
	"TMPDIR",
	"TMP",
	"TEMP",
	"LANG",
	"TZ",
	"TERM",
	"COLORTERM",
	"NO_COLOR",
	"SYSTEMROOT",
	"WINDIR",
	"COMSPEC",
	"PATHEXT",
	"GJC_DESKTOP_DATA_DIR",
]);

/** Keep OS launch essentials, not inherited provider credentials or routing overrides. */
export function isolateEnvironment(environment: Record<string, string | undefined>): void {
	for (const key of Object.keys(environment)) {
		if (!runtimeVariables.has(key.toUpperCase()) && !key.toUpperCase().startsWith("LC_")) delete environment[key];
	}
}
