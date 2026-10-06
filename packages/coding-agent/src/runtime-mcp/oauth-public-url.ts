import { validatePublicHttpUrl } from "../web/insane/url-guard";

export async function assertPublicOAuthUrl(url: string): Promise<void> {
	const checked = await validatePublicHttpUrl(url);
	if (!checked.ok) {
		throw new Error(`Refusing non-public OAuth endpoint: ${checked.reason ?? url}`);
	}
}
