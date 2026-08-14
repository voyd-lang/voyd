import type { OrdinaryMutationSummary } from "./borrowing/index.js";
import {
  PACKAGE_SEMANTIC_INTERFACE_SCHEMA,
  PACKAGE_SEMANTIC_INTERFACE_VERSION,
  type ModuleExportTable,
  type PackageCallableSignature,
  type PackageOrdinaryMutationSummary,
  type PackageSemanticInterface,
} from "./modules.js";
import {
  incrementCompilerPerfCounter,
  isCompilerPerfEnabled,
} from "../perf.js";
import type { HirGraph, HirTypeExpr } from "./hir/index.js";
import type { SymbolId, TypeId } from "./ids.js";
import type { TypingResult } from "./typing/typing.js";
import type { SymbolTable } from "./binder/index.js";
import type { SymbolRef } from "./typing/symbol-ref.js";

/**
 * Finalizes the durable caller-facing semantic boundary after export and
 * re-export reachability has been computed. Compiler-local ids and HIR nodes
 * never cross this boundary.
 */
export const buildPackageSemanticInterface = ({
  moduleId,
  exports,
  dependencyExports,
  hir,
  symbolTable,
  typing,
}: {
  moduleId: string;
  exports: ModuleExportTable;
  dependencyExports: ReadonlyMap<string, ModuleExportTable>;
  hir: HirGraph;
  symbolTable: SymbolTable;
  typing: TypingResult;
}): ModuleExportTable => {
  const keys = durableDeclarationKeys({
    moduleId,
    exports,
    hir,
    symbolTable,
  });
  const dependencyKeys = new Map<string, string>();
  dependencyExports.forEach((table, owner) => {
    table.forEach((entry) => {
      const declarations = table.packageSemanticInterface?.exports.find(
        (candidate) => candidate.name === entry.name,
      )?.declarations;
      (entry.symbols ?? [entry.symbol]).forEach((symbol, index) => {
        const key =
          declarations?.at(index)?.key ??
          `${owner}::export:${encodeDeclarationName(entry.name)}${index ? `#${index}` : ""}`;
        dependencyKeys.set(`${owner}:${symbol}`, key);
      });
    });
  });
  const durableRef = ({ moduleId: owner, symbol }: SymbolRef): string => {
    if (owner === moduleId) {
      return (
        keys.get(symbol) ??
        fallbackDeclarationKey(symbolTable, moduleId, symbol)
      );
    }
    return dependencyKeys.get(`${owner}:${symbol}`) ?? `${owner}::unresolved`;
  };
  const ordinaryMutationSummaries = new Map<string, OrdinaryMutationSummary>();
  const ordinaryMutationSummaryIdForSymbol = new Map<SymbolId, string>();
  const defaultIdentityGuardProtocols = new Set<SymbolId>();

  exports.forEach((entry) => {
    entry.defaultIdentityGuardProtocols?.forEach(({ symbol, protocol }) => {
      if (protocol === "presence-conflict-bit-v1") {
        defaultIdentityGuardProtocols.add(symbol);
      }
    });
    entry.ordinaryMutation?.forEach((ordinary) => {
      const { symbol, summary } = ordinary;
      const localKey =
        keys.get(symbol) ??
        fallbackDeclarationKey(symbolTable, moduleId, symbol);
      const locallyOwned = ordinary.summaryId === `${moduleId}:${symbol}`;
      const id = locallyOwned
        ? `${localKey}::ordinary-mutation`
        : ordinary.summaryId;
      ordinary.summaryId = id;
      ordinaryMutationSummaryIdForSymbol.set(symbol, id);
      if (!ordinaryMutationSummaries.has(id)) {
        ordinaryMutationSummaries.set(
          id,
          publicOrdinaryMutationSummary(summary),
        );
      }
    });
  });

  const typeEncoder = createPublicTypeEncoder({ typing, durableRef });
  const objectTypesByName = new Map(
    Array.from(typing.objects.templates(), (template) => [
      symbolTable.getSymbol(template.symbol).name,
      template.type,
    ]),
  );
  const objectDeclarationsByName = new Map(
    Array.from(hir.items.values()).flatMap((item) =>
      item.kind === "object"
        ? [[symbolTable.getSymbol(item.symbol).name, item] as const]
        : [],
    ),
  );
  const signatureFor = (
    symbol: SymbolId,
  ): PackageCallableSignature | undefined => {
    const signature = typing.functions.getSignature(symbol);
    if (!signature) {
      const value = typing.valueTypes.get(symbol);
      if (typeof value !== "number") return undefined;
      const descriptor = typing.arena.get(value);
      if (descriptor.kind !== "function") return undefined;
      return {
        parameters: descriptor.parameters.map((parameter) => ({
          type: typeEncoder.encodeType(parameter.type),
          ...(parameter.label ? { label: parameter.label } : {}),
          ...(parameter.bindingKind
            ? { bindingKind: parameter.bindingKind }
            : {}),
          ...(parameter.optional ? { optional: true } : {}),
          ...(parameter.defaulted ? { defaulted: true } : {}),
        })),
        returnType: typeEncoder.encodeType(descriptor.returnType),
        effects: typeEncoder.encodeEffects(descriptor.effectRow),
      };
    }
    return {
      ...(signature.typeParams
        ? {
            typeParameters: signature.typeParams.map((parameter) => ({
              key: typeEncoder.encodeTypeParameter(parameter.typeParam),
              ...(parameter.constraint
                ? { constraint: typeEncoder.encodeType(parameter.constraint) }
                : {}),
            })),
          }
        : {}),
      parameters: signature.parameters.map((parameter) => ({
        type: typeEncoder.encodeType(parameter.type),
        ...(parameter.label ? { label: parameter.label } : {}),
        ...(parameter.name ? { name: parameter.name } : {}),
        ...(parameter.bindingKind
          ? { bindingKind: parameter.bindingKind }
          : {}),
        ...(parameter.optional ? { optional: true } : {}),
        ...(parameter.defaulted ? { defaulted: true } : {}),
        ...(parameter.synthetic ? { synthetic: parameter.synthetic } : {}),
      })),
      returnType: typeEncoder.encodeType(signature.returnType),
      effects: typeEncoder.encodeEffects(signature.effectRow),
    };
  };
  const membersByOwner = new Map<
    SymbolId,
    PackageSemanticInterface["exports"][number]["members"]
  >();
  Array.from(hir.items.values()).forEach((item) => {
    if (item.kind !== "trait" && item.kind !== "effect") return;
    const members = (
      item.kind === "trait" ? item.methods : item.operations
    ).map((member, index) => {
      const signature = signatureFor(member.symbol);
      return {
        name: symbolTable.getSymbol(member.symbol).name,
        key: keys.get(member.symbol)!,
        kind:
          item.kind === "trait"
            ? ("trait-method" as const)
            : ("effect-operation" as const),
        ...(item.kind === "effect"
          ? { resumable: item.operations[index]!.resumable }
          : {}),
        ...(ordinaryMutationSummaryIdForSymbol.get(member.symbol)
          ? {
              ordinaryMutationSummaryId: ordinaryMutationSummaryIdForSymbol.get(
                member.symbol,
              ),
            }
          : {}),
        ...(defaultIdentityGuardProtocols.has(member.symbol)
          ? {
              defaultIdentityGuardProtocol: "presence-conflict-bit-v1" as const,
            }
          : {}),
        ...(signature ? { signature } : {}),
      };
    });
    membersByOwner.set(item.symbol, members);
  });
  exports.packageSemanticInterface = {
    schema: PACKAGE_SEMANTIC_INTERFACE_SCHEMA,
    version: PACKAGE_SEMANTIC_INTERFACE_VERSION,
    moduleId,
    ordinaryMutationSummaries: Array.from(
      ordinaryMutationSummaries,
      ([id, summary]) => ({ id, summary }),
    ),
    exports: Array.from(exports.values(), (entry) => ({
      name: entry.name,
      kind: entry.kind,
      visibility: entry.visibility,
      declarations: (entry.symbols ?? [entry.symbol]).map((symbol) => {
        const signature = signatureFor(symbol);
        const objectType =
          typing.objects.getTemplate(symbol)?.type ??
          objectTypesByName.get(entry.name);
        const value = objectType ?? typing.valueTypes.get(symbol);
        const fields = objectDeclarationsByName
          .get(entry.name)
          ?.fields.filter(
            (field) =>
              field.visibility.api === true ||
              field.visibility.level === "public",
          )
          .flatMap((field) => {
            const fieldType =
              typing.valueTypes.get(field.symbol) ?? field.type?.typeId;
            const encoded =
              typeof fieldType === "number"
                ? typeEncoder.encodeType(fieldType)
                : field.type
                  ? typeEncoder.encodeHirType(field.type)
                  : undefined;
            return encoded
              ? [
                  {
                    name: field.name,
                    type: encoded,
                    ...(field.optional ? { optional: true } : {}),
                  },
                ]
              : [];
          });
        return {
          key: keys.get(symbol)!,
          ...(ordinaryMutationSummaryIdForSymbol.get(symbol)
            ? {
                ordinaryMutationSummaryId:
                  ordinaryMutationSummaryIdForSymbol.get(symbol),
              }
            : {}),
          ...(defaultIdentityGuardProtocols.has(symbol)
            ? {
                defaultIdentityGuardProtocol:
                  "presence-conflict-bit-v1" as const,
              }
            : {}),
          ...(signature ? { signature } : {}),
          ...(typeof value === "number"
            ? { value: typeEncoder.encodeType(value) }
            : {}),
          ...(fields && fields.length > 0 ? { fields } : {}),
        };
      }),
      members: membersByOwner.get(entry.symbol) ?? [],
    })),
    types: typeEncoder.types,
  };
  if (isCompilerPerfEnabled()) {
    const retained = Array.from(ordinaryMutationSummaries.values());
    incrementCompilerPerfCounter("borrowing.contract.retainedCount", 0);
    incrementCompilerPerfCounter("borrowing.contract.retainedBytes", 0);
    incrementCompilerPerfCounter(
      "borrowing.ordinary.interfaceCount",
      retained.length,
    );
    incrementCompilerPerfCounter(
      "borrowing.ordinary.interfaceBytes",
      new TextEncoder().encode(JSON.stringify(retained)).byteLength,
    );
  }
  return exports;
};

const publicOrdinaryMutationSummary = (
  summary: OrdinaryMutationSummary,
): PackageOrdinaryMutationSummary => ({
  directAccesses: [...summary.directAccesses],
  reachableAccesses: [...summary.reachableAccesses],
  ambientAccess: summary.ambientAccess,
  reentrant: summary.reentrant,
  maySuspend: summary.maySuspend,
});

const durableDeclarationKeys = ({
  moduleId,
  exports,
  hir,
  symbolTable,
}: {
  moduleId: string;
  exports: ModuleExportTable;
  hir: HirGraph;
  symbolTable: SymbolTable;
}): ReadonlyMap<SymbolId, string> => {
  const result = new Map<SymbolId, string>();
  exports.forEach((entry) => {
    (entry.symbols ?? [entry.symbol]).forEach((symbol, index) =>
      result.set(
        symbol,
        `${moduleId}::export:${encodeDeclarationName(entry.name)}${index ? `#${index}` : ""}`,
      ),
    );
  });
  Array.from(hir.items.values()).forEach((item) => {
    if (item.kind !== "trait" && item.kind !== "effect") return;
    const owner = result.get(item.symbol);
    if (!owner) return;
    const counts = new Map<string, number>();
    (item.kind === "trait" ? item.methods : item.operations).forEach(
      (member) => {
        const name = symbolTable.getSymbol(member.symbol).name;
        const ordinal = counts.get(name) ?? 0;
        counts.set(name, ordinal + 1);
        result.set(
          member.symbol,
          `${owner}/${item.kind === "trait" ? "method" : "operation"}:${encodeDeclarationName(name)}${ordinal ? `#${ordinal}` : ""}`,
        );
      },
    );
  });
  return result;
};

const fallbackDeclarationKey = (
  symbolTable: SymbolTable,
  moduleId: string,
  symbol: SymbolId,
): string => {
  const record = symbolTable.getSymbol(symbol);
  return `${moduleId}::declaration:${record.kind}:${encodeDeclarationName(record.name)}`;
};

const encodeDeclarationName = (name: string): string =>
  Array.from(new TextEncoder().encode(name), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

const createPublicTypeEncoder = ({
  typing,
  durableRef,
}: {
  typing: TypingResult;
  durableRef: (reference: SymbolRef) => string;
}) => {
  const ids = new Map<TypeId, string>();
  const hirIds = new WeakMap<HirTypeExpr, string>();
  const typeParameters = new Map<number, string>();
  const types: { id: string; descriptor: unknown }[] = [];
  const encodeTypeParameter = (parameter: number): string => {
    if (!typeParameters.has(parameter)) {
      typeParameters.set(parameter, `p${typeParameters.size}`);
    }
    return typeParameters.get(parameter)!;
  };
  const encodeEffects = (row: number) => {
    const effects = typing.effects.getRow(row);
    return {
      operations: effects.operations.map(({ name, region }) => ({
        name,
        ...(typeof region === "number" ? { region } : {}),
      })),
      ...(effects.tailVar ? { tail: { rigid: effects.tailVar.rigid } } : {}),
    };
  };
  const encodeType = (type: TypeId): string => {
    const existing = ids.get(type);
    if (existing) return existing;
    const id = `t${ids.size}`;
    ids.set(type, id);
    const entry = { id, descriptor: undefined as unknown };
    types.push(entry);
    const descriptor = typing.arena.get(type);
    const encode = (nested: TypeId) => encodeType(nested);
    entry.descriptor = (() => {
      switch (descriptor.kind) {
        case "primitive":
          return { kind: descriptor.kind, name: descriptor.name };
        case "borrowed":
          return { kind: descriptor.kind, inner: encode(descriptor.inner) };
        case "recursive":
          return { kind: descriptor.kind, body: encode(descriptor.body) };
        case "trait":
        case "nominal-object":
        case "value-object":
          return {
            kind: descriptor.kind,
            declaration: durableRef(descriptor.owner),
            name: descriptor.name,
            typeArgs: descriptor.typeArgs.map(encode),
          };
        case "structural-object":
          return {
            kind: descriptor.kind,
            fields: descriptor.fields
              .filter(
                (field) =>
                  !field.visibility ||
                  field.visibility.api === true ||
                  field.visibility.level === "public",
              )
              .map((field) => ({
                name: field.name,
                optional: field.optional,
                visibility: field.visibility,
                type: encode(field.type),
              })),
          };
        case "function":
          return {
            kind: descriptor.kind,
            parameters: descriptor.parameters.map((parameter) => ({
              type: encode(parameter.type),
              ...(parameter.label ? { label: parameter.label } : {}),
              ...(parameter.bindingKind
                ? { bindingKind: parameter.bindingKind }
                : {}),
              ...(parameter.optional ? { optional: true } : {}),
              ...(parameter.defaulted ? { defaulted: true } : {}),
            })),
            returnType: encode(descriptor.returnType),
            effects: encodeEffects(descriptor.effectRow),
          };
        case "union":
          return {
            kind: descriptor.kind,
            members: descriptor.members.map(encode),
          };
        case "intersection":
          return {
            kind: descriptor.kind,
            ...(descriptor.nominal === undefined
              ? {}
              : { nominal: encode(descriptor.nominal) }),
            ...(descriptor.structural === undefined
              ? {}
              : { structural: encode(descriptor.structural) }),
            ...(descriptor.traits
              ? { traits: descriptor.traits.map(encode) }
              : {}),
          };
        case "fixed-array":
          return { kind: descriptor.kind, element: encode(descriptor.element) };
        case "type-param-ref":
          return {
            kind: descriptor.kind,
            parameter: encodeTypeParameter(descriptor.param),
          };
      }
    })();
    return id;
  };
  const encodeHirType = (type: HirTypeExpr): string => {
    const existing = hirIds.get(type);
    if (existing) return existing;
    const id = `t${types.length}`;
    hirIds.set(type, id);
    const entry = { id, descriptor: undefined as unknown };
    types.push(entry);
    const encode = (nested: HirTypeExpr) => encodeHirType(nested);
    entry.descriptor = (() => {
      switch (type.typeKind) {
        case "borrowed":
          return { kind: type.typeKind, inner: encode(type.inner) };
        case "named":
          return {
            kind: type.typeKind,
            path: [...type.path],
            typeArguments: type.typeArguments?.map(encode) ?? [],
          };
        case "object":
          return {
            kind: type.typeKind,
            exact: type.exact === true,
            fields: type.fields.map((field) => ({
              name: field.name,
              optional: field.optional === true,
              type: encode(field.type),
            })),
          };
        case "tuple":
          return { kind: type.typeKind, elements: type.elements.map(encode) };
        case "union":
        case "intersection":
          return { kind: type.typeKind, members: type.members.map(encode) };
        case "function":
          return {
            kind: type.typeKind,
            parameters: type.parameters.map((parameter) => ({
              type: encode(parameter.type),
              optional: parameter.optional === true,
              ...(parameter.bindingKind
                ? { bindingKind: parameter.bindingKind }
                : {}),
            })),
            returnType: encode(type.returnType),
            ...(type.effectType ? { effectType: encode(type.effectType) } : {}),
          };
        case "self":
          return { kind: type.typeKind };
      }
    })();
    return id;
  };
  return {
    encodeType,
    encodeHirType,
    encodeTypeParameter,
    encodeEffects,
    types,
  };
};
