export const LINEAR_MEMORY_EXPORT = "memory";
export const EFFECTS_MEMORY_EXPORT = "effects_memory";

export const EFFECT_RESULT_STATUS = {
  value: 0,
  effect: 1,
} as const;

export const RESUME_KIND = {
  resume: 0,
  tail: 1,
} as const;

export const MIN_EFFECT_BUFFER_SIZE = 64 * 1024;
