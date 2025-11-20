import type { BindingInputs, BindingResult } from "./types.js";
import { bindModule } from "./binders.js";
import { createBindingContext, toBindingResult } from "./context.js";
import { finalizeOverloadSets } from "./overloads.js";

export * from "./types.js";

export const runBindingPipeline = ({
  moduleForm,
  symbolTable,
}: BindingInputs): BindingResult => {
  const bindingContext = createBindingContext({ moduleForm, symbolTable });

  bindModule(moduleForm, bindingContext);
  finalizeOverloadSets(bindingContext);

  return toBindingResult(bindingContext);
};
