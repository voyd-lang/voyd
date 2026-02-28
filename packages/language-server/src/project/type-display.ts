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
  normalizeOptionalParameterType,
}: {
  signature: FunctionSignature;
  formatType: (typeId: TypeId) => string;
  normalizeOptionalParameterType: (input: {
    typeId: TypeId;
    optional: boolean | undefined;
  }) => TypeId;
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
      const normalizedType = normalizeOptionalParameterType({
        typeId: parameter.type,
        optional: parameter.optional,
      });
      const typeText = formatType(normalizedType);
      return prefix
        ? `${prefix}${optionalSuffix}: ${typeText}`
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
  const nominalNameForTypeId = (typeId: TypeId): string | undefined => {
    const descriptor = semantics.typing.arena.get(typeId);
    if (descriptor.kind === "nominal-object") {
      return descriptor.name;
    }
    if (descriptor.kind === "intersection" && typeof descriptor.nominal === "number") {
      return nominalNameForTypeId(descriptor.nominal);
    }
    return undefined;
  };
  const optionalInnerType = (typeId: TypeId): TypeId | undefined => {
    const descriptor = semantics.typing.arena.get(typeId);
    if (descriptor.kind !== "union") {
      return undefined;
    }

    let someInner: TypeId | undefined;
    let hasNone = false;

    descriptor.members.forEach((member) => {
      const nominalName = nominalNameForTypeId(member);
      if (nominalName === "None") {
        hasNone = true;
        return;
      }

      if (nominalName !== "Some") {
        return;
      }

      const memberDescriptor = semantics.typing.arena.get(member);
      const someDescriptor =
        memberDescriptor.kind === "intersection" && typeof memberDescriptor.nominal === "number"
          ? semantics.typing.arena.get(memberDescriptor.nominal)
          : memberDescriptor;
      if (someDescriptor.kind === "nominal-object" && someDescriptor.typeArgs.length > 0) {
        someInner = someDescriptor.typeArgs[0];
      }
    });

    return hasNone && typeof someInner === "number" ? someInner : undefined;
  };
  const params = formatFunctionSignatureParameters({
    signature,
    formatType,
    normalizeOptionalParameterType: ({ typeId, optional }) =>
      optional ? (optionalInnerType(typeId) ?? typeId) : typeId,
  });
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
  displayName,
}: {
  ref: SymbolRef;
  semanticsByModule: ReadonlyMap<string, SemanticsPipelineResult>;
  typeParamNamesByModule: ReadonlyMap<string, ReadonlyMap<TypeParamId, string>>;
  displayName?: string;
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

  const symbolName = displayName ?? semantics.binding.symbolTable.getSymbol(ref.symbol).name;

  const findParameterSummary = (): string | undefined => {
    const toLocalParameter = ({
      ownerSymbol,
      params,
    }: {
      ownerSymbol: number;
      params: readonly { symbol: number }[];
    }): string | undefined => {
      const parameterIndex = params.findIndex((parameter) => parameter.symbol === ref.symbol);
      if (parameterIndex < 0) {
        return undefined;
      }

      const signature = semantics.typing.functions.getSignature(ownerSymbol);
      const parameter = signature?.parameters[parameterIndex];
      if (!parameter || typeof parameter.type !== "number") {
        return undefined;
      }

      const nominalNameForTypeId = (typeId: TypeId): string | undefined => {
        const descriptor = semantics.typing.arena.get(typeId);
        if (descriptor.kind === "nominal-object") {
          return descriptor.name;
        }
        if (descriptor.kind === "intersection" && typeof descriptor.nominal === "number") {
          return nominalNameForTypeId(descriptor.nominal);
        }
        return undefined;
      };

      const optionalInnerType = (typeId: TypeId): TypeId | undefined => {
        const descriptor = semantics.typing.arena.get(typeId);
        if (descriptor.kind !== "union") {
          return undefined;
        }

        let someInner: TypeId | undefined;
        let hasNone = false;

        descriptor.members.forEach((member) => {
          const nominalName = nominalNameForTypeId(member);
          if (nominalName === "None") {
            hasNone = true;
            return;
          }
          if (nominalName !== "Some") {
            return;
          }
          const memberDescriptor = semantics.typing.arena.get(member);
          const someDescriptor =
            memberDescriptor.kind === "intersection" &&
            typeof memberDescriptor.nominal === "number"
              ? semantics.typing.arena.get(memberDescriptor.nominal)
              : memberDescriptor;
          if (someDescriptor.kind === "nominal-object" && someDescriptor.typeArgs.length > 0) {
            someInner = someDescriptor.typeArgs[0];
          }
        });

        return hasNone && typeof someInner === "number" ? someInner : undefined;
      };

      const normalized = parameter.optional
        ? (optionalInnerType(parameter.type) ?? parameter.type)
        : parameter.type;
      const optionalSuffix = parameter.optional ? "?" : "";
      return `${symbolName}${optionalSuffix}: ${formatType(normalized)}`;
    };

    for (const fn of semantics.binding.functions) {
      const summary = toLocalParameter({
        ownerSymbol: fn.symbol,
        params: fn.params,
      });
      if (summary) {
        return summary;
      }
    }

    for (const trait of semantics.binding.traits) {
      for (const method of trait.methods) {
        const summary = toLocalParameter({
          ownerSymbol: method.symbol,
          params: method.params,
        });
        if (summary) {
          return summary;
        }
      }
    }

    for (const effect of semantics.binding.effects) {
      for (const operation of effect.operations) {
        const summary = toLocalParameter({
          ownerSymbol: operation.symbol,
          params: operation.parameters,
        });
        if (summary) {
          return summary;
        }
      }
    }

    return undefined;
  };

  const parameterSummary = findParameterSummary();
  if (parameterSummary) {
    return parameterSummary;
  }

  const directType = semantics.typing.valueTypes.get(ref.symbol);
  if (typeof directType === "number") {
    return `${symbolName}: ${formatType(directType)}`;
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
