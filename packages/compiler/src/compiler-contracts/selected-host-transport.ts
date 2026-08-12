export const SELECTED_HOST_TRANSPORT_IMPLEMENTATION = {
  id: "voyd.std.msgpack",
  version: 1,
  packageId: "std",
} as const;

/** Modules linked while source-level provider selection remains internal. */
export const SELECTED_HOST_TRANSPORT_PROVIDER_MODULES = [
  "std::msgpack",
  "std::msgpack::fns",
  "std::string",
] as const;
