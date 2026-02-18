import type {
  HirFunctionTypeParameter,
  HirRecordTypeField,
  HirTypeExpr,
  HirTypeParameter,
} from "./index.js";

export const substituteTypeParametersInTypeExpr = ({
  typeExpr,
  substitutionsByName,
}: {
  typeExpr: HirTypeExpr;
  substitutionsByName: ReadonlyMap<string, HirTypeExpr | undefined>;
}): HirTypeExpr => {
  if (typeExpr.typeKind === "named") {
    const typeName = typeExpr.path.length === 1 ? typeExpr.path[0] : undefined;
    const replacement =
      typeof typeName === "string"
        ? substitutionsByName.get(typeName)
        : undefined;
    if (replacement) {
      return replacement;
    }
    if (!typeExpr.typeArguments || typeExpr.typeArguments.length === 0) {
      return typeExpr;
    }
    const nextArgs = mapTypeExprList(typeExpr.typeArguments, substitutionsByName);
    return nextArgs === typeExpr.typeArguments
      ? typeExpr
      : {
          ...typeExpr,
          typeArguments: nextArgs,
        };
  }

  if (typeExpr.typeKind === "object") {
    const nextFields = mapFieldList(typeExpr.fields, substitutionsByName);
    return nextFields === typeExpr.fields
      ? typeExpr
      : {
          ...typeExpr,
          fields: nextFields,
        };
  }

  if (typeExpr.typeKind === "tuple") {
    const nextElements = mapTypeExprList(typeExpr.elements, substitutionsByName);
    return nextElements === typeExpr.elements
      ? typeExpr
      : {
          ...typeExpr,
          elements: nextElements,
        };
  }

  if (
    typeExpr.typeKind === "union" ||
    typeExpr.typeKind === "intersection"
  ) {
    const nextMembers = mapTypeExprList(typeExpr.members, substitutionsByName);
    return nextMembers === typeExpr.members
      ? typeExpr
      : {
          ...typeExpr,
          members: nextMembers,
        };
  }

  if (typeExpr.typeKind === "function") {
    const nextTypeParameters = mapTypeParameterList(
      typeExpr.typeParameters,
      substitutionsByName,
    );
    const nextParameters = mapFunctionTypeParameterList(
      typeExpr.parameters,
      substitutionsByName,
    );
    const nextReturnType = substituteTypeParametersInTypeExpr({
      typeExpr: typeExpr.returnType,
      substitutionsByName,
    });
    const nextEffectType = typeExpr.effectType
      ? substituteTypeParametersInTypeExpr({
          typeExpr: typeExpr.effectType,
          substitutionsByName,
        })
      : undefined;
    const changed =
      nextTypeParameters !== typeExpr.typeParameters ||
      nextParameters !== typeExpr.parameters ||
      nextReturnType !== typeExpr.returnType ||
      nextEffectType !== typeExpr.effectType;
    return changed
      ? {
          ...typeExpr,
          typeParameters: nextTypeParameters,
          parameters: nextParameters,
          returnType: nextReturnType,
          effectType: nextEffectType,
        }
      : typeExpr;
  }

  return typeExpr;
};

const mapTypeExprList = (
  entries: readonly HirTypeExpr[],
  substitutionsByName: ReadonlyMap<string, HirTypeExpr | undefined>,
): readonly HirTypeExpr[] => {
  let changed = false;
  const next = entries.map((entry) => {
    const resolved = substituteTypeParametersInTypeExpr({
      typeExpr: entry,
      substitutionsByName,
    });
    changed ||= resolved !== entry;
    return resolved;
  });
  return changed ? next : entries;
};

const mapFieldList = (
  fields: readonly HirRecordTypeField[],
  substitutionsByName: ReadonlyMap<string, HirTypeExpr | undefined>,
): readonly HirRecordTypeField[] => {
  let changed = false;
  const next = fields.map((field) => {
    const resolvedType = substituteTypeParametersInTypeExpr({
      typeExpr: field.type,
      substitutionsByName,
    });
    if (resolvedType === field.type) {
      return field;
    }
    changed = true;
    return {
      ...field,
      type: resolvedType,
    };
  });
  return changed ? next : fields;
};

const mapTypeParameterList = (
  parameters: readonly HirTypeParameter[] | undefined,
  substitutionsByName: ReadonlyMap<string, HirTypeExpr | undefined>,
): readonly HirTypeParameter[] | undefined => {
  if (!parameters || parameters.length === 0) {
    return parameters;
  }
  let changed = false;
  const next = parameters.map((parameter) => {
    const nextConstraint = parameter.constraint
      ? substituteTypeParametersInTypeExpr({
          typeExpr: parameter.constraint,
          substitutionsByName,
        })
      : undefined;
    const nextDefaultType = parameter.defaultType
      ? substituteTypeParametersInTypeExpr({
          typeExpr: parameter.defaultType,
          substitutionsByName,
        })
      : undefined;
    if (
      nextConstraint === parameter.constraint &&
      nextDefaultType === parameter.defaultType
    ) {
      return parameter;
    }
    changed = true;
    return {
      ...parameter,
      constraint: nextConstraint,
      defaultType: nextDefaultType,
    };
  });
  return changed ? next : parameters;
};

const mapFunctionTypeParameterList = (
  parameters: readonly HirFunctionTypeParameter[],
  substitutionsByName: ReadonlyMap<string, HirTypeExpr | undefined>,
): readonly HirFunctionTypeParameter[] => {
  let changed = false;
  const next = parameters.map((parameter) => {
    const resolvedType = substituteTypeParametersInTypeExpr({
      typeExpr: parameter.type,
      substitutionsByName,
    });
    if (resolvedType === parameter.type) {
      return parameter;
    }
    changed = true;
    return {
      ...parameter,
      type: resolvedType,
    };
  });
  return changed ? next : parameters;
};
