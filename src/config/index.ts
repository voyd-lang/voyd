import { getConfigFromCli } from "./cli.mjs";
import { VoidConfig } from "./types.mjs";

let config: VoidConfig | undefined = undefined;
export const getConfig = () => {
  if (config) return config;
  config = getConfigFromCli();
  return config;
};
