// Lightweight clone instrumentation for Type containers.
// Env flags:
// - VOYD_DEBUG_CLONE=1 prints a short clone profile on process exit
//
// This module avoids importing Type definitions to prevent cycles.

type Kind = string;

type Metrics = {
  total: number;
  perKind: Map<Kind, number>;
  maxDepth: number;
};

type Session = {
  seen: WeakSet<object>;
};

const DEBUG = !!process.env.VOYD_DEBUG_CLONE && process.env.VOYD_DEBUG_CLONE !== "0";

const state: {
  depth: number;
  metrics: Metrics;
  session: Session | null;
} = {
  depth: 0,
  metrics: {
    total: 0,
    perKind: new Map(),
    maxDepth: 0,
  },
  session: null,
};

const incKind = (kind: Kind) => {
  const cur = state.metrics.perKind.get(kind) ?? 0;
  state.metrics.perKind.set(kind, cur + 1);
};

export const beginTypeClone = (node: object, kind: Kind): void => {
  // Start a new session when entering the outermost clone
  if (state.depth === 0) state.session = { seen: new WeakSet() };
  state.depth += 1;
  state.metrics.total += 1;
  incKind(kind);
  if (state.depth > state.metrics.maxDepth) state.metrics.maxDepth = state.depth;
  // Mark this node as seen to help child checks avoid immediate cycles
  state.session?.seen.add(node);
};

export const endTypeClone = (): void => {
  state.depth = Math.max(0, state.depth - 1);
  if (state.depth === 0) state.session = null;
};

// Returns true if the provided node was already seen in the current clone session
// and should be shallow-copied or referenced instead of deeply cloned.
export const shouldShallowClone = (node: object | undefined | null): boolean => {
  if (!node || !state.session) return false;
  if (state.session.seen.has(node)) return true;
  state.session.seen.add(node);
  return false;
};

export const getCloneMetrics = () => state.metrics;

const printProfile = () => {
  const { total, maxDepth, perKind } = state.metrics;
  const kinds = Array.from(perKind.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([k, v]) => `${k}:${v}`)
    .join(", ");
  // eslint-disable-next-line no-console
  console.log(`[voyd][clone] total=${total} maxDepth=${maxDepth} kinds=[${kinds}]`);
};

if (DEBUG) {
  // Print a compact profile when the process ends (e.g., test run finish)
  process.on("exit", () => {
    try {
      printProfile();
    } catch {
      /* ignore */
    }
  });
}

