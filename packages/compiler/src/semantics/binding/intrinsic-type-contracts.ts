import {
  getStdIntrinsicTypeContractSpec,
  type StdIntrinsicTypeContractProvider,
  type StdIntrinsicTypeProviderKind,
} from "../../compiler-contracts/index.js";
import type { BindingContext } from "./types.js";

type IntrinsicTypeDeclarationKind =
  | StdIntrinsicTypeProviderKind
  | "type-alias"
  | "trait";

export const resolveStdIntrinsicTypeContractProvider = ({
  id,
  declarationName,
  declarationKind,
  ctx,
}: {
  id: unknown;
  declarationName: string;
  declarationKind: IntrinsicTypeDeclarationKind;
  ctx: Pick<BindingContext, "module" | "packageId">;
}): StdIntrinsicTypeContractProvider | undefined => {
  if (typeof id !== "string") {
    return undefined;
  }
  const spec = getStdIntrinsicTypeContractSpec(id);
  if (!spec) {
    return undefined;
  }
  if (ctx.module.path.namespace !== "std" || ctx.packageId !== "std") {
    if (spec.outsideStd === "general-metadata") {
      return undefined;
    }
    throw new Error(
      `reserved @intrinsic_type '${id}' on ${declarationName} is restricted to the std namespace and package`,
    );
  }
  if (
    declarationKind === "type-alias" ||
    declarationKind === "trait" ||
    !spec.providerKinds.includes(declarationKind)
  ) {
    const expected = spec.providerKinds
      .map((kind) =>
        kind === "nominal-object" ? "nominal object" : "value object",
      )
      .join(" or ");
    throw new Error(
      `reserved @intrinsic_type '${id}' on ${declarationName} must annotate a ${expected}, not a ${declarationKind}`,
    );
  }
  return { id: spec.id, providerKind: declarationKind };
};
