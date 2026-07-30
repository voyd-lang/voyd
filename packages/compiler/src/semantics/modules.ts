import type { HirVisibility } from "./hir/index.js";
import type { OverloadSetId, SymbolId } from "./ids.js";
import type { SymbolKind } from "./binder/index.js";
import type { ModulePath } from "../modules/types.js";
import type {
  CallableBorrowContract,
  PlaceProjection,
} from "./borrowing/index.js";
import type { SymbolRef } from "./typing/symbol-ref.js";

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
    /** Versioned separate-compilation payload consumed by dependents. */
    serialized?: string;
    serializedBytes?: number;
    /**
     * Decoded compatibility view for semantic clients. Dependency analysis
     * deliberately consumes `serialized` instead.
     */
    contract: CallableBorrowContract;
  }[];
  borrowingCoercions?: readonly {
    concrete: SymbolRef;
    trait: SymbolRef;
    implementation: SymbolRef;
    /** Exact result projections at which the implementation is reachable. */
    resultPaths?: readonly (readonly PlaceProjection[])[];
    /** Public nominal variant that must carry the reachable implementation. */
    resultType?: SymbolRef;
    /**
     * Callable-specific alternatives that make this implementation
     * reachable. Absent means the coercion is unconditionally reachable.
     */
    applicability?: readonly {
      callable: SymbolRef;
      omissionRequirements?: readonly (readonly number[])[];
    }[];
    /** Versioned separate-compilation payload consumed by dependents. */
    serialized: string;
    serializedBytes: number;
    /** Decoded compatibility view; dependency analysis uses `serialized`. */
    contract: CallableBorrowContract;
  }[];
  /**
   * Implementations reachable only after invoking a callable value returned
   * by this export (for example an omitted callback default).
   */
  borrowingCallableResultCoercions?: readonly {
    concrete: SymbolRef;
    trait: SymbolRef;
    implementation: SymbolRef;
    resultPaths?: readonly (readonly PlaceProjection[])[];
    resultType?: SymbolRef;
    applicability?: readonly {
      callable: SymbolRef;
      omissionRequirements?: readonly (readonly number[])[];
    }[];
    serialized: string;
    serializedBytes: number;
    contract: CallableBorrowContract;
  }[];
}

export interface ModuleBorrowingTraitImplementation {
  concrete: SymbolRef;
  trait: SymbolRef;
  implementation: SymbolRef;
  methods: readonly {
    implementation: SymbolRef;
    declaration: SymbolRef;
    /** Versioned exact trait-declaration contract. */
    serialized: string;
    serializedBytes: number;
    /** Decoded compatibility view; dependency analysis uses `serialized`. */
    contract: CallableBorrowContract;
  }[];
}

export interface ModuleExportTable extends Map<string, ModuleExportEntry> {
  /** Versioned module-level metadata preserved through public re-exports. */
  borrowingTraitImplementations?: readonly ModuleBorrowingTraitImplementation[];
}

export const cloneModuleExportTable = (
  table: ModuleExportTable,
): ModuleExportTable => {
  const cloned: ModuleExportTable = new Map(table);
  if (table.borrowingTraitImplementations) {
    cloned.borrowingTraitImplementations =
      table.borrowingTraitImplementations.map((implementation) => ({
        ...implementation,
        methods: implementation.methods.map((method) => ({ ...method })),
      }));
  }
  return cloned;
};

export interface ModuleExportSurfaceEntry {
  name: string;
  moduleId: string;
  modulePath: ModulePath;
  packageId: string;
  kind: SymbolKind;
  visibility: HirVisibility;
}

export type ModuleExportSurfaceTable = Map<string, ModuleExportSurfaceEntry>;
