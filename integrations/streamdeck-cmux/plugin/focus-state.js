export function focusedSessionKey(sessions, selectedTty, sessionKey) {
  const focused = sessions.find(session => session.tty === selectedTty);
  return focused ? sessionKey(focused) : null;
}

export function nextSelectedSessionId(sessions, selectedTty, selectedSessionId, sessionKey) {
  const focused = focusedSessionKey(sessions, selectedTty, sessionKey);
  if (focused) return focused;
  if (selectedSessionId && sessions.some(session => sessionKey(session) === selectedSessionId)) return selectedSessionId;
  return sessions[0] ? sessionKey(sessions[0]) : null;
}
