import type binaryen from "binaryen";
import type {
  CodegenContext,
  HirExprId,
  SymbolId,
  TypeId,
} from "../../context.js";
import type { ResumeKind } from "../runtime-abi.js";

export type ContinuationFieldSource =
  | "param"
  | "local"
  | "handler"
  | "site";

export interface ContinuationEnvField {
  name: string;
  symbol?: SymbolId;
  typeId: TypeId;
  wasmType: binaryen.Type;
  sourceKind: ContinuationFieldSource;
  tempId?: number;
}

export interface ContinuationSiteBase {
  exprId: HirExprId;
  siteId: number;
  siteOrder: number;
  owner: ContinuationSiteOwner;
  contFnName: string;
  contRefType?: binaryen.Type;
  baseEnvType: binaryen.Type;
  envType: binaryen.Type;
  envFields: readonly ContinuationEnvField[];
  handlerAtSite: boolean;
  resumeValueTypeId: TypeId;
}

export interface ContinuationPerformSite extends ContinuationSiteBase {
  kind: "perform";
  effectSymbol: SymbolId;
  effectId: number;
  opId: number;
  resumeKind: ResumeKind;
  argsType?: binaryen.Type;
}

export interface ContinuationCallSite extends ContinuationSiteBase {
  kind: "call";
}

export type ContinuationSite = ContinuationPerformSite | ContinuationCallSite;

export interface EffectLoweringResult {
  sitesByExpr: Map<HirExprId, ContinuationSite>;
  sites: readonly ContinuationSite[];
  argsTypes: Map<SymbolId, binaryen.Type>;
  callArgTemps: Map<
    HirExprId,
    readonly { argIndex: number; tempId: number; typeId: TypeId }[]
  >;
  tempTypeIds: Map<number, TypeId>;
}

export type ContinuationSiteOwner =
  | { kind: "function"; symbol: SymbolId }
  | { kind: "lambda"; exprId: HirExprId };

export type SiteCounter = { current: number };

export type BuildEffectLoweringParams = {
  ctx: CodegenContext;
  siteCounter: SiteCounter;
};

