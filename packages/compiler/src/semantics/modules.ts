import type { HirVisibility } from "./hir/index.js";
import type { OverloadSetId, SymbolId } from "./ids.js";
import type { SymbolKind } from "./binder/index.js";
import type { ModulePath } from "../modules/types.js";

export interface ModuleExportEffect {
  symbol: SymbolId;
  annotated: boolean;
  operations: readonly { name: string; region?: number }[];
  tail?: { rigid: boolean };
}

export interface ModuleExportEntry {
  name: string;
  symbol: SymbolId;
  symbols?: readonly SymbolId[];
  overloadSet?: OverloadSetId;
  moduleId: string;
  modulePath: ModulePath;
  packageId: string;
  kind: SymbolKind;
  visibility: HirVisibility;
  memberOwner?: SymbolId;
  isStatic?: boolean;
  apiProjection?: boolean;
  effects?: readonly ModuleExportEffect[];
}

export type ModuleExportTable = Map<string, ModuleExportEntry>;
