import type { HirVisibility } from "./hir/index.js";
import type { OverloadSetId, SymbolId } from "./ids.js";
import type { SymbolKind } from "./binder/index.js";
import type { ModulePath } from "../modules/types.js";
import type { CallableBorrowContract } from "./borrowing/index.js";

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
  borrowing?: readonly {
    symbol: SymbolId;
    contract: CallableBorrowContract;
  }[];
}

export type ModuleExportTable = Map<string, ModuleExportEntry>;

export interface ModuleExportSurfaceEntry {
  name: string;
  moduleId: string;
  modulePath: ModulePath;
  packageId: string;
  kind: SymbolKind;
  visibility: HirVisibility;
}

export type ModuleExportSurfaceTable = Map<string, ModuleExportSurfaceEntry>;
