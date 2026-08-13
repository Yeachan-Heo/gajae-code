export function selectedOption(options, index) {
  if (options.length === 0) return null;
  return options[((index % options.length) + options.length) % options.length];
}

export function moveOption(options, index, delta) {
  if (options.length === 0) return { index: 0, option: null };
  const next = ((index + delta) % options.length + options.length) % options.length;
  return { index: next, option: options[next] };
}
