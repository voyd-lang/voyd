import { Type } from "../../syntax-objects/types.js";
import {
  TypeInterner,
  type TypeInternerEvent,
  type TypeInternerOptions,
  type TypeInternerStats,
} from "./type-interner.js";

export type TypeContextTelemetry = {
  stats: TypeInternerStats;
  events: TypeInternerEvent[];
};

export type TypeContextOptions = {
  internerOptions?: TypeInternerOptions;
  internDuringResolution?: boolean;
};

export type TypeContext = {
  readonly interner: TypeInterner;
  readonly internDuringResolution: boolean;
  internType<T extends Type | undefined>(type: T): T;
  getTelemetry(): TypeContextTelemetry | undefined;
};

let activeContext: TypeContext | undefined;

export const createTypeContext = (
  options: TypeContextOptions = {}
): TypeContext => {
  const { internerOptions, internDuringResolution = false } = options;
  const interner = new TypeInterner(internerOptions);
  return {
    interner,
    internDuringResolution,
    internType<T extends Type | undefined>(type: T): T {
      if (!type) return type;
      return interner.intern(type) as T;
    },
    getTelemetry(): TypeContextTelemetry | undefined {
      return {
        stats: interner.getStats(),
        events: interner.getEvents(),
      };
    },
  };
};

export const withTypeContext = <T>(
  context: TypeContext,
  callback: () => T
): T => {
  const previous = activeContext;
  activeContext = context;
  try {
    return callback();
  } finally {
    activeContext = previous;
  }
};

export const getActiveTypeContext = (): TypeContext | undefined => activeContext;

export const internTypeWithContext = <T extends Type | undefined>(type: T): T => {
  const context = getActiveTypeContext();
  if (!context || !context.internDuringResolution) {
    return type;
  }
  return context.internType(type);
};

export const internTypeImmediately = <T extends Type | undefined>(type: T): T => {
  const context = getActiveTypeContext();
  if (!context) return type;
  return context.internType(type);
};

export const getTypeContextTelemetry = (): TypeContextTelemetry | undefined =>
  activeContext?.getTelemetry();
