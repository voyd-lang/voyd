import type { TypeId } from "../../ids.js";
import type { TypingContext, TypingState } from "../types.js";

export const applyCurrentSubstitution = (
  type: TypeId,
  ctx: TypingContext,
  state: TypingState
): TypeId =>
  state.currentFunction?.substitution
    ? ctx.arena.substitute(type, state.currentFunction.substitution)
    : type;
