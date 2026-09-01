import { Command } from "@gajae-code/utils/cli";
import { offerMacosCommunityApp } from "../cli/macos-community-app";

export default class MacosCommunityAppOffer extends Command {
	static description = "Offer the optional experimental community desktop app";
	static hidden = true;

	async run(): Promise<void> {
		await offerMacosCommunityApp();
	}
}
