export type MethodSignatureKeyParam = {
  label?: string;
  name?: string;
  typeKey?: string;
};

export type MethodSignatureKeyInput = {
  methodName: string;
  typeParamCount: number;
  params: readonly MethodSignatureKeyParam[];
};

const signaturePayload = ({
  methodName,
  typeParamCount,
  params,
  includeTypes,
}: MethodSignatureKeyInput & { includeTypes: boolean }) => ({
  methodName,
  typeParamCount,
  paramCount: params.length,
  params: params.map((param) => ({
    label: param.label ?? null,
    ...(includeTypes ? { typeKey: param.typeKey ?? null } : {}),
  })),
});

export const methodSignatureShapeKey = (
  input: MethodSignatureKeyInput,
): string => JSON.stringify(signaturePayload({ ...input, includeTypes: false }));

export const methodSignatureKey = (input: MethodSignatureKeyInput): string =>
  JSON.stringify(signaturePayload({ ...input, includeTypes: true }));

export const formatMethodSignature = ({
  methodName,
  typeParamCount,
  params,
}: MethodSignatureKeyInput): string => {
  const typeParams = typeParamCount > 0 ? `<${typeParamCount}>` : "";
  const renderedParams = params
    .map((param, index) => {
      const displayName =
        param.label && param.name && param.label !== param.name
          ? `${param.label} ${param.name}`
          : (param.label ?? param.name ?? `arg${index + 1}`);
      return `${displayName}: ${param.typeKey ?? "_"}`;
    })
    .join(", ");
  return `${methodName}${typeParams}(${renderedParams})`;
};
