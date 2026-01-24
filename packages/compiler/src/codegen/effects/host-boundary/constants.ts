export const LINEAR_MEMORY_EXPORT = "memory";
// Memory names are indices ("0", "1") after seeding via readBinary.
export const LINEAR_MEMORY_INTERNAL = "0";
export const EFFECTS_MEMORY_EXPORT = "effects_memory";
export const EFFECTS_MEMORY_INTERNAL = "1";

export const EFFECTS_HOST_BOUNDARY_STD_DEPS = [
  "std::msgpack",
  "std::string",
] as const;

export const EFFECT_RESULT_STATUS = {
  value: 0,
  effect: 1,
} as const;

export const EFFECT_REQUEST_MSGPACK_KEYS = {
  effectId: "effectId",
  opId: "opId",
  opIndex: "opIndex",
  resumeKind: "resumeKind",
  handle: "handle",
  args: "args",
} as const;

export const MIN_EFFECT_BUFFER_SIZE = 4 * 1024;
