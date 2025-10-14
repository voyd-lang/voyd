import type { Type, TypeAlias } from "../../syntax-objects/types.js";
import {
  withTypeContext as runWithSyntaxContext,
  type TypeContextHooks,
} from "../../syntax-objects/type-context.js";
import {
  TypeInterner,
  type TypeInternerEvent,
  type TypeInternerOptions,
  type TypeInternerStats,
} from "./type-interner.js";

const formatTypeLabel = (type: Type | undefined): string | undefined => {
  if (!type) return undefined;
  const rawId = (type as any)?.id;
  if (typeof rawId === "string" && rawId.length) return rawId;
  if (typeof rawId === "number") return `#${rawId}`;
  const name = (type as any)?.name;
  if (typeof name === "string" && name.length) return name;
  if (name && typeof name.toString === "function") {
    const str = name.toString();
    if (typeof str === "string" && str.length) return str;
  }
  const kind = (type as any)?.kindOfType;
  if (typeof kind === "string" && kind.length) return `<${kind}>`;
  return undefined;
};

export type DivergenceRecord = {
  fingerprint: string;
  canonicalId?: string;
  reusedId?: string;
};

export type TypeReuseSummary = {
  byCanonicalId: Record<string, number>;
  byFingerprint: Record<string, number>;
};

export type TypeContextTelemetry = {
  enabled: boolean;
  stats?: TypeInternerStats;
  divergences?: DivergenceRecord[];
  reuseSummary?: TypeReuseSummary;
  pendingAliases?: number;
};

export type TypeContextOptions = {
  useInterner?: boolean;
  recordEvents?: boolean;
};

export type SemanticsTypeContext = TypeContextHooks & {
  useInterner: boolean;
  interner?: TypeInterner;
  getTelemetry(): TypeContextTelemetry;
};

const summarizeReuse = (events: TypeInternerEvent[]): TypeReuseSummary => {
  const byCanonicalId: Record<string, number> = {};
  const byFingerprint: Record<string, number> = {};

  events.forEach((event) => {
    const canonicalId = formatTypeLabel(event.canonical);
    if (canonicalId) {
      byCanonicalId[canonicalId] = (byCanonicalId[canonicalId] ?? 0) + 1;
    }
    byFingerprint[event.fingerprint] =
      (byFingerprint[event.fingerprint] ?? 0) + 1;
  });

  return { byCanonicalId, byFingerprint };
};

const buildTelemetry = (
  context: SemanticsTypeContext,
  events: TypeInternerEvent[] | undefined
): TypeContextTelemetry => {
  if (!context.useInterner || !context.interner) {
    return { enabled: false };
  }

  const stats = context.interner.getStats();
  if (!events?.length) {
    return {
      enabled: true,
      stats,
      divergences: [],
      reuseSummary: { byCanonicalId: {}, byFingerprint: {} },
    };
  }

  const divergences: DivergenceRecord[] = events.map((event) => ({
    fingerprint: event.fingerprint,
    canonicalId: formatTypeLabel(event.canonical),
    reusedId: formatTypeLabel(event.reused),
  }));

  return {
    enabled: true,
    stats,
    divergences,
    reuseSummary: summarizeReuse(events),
  };
};

export const createTypeContext = (
  options: TypeContextOptions = {}
): SemanticsTypeContext => {
  const useInterner = options.useInterner ?? false;
  if (!useInterner) {
    return {
      useInterner: false,
      register: (type) => type,
      registerMany: (types) =>
        [...types].filter((value): value is Type => value !== undefined),
      getTelemetry: () => ({ enabled: false }),
      markAliasPending: () => undefined,
      resolveAlias: () => undefined,
    };
  }

  const internerOptions: TypeInternerOptions = {
    recordEvents: options.recordEvents ?? false,
  };

  const interner = new TypeInterner(internerOptions);
  const pendingAliases = new Set<TypeAlias>();

  const context: SemanticsTypeContext = {
    useInterner: true,
    interner,
    register: (type) => interner.intern(type),
    registerMany: (types) => interner.internList(types),
    getTelemetry: () => {
      const events = internerOptions.recordEvents ? interner.getEvents() : undefined;
      const telemetry = buildTelemetry(context, events);
      telemetry.pendingAliases = pendingAliases.size;
      return telemetry;
    },
    markAliasPending: (alias: TypeAlias) => {
      pendingAliases.add(alias);
    },
    resolveAlias: (alias: TypeAlias) => {
      pendingAliases.delete(alias);
      if (!alias.type) return undefined;
      const canonical = interner.intern(alias.type);
      alias.type = canonical;
      interner.intern(alias);
      return canonical;
    },
  };

  return context;
};

export const runWithTypeContext = <T>(
  context: SemanticsTypeContext | undefined,
  fn: () => T
): T => {
  return runWithSyntaxContext(context, fn);
};
