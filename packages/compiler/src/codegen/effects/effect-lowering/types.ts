import type binaryen from "binaryen";
import type {
  CodegenContext,
  HirExprId,
  SymbolId,
  TypeId,
} from "../../context.js";

export type ContinuationFieldSource =
  | "param"
  | "local"
  | "handler"
  | "site";

export type ContinuationCaptureSource =
  | "param"
  | "local"
  | "temp";

export interface ContinuationCaptureField {
  sourceKind: ContinuationCaptureSource;
  typeId: TypeId;
  symbol?: SymbolId;
  tempId?: number;
}

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
  contBaseName: string;
  baseEnvType: binaryen.Type;
  envType: binaryen.Type;
  envFields: readonly ContinuationEnvField[];
  handlerAtSite: boolean;
  resumeValueTypeId: TypeId;
}

export interface ContinuationSiteEirBase {
  exprId: HirExprId;
  siteId: number;
  siteOrder: number;
  owner: ContinuationSiteOwner;
  contBaseName: string;
  handlerAtSite: boolean;
  resumeValueTypeId: TypeId;
  captureFields: readonly ContinuationCaptureField[];
}

export interface ContinuationPerformSite extends ContinuationSiteBase {
  kind: "perform";
  effectSymbol: SymbolId;
}

export interface ContinuationCallSite extends ContinuationSiteBase {
  kind: "call";
}

export type ContinuationSite = ContinuationPerformSite | ContinuationCallSite;

export interface ContinuationPerformSiteEir extends ContinuationSiteEirBase {
  kind: "perform";
  effectSymbol: SymbolId;
}

export interface ContinuationCallSiteEir extends ContinuationSiteEirBase {
  kind: "call";
}

export type ContinuationSiteEir = ContinuationPerformSiteEir | ContinuationCallSiteEir;

export interface EffectLoweringResult {
  sitesByExpr: Map<HirExprId, ContinuationSite>;
  sites: readonly ContinuationSite[];
  callArgTemps: Map<
    HirExprId,
    readonly { argIndex: number; tempId: number; typeId: TypeId }[]
  >;
  tempTypeIds: Map<number, TypeId>;
}

export interface EffectLoweringEirResult {
  sitesByExpr: Map<HirExprId, ContinuationSiteEir>;
  sites: readonly ContinuationSiteEir[];
  callArgTemps: Map<
    HirExprId,
    readonly { argIndex: number; tempId: number; typeId: TypeId }[]
  >;
  tempTypeIds: Map<number, TypeId>;
}

export type ContinuationSiteOwner =
  | { kind: "function"; symbol: SymbolId }
  | { kind: "lambda"; exprId: HirExprId }
  | { kind: "handler-clause"; handlerExprId: HirExprId; clauseIndex: number };

export type SiteCounter = { current: number };

export type BuildEffectLoweringParams = {
  ctx: CodegenContext;
  siteCounter: SiteCounter;
};
