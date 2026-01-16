import type { ResumeKind } from "./runtime-abi.js";

export interface EffectTableOpEntry {
  opIndex: number;
  effectId: string;
  effectIdHash: string;
  opId: number;
  resumeKind: ResumeKind;
  signatureHash: number;
  label: string;
}

export interface EffectTableSidecar {
  version: number;
  moduleId: string;
  tableExport: string;
  namesBlob: string;
  ops: EffectTableOpEntry[];
}
