import {
  formCallsInternal,
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
  type Form,
  type Syntax,
} from "@voyd/compiler/parser/index.js";

export type LabeledArgumentSyntax = {
  label: string;
  syntax: Syntax;
};

export const findMethodNameSyntax = ({
  callForm,
  methodName,
}: {
  callForm: Form;
  methodName: string;
}): Syntax | undefined => {
  const methodFromMember = (member: unknown): Syntax | undefined => {
    if (isIdentifierAtom(member) || isInternalIdentifierAtom(member)) {
      return member.value === methodName ? member : undefined;
    }

    if (!isForm(member)) {
      return undefined;
    }

    const head = member.at(0);
    if ((isIdentifierAtom(head) || isInternalIdentifierAtom(head)) && head.value === methodName) {
      return head;
    }

    return undefined;
  };

  if (callForm.calls(".")) {
    return methodFromMember(callForm.at(2));
  }

  if (!callForm.calls("::")) {
    return undefined;
  }

  const member = callForm.at(2);
  if (isForm(member) && member.calls("::")) {
    return methodFromMember(member.at(2));
  }

  return methodFromMember(member);
};

export const findLabeledArgumentSyntaxes = ({
  callForm,
}: {
  callForm: Form;
}): LabeledArgumentSyntax[] => {
  if (callForm.calls(".")) {
    const memberExpr = callForm.at(2);
    const member =
      isForm(memberExpr) && memberExpr.calls("::")
        ? memberExpr.at(2)
        : memberExpr;
    return isForm(member) ? labeledArgumentsFromCallMember(member) : [];
  }

  if (callForm.calls("::")) {
    const member = callForm.at(2);
    return isForm(member) ? labeledArgumentsFromCallMember(member) : [];
  }

  return labeledArgumentsFromCallMember(callForm);
};

const labeledArgumentsFromCallMember = (member: Form): LabeledArgumentSyntax[] => {
  const hasTypeArguments =
    isForm(member.at(1)) && formCallsInternal(member.at(1) as Form, "generics");
  const startIndex = hasTypeArguments ? 2 : 1;
  return member
    .toArray()
    .slice(startIndex)
    .flatMap((arg): LabeledArgumentSyntax[] => {
      if (!(isForm(arg) && arg.calls(":"))) {
        return [];
      }
      const labelExpr = arg.at(1);
      if (!(isIdentifierAtom(labelExpr) || isInternalIdentifierAtom(labelExpr))) {
        return [];
      }
      return [{ label: labelExpr.value, syntax: labelExpr }];
    });
};
