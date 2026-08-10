import { MSGPACK_HOST_TRANSPORT_CONTRACT_IDS } from "./function-contracts.js";

/** Build-selected provider roles retained and validated by generic host code. */
export const SELECTED_HOST_TRANSPORT_CONTRACT_IDS = Object.freeze(
  Object.values(MSGPACK_HOST_TRANSPORT_CONTRACT_IDS),
);
