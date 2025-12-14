export const MSGPACK_WRITE_VALUE = "__voyd_msgpack_write_value";
export const MSGPACK_WRITE_EFFECT = "__voyd_msgpack_write_effect";
export const MSGPACK_READ_VALUE = "__voyd_msgpack_read_value";

export const VALUE_TAG = {
  none: 0,
  i32: 1,
} as const;

export const EFFECT_RESULT_STATUS = {
  value: 0,
  effect: 1,
} as const;

export const MIN_EFFECT_BUFFER_SIZE = 4 * 1024;

