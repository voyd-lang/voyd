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
  useInterner?: boolean;
  internerOptions?: TypeInternerOptions;
  internDuringResolution?: boolean;
};

export type TypeContext = {
  readonly useInterner: boolean;
  readonly interner?: TypeInterner;
  readonly internDuringResolution: boolean;
  internType<T extends Type | undefined>(type: T): T;
  getTelemetry(): TypeContextTelemetry | undefined;
};

let activeContext: TypeContext | undefined;

export const createTypeContext = (
  options: TypeContextOptions = {}
): TypeContext => {
  const {
    useInterner = false,
    internerOptions,
    internDuringResolution = false,
  } = options;
  const interner = useInterner ? new TypeInterner(internerOptions) : undefined;
  return {
    useInterner: Boolean(interner),
    interner,
    internDuringResolution,
    internType<T extends Type | undefined>(type: T): T {
      if (!interner || !type) return type;
      return interner.intern(type) as T;
    },
    getTelemetry(): TypeContextTelemetry | undefined {
      if (!interner) return undefined;
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
  if (!context || !context.useInterner || !context.internDuringResolution) {
    return type;
  }
  return context.internType(type);
};

export const getTypeContextTelemetry = (): TypeContextTelemetry | undefined =>
  activeContext?.getTelemetry();
