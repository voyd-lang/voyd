import type { BindingInputs, BindingResult } from "./types.js";
import { bindModule } from "./binders/index.js";
import { createBindingContext, toBindingResult } from "./context.js";
import { finalizeOverloadSets } from "./overloads.js";

export * from "./types.js";

export const runBindingPipeline = ({
  moduleForm,
  symbolTable,
  module,
  graph,
  moduleExports,
}: BindingInputs): BindingResult => {
  const bindingContext = createBindingContext({
    moduleForm,
    symbolTable,
    module,
    graph,
    moduleExports,
  });

  bindModule(moduleForm, bindingContext);
  finalizeOverloadSets(bindingContext);

  return toBindingResult(bindingContext);
};
