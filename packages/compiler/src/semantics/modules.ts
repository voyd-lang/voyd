import type { HirBindingKind, HirVisibility } from "./hir/index.js";
import type { OverloadSetId, SymbolId } from "./ids.js";
import type { SymbolKind } from "./binder/index.js";
import type { ModulePath } from "../modules/types.js";
import type {
  CallableBorrowContract,
  CallableBorrowDispatchKind,
  CallableBorrowSummarySource,
  LoanAnalysisMode,
  PlaceProjection,
  PublicNamedBorrowContract,
  CallableBorrowSummary,
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
    /** Canonical entry in the owning module's package borrow interface. */
    summaryId: string;
    capability?: LoanAnalysisMode;
    contract: CallableBorrowContract;
    dispatch?: CallableBorrowDispatchKind;
    namedContract?: PublicNamedBorrowContract;
    source?: CallableBorrowSummarySource;
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
    contract: CallableBorrowContract;
  }[];
}

export interface ModuleExportTable extends Map<string, ModuleExportEntry> {
  /** Versioned module-level metadata preserved through public re-exports. */
  borrowingTraitImplementations?: readonly ModuleBorrowingTraitImplementation[];
  /** Stable caller-facing metadata; compiler-private typing state is excluded. */
  packageSemanticInterface?: PackageSemanticInterface;
}

export const PACKAGE_SEMANTIC_INTERFACE_SCHEMA =
  "voyd.package-semantic-interface" as const;
export const PACKAGE_SEMANTIC_INTERFACE_VERSION = 1 as const;

export type PackageSemanticInterface = {
  schema: typeof PACKAGE_SEMANTIC_INTERFACE_SCHEMA;
  version: typeof PACKAGE_SEMANTIC_INTERFACE_VERSION;
  moduleId: string;
  /** Summaries are stored once and referenced by exports/re-exports. */
  summaries: readonly {
    id: string;
    summary: CallableBorrowSummary;
  }[];
  exports: readonly {
    name: string;
    kind: SymbolKind;
    visibility: HirVisibility;
    declarations: readonly {
      key: string;
      summaryId?: string;
      capability?: LoanAnalysisMode;
      signature?: PackageCallableSignature;
      value?: string;
      fields?: readonly {
        name: string;
        type: string;
        optional?: boolean;
      }[];
    }[];
    members: readonly {
      name: string;
      key: string;
      kind: "trait-method" | "effect-operation";
      resumable?: "ctl" | "fn";
      summaryId?: string;
      capability?: LoanAnalysisMode;
      signature?: PackageCallableSignature;
    }[];
  }[];
  coercions: readonly PackageCoercion[];
  callableResultCoercions: readonly PackageCoercion[];
  traitImplementations: readonly {
    concrete: string;
    trait: string;
    implementation: string;
    methods: readonly {
      implementation: string;
      declaration: string;
      summaryId: string;
    }[];
  }[];
  types: readonly { id: string; descriptor: unknown }[];
};

export type PackageCallableSignature = {
  typeParameters?: readonly { key: string; constraint?: string }[];
  parameters: readonly {
    type: string;
    label?: string;
    name?: string;
    bindingKind?: HirBindingKind;
    optional?: boolean;
    defaulted?: boolean;
    synthetic?: "stable-callsite-id";
  }[];
  returnType: string;
  effects: {
    operations: readonly { name: string; region?: number }[];
    tail?: { rigid: boolean };
  };
};

type PackageCoercion = {
  concrete: string;
  trait: string;
  implementation: string;
  resultPaths?: readonly (readonly PlaceProjection[])[];
  resultType?: string;
  applicability?: readonly {
    callable: string;
    omissionRequirements?: readonly (readonly number[])[];
  }[];
  summaryId: string;
};

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
  if (table.packageSemanticInterface) {
    cloned.packageSemanticInterface = {
      ...table.packageSemanticInterface,
      summaries: table.packageSemanticInterface.summaries.map((entry) => ({
        ...entry,
      })),
      exports: table.packageSemanticInterface.exports.map((entry) => ({
        ...entry,
        declarations: entry.declarations.map((declaration) => ({
          ...declaration,
        })),
        members: entry.members.map((member) => ({ ...member })),
      })),
      coercions: [...table.packageSemanticInterface.coercions],
      callableResultCoercions: [
        ...table.packageSemanticInterface.callableResultCoercions,
      ],
      traitImplementations: [
        ...table.packageSemanticInterface.traitImplementations,
      ],
      types: [...table.packageSemanticInterface.types],
    };
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
