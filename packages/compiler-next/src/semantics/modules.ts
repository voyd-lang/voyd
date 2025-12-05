import type { HirVisibility } from "./hir/index.js";
import type { OverloadSetId, SymbolId } from "./ids.js";
import type { SymbolKind } from "./binder/index.js";
import type { ModulePath } from "../modules/types.js";

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
}

export type ModuleExportTable = Map<string, ModuleExportEntry>;
