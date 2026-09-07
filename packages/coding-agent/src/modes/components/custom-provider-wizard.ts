import * as crypto from "node:crypto";
import { Container, Input, matchesKey, SecretInput, Spacer, Text, TruncatedText } from "@gajae-code/tui";
import type { ProviderCompatibility, ProviderSetupInput } from "../../setup/provider-onboarding";
import { theme } from "../theme/theme";
import { matchesAppInterrupt } from "../utils/keybinding-matchers";
import { DynamicBorder } from "./dynamic-border";

export type CustomProviderCredentialSource = "env" | "literal";

type WizardStep =
	| "compatibility"
	| "provider-id"
	| "base-url"
	| "credential-source"
	| "credential"
	| "discover"
	| "models"
	| "confirm"
	| "force-confirm";

interface WizardState {
	compatibility: ProviderCompatibility;
	providerId: string;
	baseUrl: string;
	credentialSource: CustomProviderCredentialSource;
	credential: string;
	discoverModels: boolean;
	discoveredModels: string[];
	/** Inputs that produced discoveredModels; empty when results are stale/unprobed. */
	discoveredForBaseUrl: string;
	/** SHA-256 of the credential that produced the results — never the secret itself. */
	discoveredForCredentialHash: string;
	discoveredForCredentialSource: CustomProviderCredentialSource;
	discoveryError: string | null;
	models: string;
}

export type CustomProviderWizardSubmit = ProviderSetupInput;

export interface CustomProviderWizardDiscoveryDeps {
	discoverModels?: (input: {
		baseUrl: string;
		apiKeyEnv?: string;
		apiKey?: string;
		signal?: AbortSignal;
	}) => Promise<{ models: string[] }>;
}

/** Non-secret fingerprint binding probe results to the credential that produced them. */
function fingerprintCredential(credential: string): string {
	return `sha256:${crypto.createHash("sha256").update(credential, "utf8").digest("hex")}`;
}

export class CustomProviderWizardComponent extends Container {
	#contentContainer: Container;
	#input: Input | SecretInput | null = null;
	#step: WizardStep = "compatibility";
	#selectedIndex = 0;
	#lastSubmitError: string | null = null;
	#state: WizardState = {
		compatibility: "openai",
		providerId: "",
		baseUrl: "",
		credentialSource: "env",
		credential: "",
		discoverModels: false,
		discoveredModels: [],
		discoveredForBaseUrl: "",
		discoveredForCredentialHash: "",
		discoveredForCredentialSource: "env",
		discoveryError: null,
		models: "",
	};
	#submitInFlight = false;
	#discoveryInFlight = false;
	#discoveryGeneration = 0;
	#submitGeneration = 0;
	#discoveryAbort: AbortController | null = null;
	#submitAbort: AbortController | null = null;
	#dismissed = false;
	#onSubmit: (input: CustomProviderWizardSubmit) => void;
	#onCancel: () => void;
	#onRender: () => void;
	#discoveryDeps: CustomProviderWizardDiscoveryDeps = {};

	constructor(
		onSubmit: (input: CustomProviderWizardSubmit) => void,
		onCancel: () => void,
		onRender: () => void = () => {},
		discoveryDeps: CustomProviderWizardDiscoveryDeps = {},
	) {
		super();
		this.#onSubmit = onSubmit;
		this.#onCancel = onCancel;
		this.#onRender = onRender;
		this.#discoveryDeps = discoveryDeps;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new TruncatedText(theme.bold("Add custom provider")));
		this.addChild(
			new TruncatedText(theme.fg("muted", "  Configure an OpenAI- or Anthropic-compatible API provider."), 0, 0),
		);
		this.addChild(new Spacer(1));
		this.#contentContainer = new Container();
		this.addChild(this.#contentContainer);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.#renderStep();
	}

	setSubmitError(error: string): void {
		this.#lastSubmitError = error;
		if (error.includes("already exists")) {
			this.#step = "force-confirm";
			this.#selectedIndex = 1;
		}
		this.#renderStep();
		this.#onRender();
	}

	handleInput(keyData: string): void {
		if (matchesAppInterrupt(keyData)) {
			if (this.#step === "compatibility") {
				this.#dismissed = true;
				this.#cancelDiscovery();
				this.#clearLiteralCredential();
				this.#onCancel();
				return;
			}
			this.#goBack();
			return;
		}

		if (this.#input) {
			if (this.#input instanceof SecretInput) {
				this.#input.handleInput(keyData);
				return;
			}
			if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
				this.#saveInputAndProceed();
				return;
			}
			this.#input.handleInput(keyData);
			return;
		}

		if (matchesKey(keyData, "up")) {
			this.#moveSelection(-1);
			return;
		}
		if (matchesKey(keyData, "down")) {
			this.#moveSelection(1);
			return;
		}
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#selectCurrentOption();
		}
	}

	#renderStep(): void {
		this.#contentContainer.clear();
		this.#input = null;
		switch (this.#step) {
			case "compatibility":
				this.#renderCompatibilityStep();
				break;
			case "provider-id":
				this.#renderInputStep(
					"Step 2: Provider id",
					"Enter a provider id:",
					this.#state.providerId,
					"e.g. my-openai-proxy",
				);
				break;
			case "base-url":
				this.#renderInputStep(
					"Step 3: Base URL",
					"Enter the API base URL:",
					this.#state.baseUrl,
					"e.g. https://api.example.com/v1",
				);
				break;
			case "credential-source":
				this.#renderCredentialSourceStep();
				break;
			case "credential":
				if (this.#state.credentialSource === "env") {
					this.#renderInputStep(
						"Step 5: Credential",
						"Enter the API key environment variable name:",
						this.#state.credential,
						"e.g. OPENAI_API_KEY",
					);
				} else {
					this.#renderSecretInputStep();
				}
				break;
			case "discover":
				this.#renderDiscoverStep();
				break;
			case "models":
				this.#renderInputStep(
					"Step 6: Model id(s)",
					"Enter model ids, comma-separated:",
					this.#state.models,
					"e.g. gpt-5, claude-sonnet-4-5",
				);
				break;
			case "confirm":
				this.#renderConfirmStep(false);
				break;
			case "force-confirm":
				this.#renderConfirmStep(true);
				break;
		}
	}

	#renderCompatibilityStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "Step 1: Compatibility")));
		this.#contentContainer.addChild(new Spacer(1));
		const options: Array<{ value: ProviderCompatibility; label: string }> = [
			{ value: "openai", label: "OpenAI-compatible" },
			{ value: "anthropic", label: "Anthropic-compatible" },
		];
		for (let i = 0; i < options.length; i++) this.#addOption(i, options[i]?.label ?? "");
		this.#addHelp("[↑↓ to navigate, Enter to select, Esc to cancel]");
	}

	#renderCredentialSourceStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "Step 4: Credential source")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#addOption(0, "Environment variable");
		this.#addOption(1, "Paste API key");
		this.#addHelp("[↑↓ to navigate, Enter to select, Esc to go back]");
	}

	#renderInputStep(title: string, prompt: string, value: string, hint: string): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", title)));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(prompt, 0, 0));
		this.#contentContainer.addChild(new Spacer(1));
		this.#input = new Input();
		this.#input.setValue(value);
		this.#contentContainer.addChild(this.#input);
		this.#contentContainer.addChild(new Spacer(1));
		this.#addHelp(hint);
		this.#addHelp("[Enter to continue, Esc to go back]");
	}

	#renderDiscoverStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "Step 6: Model discovery")));
		this.#contentContainer.addChild(new Spacer(1));
		if (this.#state.compatibility !== "openai") {
			this.#contentContainer.addChild(
				new Text("Model discovery needs an OpenAI-compatible endpoint. Continue with manual model ids.", 0, 0),
			);
			this.#contentContainer.addChild(new Spacer(1));
			this.#addOption(0, "Enter model ids manually");
			this.#addHelp("[Enter to continue, Esc to go back]");
			return;
		}
		if (this.#discoveryInFlight) {
			this.#contentContainer.addChild(new Text("Discovering models from the provider /v1/models endpoint…", 0, 0));
			this.#contentContainer.addChild(new Spacer(1));
			this.#addHelp("The API key is sent only to your configured base URL.");
			return;
		}
		if (this.#state.discoveryError) {
			this.#contentContainer.addChild(
				new Text(theme.fg("warning", `Discovery failed: ${this.#state.discoveryError}`), 0, 0),
			);
			this.#contentContainer.addChild(new Spacer(1));
		}
		if (this.#state.discoveredModels.length > 0) {
			const preview = this.#state.discoveredModels.slice(0, 10).join(", ");
			const extra =
				this.#state.discoveredModels.length > 10 ? ` (+${this.#state.discoveredModels.length - 10} more)` : "";
			this.#contentContainer.addChild(
				new Text(`Discovered ${this.#state.discoveredModels.length} model(s): ${preview}${extra}`, 0, 0),
			);
			this.#contentContainer.addChild(new Spacer(1));
		} else if (!this.#state.discoveryError) {
			this.#contentContainer.addChild(
				new Text("Probe the provider /v1/models endpoint, or enter model ids manually.", 0, 0),
			);
			this.#contentContainer.addChild(new Spacer(1));
		}
		this.#addOption(0, this.#state.discoveredModels.length > 0 ? "Use discovered models" : "Discover models now");
		this.#addOption(1, "Enter model ids manually");
		this.#addHelp("[↑↓ to navigate, Enter to select, Esc to go back]");
	}

	#renderSecretInputStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "Step 5: Credential")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("Paste the API key:", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));
		const input = new SecretInput();
		input.onSubmit = secret => {
			const credential = secret.consume().trim();
			if (!credential) return;
			this.#state.credential = credential;
			this.#clearStaleDiscovery();
			this.#step = "discover";
			this.#selectedIndex = 0;
			this.#renderStep();
			this.#onRender();
		};
		this.#input = input;
		this.#contentContainer.addChild(input);
		this.#contentContainer.addChild(new Spacer(1));
		this.#addHelp("The key will be stored securely and redacted in output.");
		this.#addHelp("[Enter to continue, Esc to go back]");
	}

	#renderConfirmStep(force: boolean): void {
		this.#contentContainer.addChild(
			new Text(theme.fg("accent", force ? "Provider exists — replace it?" : "Confirm custom provider")),
		);
		this.#contentContainer.addChild(new Spacer(1));
		if (this.#lastSubmitError) {
			this.#contentContainer.addChild(new Text(theme.fg(force ? "warning" : "error", this.#lastSubmitError), 0, 0));
			this.#contentContainer.addChild(new Spacer(1));
		}
		this.#contentContainer.addChild(new Text(`Compatibility: ${this.#state.compatibility}`, 0, 0));
		this.#contentContainer.addChild(new Text(`Provider: ${this.#state.providerId}`, 0, 0));
		this.#contentContainer.addChild(new Text(`Base URL: ${this.#state.baseUrl}`, 0, 0));
		this.#contentContainer.addChild(
			new Text(
				`Credential: ${this.#state.credentialSource === "env" ? this.#state.credential : "pasted API key"}`,
				0,
				0,
			),
		);
		this.#contentContainer.addChild(new Text(`Models: ${this.#state.models}`, 0, 0));
		this.#contentContainer.addChild(new Spacer(1));
		this.#addOption(0, force ? "Replace existing provider" : "Add provider");
		this.#addOption(1, "Go back");
		this.#addHelp("[↑↓ to navigate, Enter to select, Esc to go back]");
	}

	#addOption(index: number, label: string): void {
		const selected = index === this.#selectedIndex;
		const prefix = selected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
		this.#contentContainer.addChild(new Text(`${prefix}${selected ? theme.fg("accent", label) : label}`, 0, 0));
	}

	#addHelp(text: string): void {
		this.#contentContainer.addChild(new Text(theme.fg("muted", text), 0, 0));
	}

	#saveInputAndProceed(): void {
		if (!(this.#input instanceof Input)) return;
		const value = this.#input.getValue().trim();
		if (!value) return;
		if (this.#step === "provider-id") {
			this.#state.providerId = value;
			// A provider-ID revision invalidates pending submits exactly
			// like URL/credential revisions do.
			this.#clearStaleDiscovery();
			this.#step = "base-url";
		} else if (this.#step === "base-url") {
			this.#state.baseUrl = value;
			this.#clearStaleDiscovery();
			this.#step = "credential-source";
			this.#selectedIndex = 0;
		} else if (this.#step === "credential") {
			this.#state.credential = value;
			this.#clearStaleDiscovery();
			this.#step = "discover";
			this.#selectedIndex = 0;
		} else if (this.#step === "models") {
			this.#state.models = value;
			// Manual entry supersedes any accepted discovery (clearStale
			// also resets discoverModels): submitting both would silently
			// persist live discovery the manual screen never disclosed.
			this.#clearStaleDiscovery();
			this.#step = "confirm";
			this.#selectedIndex = 0;
			this.#lastSubmitError = null;
		}
		this.#renderStep();
		this.#onRender();
	}

	#selectCurrentOption(): void {
		if (this.#step === "compatibility") {
			this.#state.compatibility = this.#selectedIndex === 0 ? "openai" : "anthropic";
			this.#step = "provider-id";
		} else if (this.#step === "credential-source") {
			this.#state.credentialSource = this.#selectedIndex === 0 ? "env" : "literal";
			this.#state.credential = "";
			this.#step = "credential";
		} else if (this.#step === "discover") {
			if (this.#state.compatibility !== "openai") {
				this.#step = "models";
			} else if (this.#selectedIndex === 0) {
				if (this.#state.discoveredModels.length > 0 && this.#discoveryResultsAreFresh()) {
					this.#state.discoverModels = true;
					this.#state.models = "";
					this.#step = "confirm";
					this.#selectedIndex = 0;
					this.#lastSubmitError = null;
				} else {
					this.#runDiscovery();
					return;
				}
			} else {
				this.#state.discoverModels = false;
				this.#step = "models";
			}
		} else if (this.#step === "confirm" || this.#step === "force-confirm") {
			if (this.#selectedIndex === 0) {
				this.#submit();
				return;
			}
			this.#step = "models";
		}
		this.#renderStep();
		this.#onRender();
	}

	#clearStaleDiscovery(): void {
		this.#discoveryGeneration += 1;
		this.#submitGeneration += 1;
		this.#discoveryAbort?.abort();
		this.#discoveryAbort = null;
		// A revision also invalidates an in-flight submit: without this,
		// a submit-time probe started before the edit could still persist
		// the old URL/key and close the wizard as successful.
		this.#submitAbort?.abort();
		this.#submitAbort = null;
		this.#discoveryInFlight = false;
		this.#state.discoveredModels = [];
		this.#state.discoveredForBaseUrl = "";
		this.#state.discoveredForCredentialHash = "";
		this.#state.discoverModels = false;
		this.#state.discoveryError = null;
	}

	#discoveryResultsAreFresh(): boolean {
		return (
			this.#state.discoveredForBaseUrl !== "" &&
			this.#state.discoveredForBaseUrl === this.#state.baseUrl.trim() &&
			this.#state.discoveredForCredentialHash !== "" &&
			this.#state.discoveredForCredentialHash === fingerprintCredential(this.#state.credential.trim()) &&
			this.#state.discoveredForCredentialSource === this.#state.credentialSource
		);
	}

	#runDiscovery(): void {
		const discover = this.#discoveryDeps.discoverModels;
		if (!discover || this.#discoveryInFlight) return;
		this.#discoveryAbort?.abort();
		const controller = new AbortController();
		this.#discoveryAbort = controller;
		this.#discoveryInFlight = true;
		this.#discoveryGeneration += 1;
		const generation = this.#discoveryGeneration;
		this.#state.discoveryError = null;
		this.#renderStep();
		this.#onRender();
		// Immutable fingerprint of the inputs being probed: completions are
		// accepted only when both the generation and the live inputs still
		// match, so an edit made while the request was in flight cannot
		// inherit a catalog fetched for different inputs.
		const credential = this.#state.credential.trim();
		const fingerprint = {
			baseUrl: this.#state.baseUrl.trim(),
			credential,
			credentialSource: this.#state.credentialSource,
		};
		const request = {
			baseUrl: fingerprint.baseUrl,
			apiKeyEnv: fingerprint.credentialSource === "env" ? fingerprint.credential : undefined,
			apiKey: fingerprint.credentialSource === "literal" ? fingerprint.credential : undefined,
			signal: controller.signal,
		};
		void Promise.resolve()
			.then(() => discover(request))
			.then(
				result => {
					if (!this.#isCurrentDiscoveryGeneration(generation)) return;
					this.#discoveryInFlight = false;
					if (!this.#discoveryFingerprintMatches(fingerprint)) {
						if (this.#step === "discover") {
							this.#renderStep();
							this.#onRender();
						}
						return;
					}
					const models = [...new Set(result.models.map(model => model.trim()).filter(Boolean))].sort((a, b) =>
						a.localeCompare(b),
					);
					this.#state.discoveredModels = models;
					this.#state.discoveredForBaseUrl = fingerprint.baseUrl;
					this.#state.discoveredForCredentialHash = fingerprintCredential(fingerprint.credential);
					this.#state.discoveredForCredentialSource = fingerprint.credentialSource;
					this.#state.discoveryError = models.length === 0 ? "The endpoint returned no models." : null;
					this.#selectedIndex = 0;
					if (this.#step === "discover") {
						this.#renderStep();
						this.#onRender();
					}
				},
				error => {
					if (!this.#isCurrentDiscoveryGeneration(generation)) return;
					this.#discoveryInFlight = false;
					if (!this.#discoveryFingerprintMatches(fingerprint)) {
						if (this.#step === "discover") {
							this.#renderStep();
							this.#onRender();
						}
						return;
					}
					this.#state.discoveredModels = [];
					this.#state.discoveredForBaseUrl = "";
					this.#state.discoveredForCredentialHash = "";
					this.#state.discoveryError = error instanceof Error ? error.message : String(error);
					this.#selectedIndex = 1;
					if (this.#step === "discover") {
						this.#renderStep();
						this.#onRender();
					}
				},
			);
	}

	#isCurrentDiscoveryGeneration(generation: number): boolean {
		return generation === this.#discoveryGeneration;
	}

	#discoveryFingerprintMatches(fingerprint: {
		baseUrl: string;
		credential: string;
		credentialSource: CustomProviderCredentialSource;
	}): boolean {
		return (
			fingerprint.baseUrl === this.#state.baseUrl.trim() &&
			fingerprint.credential === this.#state.credential.trim() &&
			fingerprint.credentialSource === this.#state.credentialSource
		);
	}

	#submit(): void {
		if (this.#submitInFlight) return;
		this.#submitInFlight = true;
		// Own the submit-time pre-write probe lifecycle: Esc-cancel during a
		// stalled submit aborts the probe via #cancelDiscovery so the
		// provider cannot be written after dismissal.
		this.#submitAbort?.abort();
		this.#submitAbort = new AbortController();
		this.#submitGeneration += 1;
		let submission: unknown;
		try {
			submission = this.#onSubmit(this.#buildInput(this.#step === "force-confirm"));
		} catch (error) {
			this.#submitInFlight = false;
			this.#endSubmitDiscovery();
			throw error;
		}
		if (!(submission instanceof Promise)) {
			this.#submitInFlight = false;
			this.#endSubmitDiscovery();
			return;
		}
		void submission.then(
			() => {
				this.#submitInFlight = false;
				this.#endSubmitDiscovery();
			},
			() => {
				this.#submitInFlight = false;
				this.#endSubmitDiscovery();
			},
		);
	}

	#buildInput(force: boolean): CustomProviderWizardSubmit {
		const input = {
			compatibility: this.#state.compatibility,
			providerId: this.#state.providerId,
			baseUrl: this.#state.baseUrl,
			apiKeyEnv: this.#state.credentialSource === "env" ? this.#state.credential : undefined,
			apiKey: this.#state.credentialSource === "literal" ? this.#state.credential : undefined,
			models: this.#state.models
				.split(",")
				.map(model => model.trim())
				.filter(Boolean),
			discover: this.#state.compatibility === "openai" ? this.#state.discoverModels : false,
			discoverySignal: this.#submitAbort?.signal,
			force,
		};

		return input;
	}

	complete(): void {
		this.#cancelDiscovery();
		this.#clearLiteralCredential();
	}

	/**
	 * Abort any in-flight probe and invalidate its generation so a late
	 * completion cannot render into (or retain credentials from) a
	 * dismissed wizard. Used by both submit and cancel paths.
	 */
	#cancelDiscovery(): void {
		this.#discoveryGeneration += 1;
		this.#submitGeneration += 1;
		this.#discoveryAbort?.abort();
		this.#discoveryAbort = null;
		this.#submitAbort?.abort();
		this.#submitAbort = null;
		this.#discoveryInFlight = false;
	}

	/** Clear the settled submit controller without aborting (submit finished). */
	#endSubmitDiscovery(): void {
		this.#submitAbort = null;
	}

	/** Generation token for the latest submit attempt. */
	currentSubmitGeneration(): number {
		return this.#submitGeneration;
	}

	/**
	 * Whether a submit attempt is still current: same generation and not
	 * dismissed. Revision or cancel invalidates pending completions so a
	 * stale refresh cannot report success or rerender over new inputs.
	 */
	isSubmitCurrent(generation: number): boolean {
		return generation === this.#submitGeneration && !this.#dismissed;
	}

	#clearLiteralCredential(): void {
		if (this.#state.credentialSource === "literal") this.#state.credential = "";
	}

	#moveSelection(delta: number): void {
		const maxIndex =
			this.#step === "confirm" ||
			this.#step === "force-confirm" ||
			this.#step === "compatibility" ||
			this.#step === "credential-source" ||
			this.#step === "discover"
				? 1
				: 0;
		this.#selectedIndex = (this.#selectedIndex + delta + maxIndex + 1) % (maxIndex + 1);
		this.#renderStep();
		this.#onRender();
	}

	#goBack(): void {
		if (this.#step === "provider-id") this.#step = "compatibility";
		else if (this.#step === "base-url") this.#step = "provider-id";
		else if (this.#step === "credential-source") this.#step = "base-url";
		else if (this.#step === "credential") this.#step = "credential-source";
		else if (this.#step === "discover") this.#step = "credential";
		else if (this.#step === "models") this.#step = "discover";
		else if (this.#step === "confirm" || this.#step === "force-confirm") this.#step = "models";
		this.#selectedIndex = 0;
		this.#renderStep();
		this.#onRender();
	}
}
