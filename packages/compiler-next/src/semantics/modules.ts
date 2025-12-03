import type { SymbolId } from "./ids.js";
import type { HirVisibility } from "./hir/index.js";
import type { SymbolKind } from "./binder/index.js";

export interface ModuleExportEntry {
  name: string;
  symbol: SymbolId;
  symbols?: readonly SymbolId[];
  overloadSet?: OverloadSetId;
  moduleId: string;
  kind: SymbolKind;
  visibility: HirVisibility;
}

export type ModuleExportTable = Map<string, ModuleExportEntry>;
