import { formatEffectRow } from "@voyd/compiler/semantics/effects/format.js";
import type { TypeId, TypeParamId } from "@voyd/compiler/semantics/ids.js";
import type { SemanticsPipelineResult } from "@voyd/compiler/semantics/pipeline.js";
import type { FunctionSignature } from "@voyd/compiler/semantics/typing/types.js";
import type { TypeArena, TypeDescriptor } from "@voyd/compiler/semantics/typing/type-arena.js";
import type { SymbolRef } from "./types.js";

const formatTypeArguments = ({
  typeArgs,
  formatType,
}: {
  typeArgs: readonly TypeId[];
  formatType: (typeId: TypeId) => string;
}): string =>
  typeArgs.length === 0 ? "" : `<${typeArgs.map((arg) => formatType(arg)).join(", ")}>`;

const functionSignatureTypeParameters = ({
  signature,
  semantics,
}: {
  signature: FunctionSignature;
  semantics: SemanticsPipelineResult;
}): string => {
  const typeParams = signature.typeParams
    ?.map((param) => {
      try {
        return semantics.binding.symbolTable.getSymbol(param.symbol).name;
      } catch {
        return undefined;
      }
    })
    .filter((name): name is string => typeof name === "string");
  return typeParams && typeParams.length > 0 ? `<${typeParams.join(", ")}>` : "";
};

const formatFunctionSignatureParameters = ({
  signature,
  formatType,
}: {
  signature: FunctionSignature;
  formatType: (typeId: TypeId) => string;
}): string =>
  signature.parameters
    .map((parameter) => {
      const label = parameter.label;
      const name = parameter.name;
      const prefix =
        label && name && label !== name
          ? `${label} ${name}`
          : name ?? label;
      const optionalSuffix = parameter.optional ? "?" : "";
      const typeText = formatType(parameter.type);
      return prefix
        ? `${prefix}: ${typeText}${optionalSuffix}`
        : `${typeText}${optionalSuffix}`;
    })
    .join(", ");

const formatFunctionSignature = ({
  ref,
  semantics,
  signature,
  formatType,
}: {
  ref: SymbolRef;
  semantics: SemanticsPipelineResult;
  signature: FunctionSignature;
  formatType: (typeId: TypeId) => string;
}): string => {
  const functionName = semantics.binding.symbolTable.getSymbol(ref.symbol).name;
  const typeParameterSuffix = functionSignatureTypeParameters({
    signature,
    semantics,
  });
  const params = formatFunctionSignatureParameters({ signature, formatType });
  const returnType = formatType(signature.returnType);
  const effects = formatEffectRow(signature.effectRow, semantics.typing.effects);
  const effectSuffix = effects === "()" ? "" : ` ! ${effects}`;

  return `fn ${functionName}${typeParameterSuffix}(${params}) -> ${returnType}${effectSuffix}`;
};

const formatWithRecursionGuard = ({
  typeId,
  arena,
  formatTypeDescriptor,
  active,
}: {
  typeId: TypeId;
  arena: TypeArena;
  formatTypeDescriptor: (descriptor: TypeDescriptor, active: Set<TypeId>) => string;
  active: Set<TypeId>;
}): string => {
  if (active.has(typeId)) {
    return "recursive";
  }
  active.add(typeId);
  const text = formatTypeDescriptor(arena.get(typeId), active);
  active.delete(typeId);
  return text;
};

const formatTypeId = ({
  typeId,
  moduleId,
  semanticsByModule,
  typeParamNamesByModule,
}: {
  typeId: TypeId;
  moduleId: string;
  semanticsByModule: ReadonlyMap<string, SemanticsPipelineResult>;
  typeParamNamesByModule: ReadonlyMap<string, ReadonlyMap<TypeParamId, string>>;
}): string => {
  const moduleSemantics = semanticsByModule.get(moduleId);
  if (!moduleSemantics) {
    return "unknown";
  }

  const arena = moduleSemantics.typing.arena;
  const typeParamNames = typeParamNamesByModule.get(moduleId) ?? new Map();

  const formatTypeRef = (nestedTypeId: TypeId, active: Set<TypeId>): string =>
    formatWithRecursionGuard({
      typeId: nestedTypeId,
      arena,
      active,
      formatTypeDescriptor,
    });

  const resolveOwnerName = ({
    ownerModuleId,
    ownerSymbol,
    fallbackName,
  }: {
    ownerModuleId: string;
    ownerSymbol: number;
    fallbackName?: string;
  }): string => {
    if (fallbackName) {
      return fallbackName;
    }
    const ownerModule = semanticsByModule.get(ownerModuleId);
    if (!ownerModule) {
      return `${ownerSymbol}`;
    }
    return ownerModule.binding.symbolTable.getSymbol(ownerSymbol).name;
  };

  const formatTypeDescriptor = (
    descriptor: TypeDescriptor,
    active: Set<TypeId>,
  ): string => {
    switch (descriptor.kind) {
      case "primitive":
        return descriptor.name;
      case "type-param-ref":
        return typeParamNames.get(descriptor.param) ?? `T${descriptor.param}`;
      case "nominal-object": {
        const name = resolveOwnerName({
          ownerModuleId: descriptor.owner.moduleId,
          ownerSymbol: descriptor.owner.symbol,
          fallbackName: descriptor.name,
        });
        const typeArgs = formatTypeArguments({
          typeArgs: descriptor.typeArgs,
          formatType: (arg) => formatTypeRef(arg, active),
        });
        return `${name}${typeArgs}`;
      }
      case "trait": {
        const name = resolveOwnerName({
          ownerModuleId: descriptor.owner.moduleId,
          ownerSymbol: descriptor.owner.symbol,
          fallbackName: descriptor.name,
        });
        const typeArgs = formatTypeArguments({
          typeArgs: descriptor.typeArgs,
          formatType: (arg) => formatTypeRef(arg, active),
        });
        return `${name}${typeArgs}`;
      }
      case "structural-object":
        return `{ ${descriptor.fields
          .map((field) => {
            const optionalSuffix = field.optional ? "?" : "";
            return `${field.name}${optionalSuffix}: ${formatTypeRef(field.type, active)}`;
          })
          .join(", ")} }`;
      case "function": {
        const params = descriptor.parameters
          .map((param) => {
            const label = param.label ? `${param.label}: ` : "";
            const optionalSuffix = param.optional ? "?" : "";
            return `${label}${formatTypeRef(param.type, active)}${optionalSuffix}`;
          })
          .join(", ");
        const returnType = formatTypeRef(descriptor.returnType, active);
        const effects = formatEffectRow(descriptor.effectRow, moduleSemantics.typing.effects);
        const effectSuffix = effects === "()" ? "" : ` ! ${effects}`;
        return `(${params}) -> ${returnType}${effectSuffix}`;
      }
      case "union":
        return descriptor.members.map((member) => formatTypeRef(member, active)).join(" | ");
      case "intersection": {
        const parts: string[] = [];
        if (typeof descriptor.nominal === "number") {
          parts.push(formatTypeRef(descriptor.nominal, active));
        }
        if (descriptor.traits && descriptor.traits.length > 0) {
          descriptor.traits.forEach((trait) => parts.push(formatTypeRef(trait, active)));
        }
        if (typeof descriptor.structural === "number") {
          parts.push(formatTypeRef(descriptor.structural, active));
        }
        return parts.join(" & ");
      }
      case "fixed-array":
        return `Array<${formatTypeRef(descriptor.element, active)}>`;
      case "recursive":
        return formatTypeRef(descriptor.body, active);
      default:
        return "unknown";
    }
  };

  return formatTypeRef(typeId, new Set<TypeId>());
};

export const buildTypeParamNameIndex = ({
  semanticsByModule,
}: {
  semanticsByModule: ReadonlyMap<string, SemanticsPipelineResult>;
}): Map<string, Map<TypeParamId, string>> => {
  const namesByModule = new Map<string, Map<TypeParamId, string>>();

  semanticsByModule.forEach((semantics, moduleId) => {
    const names = new Map<TypeParamId, string>();
    for (const [, signature] of semantics.typing.functions.signatures) {
      signature.typeParams?.forEach((param) => {
        try {
          const name = semantics.binding.symbolTable.getSymbol(param.symbol).name;
          names.set(param.typeParam, name);
        } catch {
          // Imported signatures can retain external symbol ids that don't exist in this table.
        }
      });
    }
    namesByModule.set(moduleId, names);
  });

  return namesByModule;
};

export const typeSummaryForSymbol = ({
  ref,
  semanticsByModule,
  typeParamNamesByModule,
}: {
  ref: SymbolRef;
  semanticsByModule: ReadonlyMap<string, SemanticsPipelineResult>;
  typeParamNamesByModule: ReadonlyMap<string, ReadonlyMap<TypeParamId, string>>;
}): string | undefined => {
  const semantics = semanticsByModule.get(ref.moduleId);
  if (!semantics) {
    return undefined;
  }

  const functionSignature = semantics.typing.functions.getSignature(ref.symbol);
  const formatType = (typeId: TypeId): string =>
    formatTypeId({
      typeId,
      moduleId: ref.moduleId,
      semanticsByModule,
      typeParamNamesByModule,
    });

  if (functionSignature) {
    return formatFunctionSignature({
      ref,
      semantics,
      signature: functionSignature,
      formatType,
    });
  }

  const symbolName = semantics.binding.symbolTable.getSymbol(ref.symbol).name;

  const directType = semantics.typing.valueTypes.get(ref.symbol);
  if (typeof directType === "number") {
    return `${symbolName}: ${formatType(directType)}`;
  }

  for (const [, signature] of semantics.typing.functions.signatures) {
    const parameter = signature.parameters.find((entry) => entry.symbol === ref.symbol);
    if (parameter && typeof parameter.type === "number") {
      return `${symbolName}: ${formatType(parameter.type)}`;
    }
  }

  const instantiatedTypes = new Set<TypeId>();
  semantics.typing.functionInstanceValueTypes.forEach((valueTypes) => {
    const inferred = valueTypes.get(ref.symbol);
    if (typeof inferred === "number") {
      instantiatedTypes.add(inferred);
    }
  });

  if (instantiatedTypes.size === 0) {
    return undefined;
  }

  const inferredUnion = Array.from(instantiatedTypes.values())
    .map((typeId) => formatType(typeId))
    .join(" | ");
  return `${symbolName}: ${inferredUnion}`;
};
