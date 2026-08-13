export function focusedStatusAction(surface) {
  if (!surface || surface.type !== "terminal") return "unavailable";
  return /^GJC:\s*/i.test(String(surface.rawTitle || "")) ? "proceed" : "launch";
}
