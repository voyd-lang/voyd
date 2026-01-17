export const MSGPACK_WRITE_VALUE = "__voyd_msgpack_write_value";
export const MSGPACK_WRITE_EFFECT = "__voyd_msgpack_write_effect";
export const MSGPACK_READ_VALUE = "__voyd_msgpack_read_value";
export const LINEAR_MEMORY_EXPORT = "memory";
// Memory names are indices ("0", "1") after seeding via readBinary.
export const LINEAR_MEMORY_INTERNAL = "0";
export const EFFECTS_MEMORY_EXPORT = "effects_memory";
export const EFFECTS_MEMORY_INTERNAL = "1";

export const VALUE_TAG = {
  none: 0,
  i32: 1,
  i64: 2,
  f32: 3,
  f64: 4,
} as const;

export const EFFECT_RESULT_STATUS = {
  value: 0,
  effect: 1,
} as const;

export const MIN_EFFECT_BUFFER_SIZE = 4 * 1024;
