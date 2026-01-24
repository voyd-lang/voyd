import type { BindingInputs, BindingResult } from "./types.js";
import { bindModule } from "./binders/index.js";
import { createBindingContext, toBindingResult } from "./context.js";
import { finalizeEffectOperationOverloadSets, finalizeOverloadSets } from "./overloads.js";
import { resolveSerializerAttributes } from "./serializer-attributes.js";

export * from "./types.js";

export const runBindingPipeline = ({
  moduleForm,
  symbolTable,
  module,
  graph,
  moduleExports,
  dependencies,
  includeTests,
}: BindingInputs): BindingResult => {
  const bindingContext = createBindingContext({
    moduleForm,
    symbolTable,
    module,
    graph,
    moduleExports,
    dependencies,
    includeTests,
  });

  bindModule(moduleForm, bindingContext);
  finalizeOverloadSets(bindingContext);
  finalizeEffectOperationOverloadSets(bindingContext);
  resolveSerializerAttributes(bindingContext);

  return toBindingResult(bindingContext);
};
