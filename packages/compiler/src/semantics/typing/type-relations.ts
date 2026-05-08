import type { SourceSpan, TypeId, TypeParamId } from "../ids.js";
import type { UnificationResult } from "./type-arena.js";
import type { TypingContext, TypingState } from "./types.js";
import {
  bindTypeParamsFromType,
  narrowTypeForPattern,
  typeSatisfies,
  unifyWithBudget,
} from "./type-system.js";

export interface TypeRelations {
  satisfies(
    actual: TypeId,
    expected: TypeId,
    ctx: TypingContext,
    state: TypingState,
  ): boolean;
  unify(args: {
    actual: TypeId;
    expected: TypeId;
    options: Parameters<typeof unifyWithBudget>[0]["options"];
    ctx: TypingContext;
    span?: SourceSpan;
  }): UnificationResult;
  narrowForPattern(
    discriminantType: TypeId,
    patternType: TypeId,
    ctx: TypingContext,
    state: TypingState,
  ): TypeId | undefined;
  bindTypeParams(
    expected: TypeId,
    actual: TypeId,
    bindings: Map<TypeParamId, TypeId>,
    ctx: TypingContext,
    state: TypingState,
  ): void;
}

export const typeRelations: TypeRelations = {
  satisfies: typeSatisfies,
  unify: unifyWithBudget,
  narrowForPattern: narrowTypeForPattern,
  bindTypeParams: bindTypeParamsFromType,
};

export const satisfies = typeRelations.satisfies;
export const unify = typeRelations.unify;
export const narrowForPattern = typeRelations.narrowForPattern;
export const bindTypeParams = typeRelations.bindTypeParams;
