import type { BootstrapTemplate } from "../config/types.js";

export type BootstrapConfig = {
  dir: string;
  template: BootstrapTemplate;
  dryRun?: boolean;
  force?: boolean;
  usePublished?: boolean;
};

export type BootstrapVoydPackage =
  | "@voyd-lang/cli"
  | "@voyd-lang/compiler"
  | "@voyd-lang/js-host"
  | "@voyd-lang/lib"
  | "@voyd-lang/package-adapter"
  | "@voyd-lang/sdk"
  | "@voyd-lang/std"
  | "@voyd-lang/vx-dom"
  | "@voyd-lang/web";

export type BootstrapContext = {
  targetDir: string;
  packageName: string;
  voydVersion: string;
  localVoydRoot?: string;
  voydPackageSpec(name: BootstrapVoydPackage): string;
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
  localVoydRoot?: string;
  files: string[];
  nextSteps: string[];
};
