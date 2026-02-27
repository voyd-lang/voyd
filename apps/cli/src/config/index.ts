import { getConfigFromCli } from "./arg-parser.js";
import type { VoydConfig } from "./types.js";

let config: VoydConfig | undefined = undefined;

export const getConfig = () => {
  if (config) {
    return config;
  }
  config = getConfigFromCli();
  return config;
};
