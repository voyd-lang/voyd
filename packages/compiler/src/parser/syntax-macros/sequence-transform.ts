import { type Expr, Form } from "../ast/index.js";
import { call } from "../ast/init-helpers.js";
import { cloneAttributes } from "../ast/syntax.js";

type SequenceTransformResult = { elements: Expr[]; changed: boolean };
type SequenceTransformer = (
  elements: readonly Expr[],
  allowAttributes: boolean,
) => SequenceTransformResult;

export const transformFormSequence = ({
  form,
  transform,
}: {
  form: Form;
  transform: SequenceTransformer;
}): Form => {
  if (form.callsInternal("ast")) {
    const { elements, changed } = transform(form.rest, true);
    if (!changed) {
      return form;
    }
    const wrapped = call("ast", ...elements);
    wrapped.setLocation(form.location?.clone());
    wrapped.attributes = cloneAttributes(form.attributes);
    return wrapped;
  }

  const { elements, changed } = transform(
    form.toArray(),
    form.calls("block") || form.callsInternal("ast"),
  );
  if (!changed) {
    return form;
  }
  const rebuilt = new (form.constructor as typeof Form)({
    location: form.location?.clone(),
    elements,
  });
  rebuilt.attributes = cloneAttributes(form.attributes);
  return rebuilt;
};
