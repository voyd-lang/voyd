import type { ResumeKind } from "./runtime-abi.js";

export interface EffectTableOp {
  id: number;
  name: string;
  label: string;
  resumeKind: ResumeKind;
}

export interface EffectTableEffect {
  id: number;
  name: string;
  label: string;
  ops: EffectTableOp[];
}

export interface EffectTableSidecar {
  version: number;
  moduleId: string;
  tableExport: string;
  namesBlob: string;
  effects: EffectTableEffect[];
}
