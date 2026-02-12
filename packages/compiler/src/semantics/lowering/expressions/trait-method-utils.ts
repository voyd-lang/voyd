import { isIdentifierAtom } from "../../../parser/index.js";

type TraitMethodLike = {
  params: readonly { name: string; ast?: unknown }[];
};

export const traitMethodHasSelfReceiver = ({
  params,
}: TraitMethodLike): boolean => {
  const receiver = params[0];
  if (!receiver) {
    return false;
  }
  if (receiver.name === "self") {
    return true;
  }
  return Boolean(
    receiver.ast &&
      isIdentifierAtom(receiver.ast) &&
      receiver.ast.value === "self",
  );
};
