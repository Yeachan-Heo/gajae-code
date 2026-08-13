export const LONG_PRESS_MS = 600;
export const DOUBLE_TAP_MS = 280;

export function pressGesture(heldMs = 0) {
  return heldMs >= LONG_PRESS_MS ? "hold" : "tap";
}

export function isDoubleTap(previousAt, currentAt, windowMs = DOUBLE_TAP_MS) {
  return Number.isFinite(previousAt) && currentAt - previousAt >= 0 && currentAt - previousAt <= windowMs;
}

export function supportsDoubleTap(settings = {}) {
  return settings.type === "promptSubmit" || settings.name === "clear" || settings.type === "themeCycle";
}
