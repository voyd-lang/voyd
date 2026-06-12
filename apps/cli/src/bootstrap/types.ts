import type { BootstrapTemplate } from "../config/types.js";

export type BootstrapConfig = {
  dir: string;
  template: BootstrapTemplate;
  dryRun?: boolean;
  force?: boolean;
};

export type BootstrapContext = {
  targetDir: string;
  packageName: string;
  voydVersion: string;
};

export type BootstrapFile = {
  path: string;
  content: string | Uint8Array;
};

export type BootstrapPlan = {
  template: BootstrapTemplate;
  files: BootstrapFile[];
  nextSteps: string[];
};

export type BootstrapLoader = {
  id: BootstrapTemplate;
  description: string;
  plan(ctx: BootstrapContext): BootstrapPlan;
};

export type BootstrapResult = {
  targetDir: string;
  template: BootstrapTemplate;
  dryRun: boolean;
  files: string[];
  nextSteps: string[];
};
