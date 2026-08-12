export const ANSWER_SLOT_COUNT = 5;
export const PAGED_OPTION_COUNT = ANSWER_SLOT_COUNT - 1;

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function unwrapSdkEvent(value) {
  if (!value || typeof value !== "object") return null;
  return value.type === "event" && value.payload && typeof value.payload === "object" ? value.payload : value;
}

export function sdkMessages(envelope, replayId) {
  if (envelope?.type !== "event_replay_result" || envelope.id !== replayId || !Array.isArray(envelope.events)) {
    return [unwrapSdkEvent(envelope)].filter(Boolean);
  }
  return envelope.events.map(unwrapSdkEvent).filter(Boolean);
}

export function pendingAsk(message) {
  if (message?.type !== "action_needed" || message.kind !== "ask") return null;
  const selectedOptionIndices = Array.isArray(message.selectedOptionIndices)
    ? message.selectedOptionIndices.map(nonNegativeInteger).filter(index => index !== null)
    : null;
  return {
    id: message.id,
    question: String(message.question || "Question"),
    options: Array.isArray(message.options) ? message.options.map(String) : [],
    recommendedIndex: nonNegativeInteger(message.recommendedIndex),
    selectedOptionIndices,
    controls: Array.isArray(message.controls)
      ? message.controls.filter(control => control && control.id === "navigation_forward" && control.kind === "navigation")
      : [],
    transitionCount: nonNegativeInteger(message.transitionCount) ?? 0,
    multi: selectedOptionIndices !== null,
    page: 0,
  };
}

export function usesPagedLayout(pending) {
  return Boolean(pending && (pending.multi || pending.options.length > ANSWER_SLOT_COUNT));
}

export function pageCount(pending) {
  if (!usesPagedLayout(pending)) return 1;
  return Math.max(1, Math.ceil(pending.options.length / PAGED_OPTION_COUNT));
}

export function normalizePage(pending) {
  pending.page = Math.min(Math.max(0, pending.page || 0), pageCount(pending) - 1);
  return pending.page;
}

export function optionIndexForSlot(pending, slot) {
  if (!pending || slot < 0 || slot >= ANSWER_SLOT_COUNT) return null;
  if (!usesPagedLayout(pending)) return slot < pending.options.length ? slot : null;
  if (slot >= PAGED_OPTION_COUNT) return null;
  const optionIndex = normalizePage(pending) * PAGED_OPTION_COUNT + slot;
  return optionIndex < pending.options.length ? optionIndex : null;
}

export function pageAction(pending, heldMs = 0) {
  if (!usesPagedLayout(pending)) return null;
  const pages = pageCount(pending);
  const page = normalizePage(pending);
  if (heldMs >= 600 && page > 0) return { kind: "page", page: page - 1 };
  if (page + 1 < pages) return { kind: "page", page: page + 1 };
  const control = pending.multi ? pending.controls.find(candidate => candidate.id === "navigation_forward") : null;
  if (control?.enabled) return { kind: "control", control };
  if (pages > 1) return { kind: "page", page: 0 };
  return null;
}
