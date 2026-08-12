export function contextEntriesForActions(contexts, actions) {
  const accepted = actions instanceof Set ? actions : new Set(actions);
  return [...contexts].filter(([, state]) => accepted.has(state.action));
}

export function contextEntriesForControls(contexts, predicate) {
  return [...contexts].filter(([, state]) => state.action.endsWith(".control") && predicate(state.settings ?? {}));
}
