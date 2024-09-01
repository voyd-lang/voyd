import { getConfigFromCli } from "./cli.js";
import { VoidConfig } from "./types.js";

let config: VoidConfig | undefined = undefined;
export const getConfig = () => {
  if (config) return config;
  config = getConfigFromCli();
  return config;
};