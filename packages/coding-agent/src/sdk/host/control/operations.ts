export type ControlValue = unknown;
export type ControlInput = Record<string, unknown>;

/**
 * Narrow host contract used by control dispatch. Implementations adapt an
 * AgentSession and its controllers without exposing those concrete types here.
 */
export interface ControlSurface {
	prompt(text: string, images?: ControlValue): Promise<ControlValue> | ControlValue;
	steer(text: string): Promise<ControlValue> | ControlValue;
	followUp(text: string): Promise<ControlValue> | ControlValue;
	abort(): Promise<ControlValue> | ControlValue;
	abortAndPrompt(text: string): Promise<ControlValue> | ControlValue;
	answerAsk(id: string, answer: ControlValue): Promise<ControlValue> | ControlValue;
	answerGate(id: string, response: ControlValue): Promise<ControlValue> | ControlValue;
	approvePlan(id: string, choice: ControlValue): Promise<ControlValue> | ControlValue;
	invokeSkill(name: string, args: ControlValue): Promise<ControlValue> | ControlValue;
	setPlanMode(on: boolean): Promise<ControlValue> | ControlValue;
	operateGoal(op: string, objective?: string): Promise<ControlValue> | ControlValue;
	replaceTodo(items: ControlValue): Promise<ControlValue> | ControlValue;
	setModel(id: string, thinkingLevel?: ControlValue): Promise<ControlValue> | ControlValue;
	cycleModel(): Promise<ControlValue> | ControlValue;
	setThinking(level: ControlValue): Promise<ControlValue> | ControlValue;
	cycleThinking(): Promise<ControlValue> | ControlValue;
	setPermissionMode(mode: ControlValue): Promise<ControlValue> | ControlValue;
	setQueueMode(kind: string, mode: ControlValue): Promise<ControlValue> | ControlValue;
	runCompaction(): Promise<ControlValue> | ControlValue;
	setAutoCompaction(on: boolean): Promise<ControlValue> | ControlValue;
	setAutoRetry(on: boolean): Promise<ControlValue> | ControlValue;
	abortRetry(): Promise<ControlValue> | ControlValue;
	executeBash(cmd: string): Promise<ControlValue> | ControlValue;
	abortBash(): Promise<ControlValue> | ControlValue;
	newSession(): Promise<ControlValue> | ControlValue;
	forkSession(): Promise<ControlValue> | ControlValue;
	resumeSession(id: string): Promise<ControlValue> | ControlValue;
	closeSession(): Promise<ControlValue> | ControlValue;
	switchSession(id: string): Promise<ControlValue> | ControlValue;
	branchSession(entryId: string): Promise<ControlValue> | ControlValue;
	renameSession(name: string): Promise<ControlValue> | ControlValue;
	handoffSession(target: ControlValue): Promise<ControlValue> | ControlValue;
	exportHtml(): Promise<ControlValue> | ControlValue;
	patchConfig(patch: ControlValue): Promise<ControlValue> | ControlValue;
	reloadRuntime(components: ControlValue): Promise<ControlValue> | ControlValue;
	login(provider: string): Promise<ControlValue> | ControlValue;
	registerHostTools(defs: ControlValue): Promise<ControlValue> | ControlValue;
	registerHostUri(defs: ControlValue): Promise<ControlValue> | ControlValue;
	setServiceTier(tier: ControlValue): Promise<ControlValue> | ControlValue;
	setActiveTools(names: ControlValue): Promise<ControlValue> | ControlValue;
	removeQueueMessage(id: string): Promise<ControlValue> | ControlValue;
	moveQueueMessage(id: string, position: { before?: string; after?: string }): Promise<ControlValue> | ControlValue;
	updateQueueMessage(id: string, patch: ControlValue): Promise<ControlValue> | ControlValue;
	setExtensionEnabled(id: string, on: boolean): Promise<ControlValue> | ControlValue;
	clearContext(confirm: boolean): Promise<ControlValue> | ControlValue;
	deleteSession(id: string, confirm: boolean): Promise<ControlValue> | ControlValue;
	moveCwd(path: string): Promise<ControlValue> | ControlValue;
	retryLast(): Promise<ControlValue> | ControlValue;
	retryNow(): Promise<ControlValue> | ControlValue;
	backgroundBash(): Promise<ControlValue> | ControlValue;
	/** Returns the current revision for a registry revision resource. */
	/** Installed per-session registry rows. Dispatch rejects other rows before invoking a surface method. */
	installedOperations?: ReadonlySet<string>;
	revisionProvider?(resource: string): Promise<string | undefined> | string | undefined;
}
