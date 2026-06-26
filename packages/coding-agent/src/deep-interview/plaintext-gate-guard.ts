export type DeepInterviewPlaintextAskLeakOption = "Yes, crystallize" | "Adjust wording" | "Missing scope";

export type DeepInterviewPlaintextAskLeakResult = {
	kind: "deep_interview_plaintext_ask_leak";
	matchedOptions: DeepInterviewPlaintextAskLeakOption[];
	signals: {
		optionsHeading: true;
		restateIntent: true;
		deepInterviewContext: boolean;
	};
};

const CANONICAL_OPTIONS: DeepInterviewPlaintextAskLeakOption[] = [
	"Yes, crystallize",
	"Adjust wording",
	"Missing scope",
];

const RESTATE_INTENT_PATTERNS: RegExp[] = [
	/\brestate\b/i,
	/\bconfirmation\b/i,
	/\bconfirm(?:ation|ed|ing)?\b/i,
	/\bcrystall?ize\b/i,
	/\bdoes\s+this\s+(?:capture|match|reflect|summari[sz]e)\b/i,
	/\bbefore\s+(?:i|we)\s+(?:write|finali[sz]e|crystall?ize)\b/i,
	/\bread\s+only\s+this\s+line\b/i,
	/\bturn\s+this\s+into\s+(?:the\s+)?(?:spec|final)\b/i,
	/재진술/,
	/다시\s*말/,
	/확인/,
	/확정/,
	/정리/,
	/요약/,
	/맞(?:습니까|나요|는지)/,
];

const DEEP_INTERVIEW_CONTEXT_PATTERNS: RegExp[] = [
	/\bdeep[ -]?interview\b/i,
	/\bsocratic\b/i,
	/\binterview\s+round\b/i,
	/\bround\s+\d+\b/i,
	/\bambiguity\b/i,
	/\btopology\s+confirmation\b/i,
	/딥\s*인터뷰/,
	/심층\s*인터뷰/,
	/인터뷰\s*(?:라운드|진행|확인)/,
];

const FINAL_ARTIFACT_PATTERNS: RegExp[] = [
	/^\s*#{1,3}\s*(?:(?:final|approved|completed|완료|최종)\s+)?(?:deep[ -]?interview\s+)?(?:spec(?:ification)?|transcript)\b/im,
	/^\s*#{1,3}\s*(?:deep[ -]?interview\s+)?(?:final|approved|completed|완료|최종)\s+(?:spec(?:ification)?|transcript)\b/im,
	/\b(?:final|approved|completed)\s+(?:deep[ -]?interview\s+)?(?:spec(?:ification)?|transcript)\b/i,
	/\binterview\s+transcript\b/i,
	/\.gjc\/specs\//i,
	/최종\s*(?:명세|스펙|기록)/,
];

function hasOptionsHeading(text: string): boolean {
	return /(?:^|\n)\s*options\s*:/i.test(text);
}

function hasPattern(text: string, patterns: RegExp[]): boolean {
	return patterns.some(pattern => pattern.test(text));
}

function matchedCanonicalOptions(text: string): DeepInterviewPlaintextAskLeakOption[] {
	const folded = text.toLocaleLowerCase("en-US");
	return CANONICAL_OPTIONS.filter(option => folded.includes(option.toLocaleLowerCase("en-US")));
}

function looksLikeFinalArtifact(text: string): boolean {
	return hasPattern(text, FINAL_ARTIFACT_PATTERNS);
}

export function detectDeepInterviewPlaintextAskLeak(text: string): DeepInterviewPlaintextAskLeakResult | null {
	const trimmed = text.trim();
	if (trimmed.length === 0) return null;
	if (looksLikeFinalArtifact(trimmed)) return null;
	if (!hasOptionsHeading(trimmed)) return null;

	const matchedOptions = matchedCanonicalOptions(trimmed);
	if (matchedOptions.length < 2) return null;
	if (!hasPattern(trimmed, RESTATE_INTENT_PATTERNS)) return null;

	return {
		kind: "deep_interview_plaintext_ask_leak",
		matchedOptions,
		signals: {
			optionsHeading: true,
			restateIntent: true,
			deepInterviewContext: hasPattern(trimmed, DEEP_INTERVIEW_CONTEXT_PATTERNS),
		},
	};
}
