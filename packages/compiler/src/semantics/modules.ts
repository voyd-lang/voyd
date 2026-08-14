import type { HirBindingKind, HirVisibility } from "./hir/index.js";
import type { OverloadSetId, SymbolId } from "./ids.js";
import type { SymbolKind } from "./binder/index.js";
import type { ModulePath } from "../modules/types.js";
import type { OrdinaryMutationSummary } from "./borrowing/index.js";
import type { EffectOp } from "./effects/effect-table.js";

export interface ModuleExportEffect {
  symbol: SymbolId;
  annotated: boolean;
  operations: readonly EffectOp[];
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
  /**
   * Per-symbol member metadata retained when an exported member shares its
   * display name with an ordinary module export or another member.
   */
  memberSymbols?: readonly {
    symbol: SymbolId;
    owner: SymbolId;
    isStatic: boolean;
  }[];
  effects?: readonly ModuleExportEffect[];
  /** Bounded whole-parameter mutation summaries, separate from borrow ABI. */
  ordinaryMutation?: readonly {
    symbol: SymbolId;
    /** Canonical entry in the owning module's finite mutation interface. */
    summaryId: string;
    summary: OrdinaryMutationSummary;
  }[];
  /** Finite ABI opt-in for guards emitted after omitted defaults execute. */
  defaultIdentityGuardProtocols?: readonly {
    symbol: SymbolId;
    protocol: "presence-conflict-bit-v1";
  }[];
}

export const moduleNamespaceExportEntry = (
  exported: ModuleExportEntry,
): ModuleExportEntry | undefined => {
  const symbols =
    exported.symbols && exported.symbols.length > 0
      ? exported.symbols
      : [exported.symbol];
  const instanceMembers = new Set(
    (exported.memberSymbols ?? [])
      .filter((member) => !member.isStatic)
      .map((member) => member.symbol),
  );
  const moduleSymbols = symbols.filter(
    (symbol) => !instanceMembers.has(symbol),
  );
  if (moduleSymbols.length === 0) {
    return undefined;
  }

  return {
    ...exported,
    symbol: moduleSymbols.includes(exported.symbol)
      ? exported.symbol
      : moduleSymbols[0]!,
    symbols: moduleSymbols,
  };
};

export const firstInstanceMemberOwner = (
  exported: ModuleExportEntry,
): SymbolId | undefined =>
  exported.memberSymbols?.find((member) => !member.isStatic)?.owner ??
  (exported.isStatic !== true ? exported.memberOwner : undefined);

export interface ModuleExportTable extends Map<string, ModuleExportEntry> {
  /** Stable caller-facing metadata; compiler-private typing state is excluded. */
  packageSemanticInterface?: PackageSemanticInterface;
}

export const PACKAGE_SEMANTIC_INTERFACE_SCHEMA =
  "voyd.package-semantic-interface" as const;
export const PACKAGE_SEMANTIC_INTERFACE_VERSION = 4 as const;

export type PackageOrdinaryMutationSummary = OrdinaryMutationSummary;

export type PackageSemanticInterface = {
  schema: typeof PACKAGE_SEMANTIC_INTERFACE_SCHEMA;
  version: typeof PACKAGE_SEMANTIC_INTERFACE_VERSION;
  moduleId: string;
  ordinaryMutationSummaries: readonly {
    id: string;
    summary: PackageOrdinaryMutationSummary;
  }[];
  exports: readonly {
    name: string;
    kind: SymbolKind;
    visibility: HirVisibility;
    declarations: readonly {
      key: string;
      ordinaryMutationSummaryId?: string;
      defaultIdentityGuardProtocol?: "presence-conflict-bit-v1";
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
      ordinaryMutationSummaryId?: string;
      defaultIdentityGuardProtocol?: "presence-conflict-bit-v1";
      signature?: PackageCallableSignature;
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

export const cloneModuleExportTable = (
  table: ModuleExportTable,
): ModuleExportTable => {
  const cloned: ModuleExportTable = new Map(table);
  if (table.packageSemanticInterface) {
    cloned.packageSemanticInterface = {
      ...table.packageSemanticInterface,
      ordinaryMutationSummaries:
        table.packageSemanticInterface.ordinaryMutationSummaries.map(
          (entry) => ({
            ...entry,
            summary: {
              ...entry.summary,
              directAccesses: [...entry.summary.directAccesses],
              reachableAccesses: [...entry.summary.reachableAccesses],
            },
          }),
        ),
      exports: table.packageSemanticInterface.exports.map((entry) => ({
        ...entry,
        declarations: entry.declarations.map((declaration) => ({
          ...declaration,
        })),
        members: entry.members.map((member) => ({ ...member })),
      })),
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
