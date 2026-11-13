let counter = 0;

/** Unique id for UI/runtime objects (NOT used for generation, so it need not be deterministic). */
export function uid(prefix = 'id'): string {
  counter += 1;
  return `${prefix}-${counter.toString(36)}${Math.floor(Math.random() * 1679616).toString(36)}`;
}
