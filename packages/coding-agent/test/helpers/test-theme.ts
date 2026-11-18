/** Loads a fresh `red-claw` theme for render-path tests that install a theme before rendering. */
import { getThemeByName, type Theme } from "../../src/modes/theme/theme";

const TEST_THEME = "red-claw";

export async function loadTestTheme(): Promise<Theme> {
	const theme = await getThemeByName(TEST_THEME);
	if (!theme) throw new Error(`Failed to load ${TEST_THEME} test theme`);
	return theme;
}
