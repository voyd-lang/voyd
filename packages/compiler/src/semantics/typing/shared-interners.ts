import type { EffectTable } from "../effects/effect-table.js";
import type { TypeArena } from "./type-arena.js";

/**
 * Shared interner means effect-row ids are interchangeable, even when each
 * module has its own EffectTable state (expr/function caches).
 */
export const effectsShareInterner = (
  source: EffectTable,
  target: EffectTable,
): boolean => source === target || source.internRow === target.internRow;

/**
 * Typing contexts can safely reuse ids without translation when they share the
 * same type arena and effect-row interner.
 */
export const typingContextsShareInterners = ({
  sourceArena,
  targetArena,
  sourceEffects,
  targetEffects,
}: {
  sourceArena: TypeArena;
  targetArena: TypeArena;
  sourceEffects: EffectTable;
  targetEffects: EffectTable;
}): boolean =>
  sourceArena === targetArena &&
  effectsShareInterner(sourceEffects, targetEffects);
