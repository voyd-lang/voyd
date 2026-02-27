import type { CapabilityDefinition } from "../types.js";
import { envCapabilityDefinition } from "./env.js";
import { fetchCapabilityDefinition } from "./fetch.js";
import { fsCapabilityDefinition } from "./fs.js";
import { inputCapabilityDefinition } from "./input.js";
import { logCapabilityDefinition } from "./log.js";
import { outputCapabilityDefinition } from "./output.js";
import { randomCapabilityDefinition } from "./random.js";
import { timeCapabilityDefinition } from "./time.js";

export const CAPABILITIES: CapabilityDefinition[] = [
  fsCapabilityDefinition,
  fetchCapabilityDefinition,
  inputCapabilityDefinition,
  outputCapabilityDefinition,
  timeCapabilityDefinition,
  envCapabilityDefinition,
  randomCapabilityDefinition,
  logCapabilityDefinition,
];
