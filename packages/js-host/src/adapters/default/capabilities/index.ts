import type { CapabilityDefinition } from "../types.js";
import { envCapabilityDefinition } from "./env.js";
import { fsCapabilityDefinition } from "./fs.js";
import { httpClientCapabilityDefinition } from "./http-client.js";
import { httpServerCapabilityDefinition } from "./http-server.js";
import { inputCapabilityDefinition } from "./input.js";
import { logCapabilityDefinition } from "./log.js";
import { outputCapabilityDefinition } from "./output.js";
import { randomCapabilityDefinition } from "./random.js";
import { timeCapabilityDefinition } from "./time.js";

export const CAPABILITIES: CapabilityDefinition[] = [
  fsCapabilityDefinition,
  httpClientCapabilityDefinition,
  httpServerCapabilityDefinition,
  inputCapabilityDefinition,
  outputCapabilityDefinition,
  timeCapabilityDefinition,
  envCapabilityDefinition,
  randomCapabilityDefinition,
  logCapabilityDefinition,
];
