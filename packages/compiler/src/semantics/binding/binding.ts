import type { BindingInputs, BindingResult } from "./types.js";
import { bindModule } from "./binders/index.js";
import { createBindingContext, toBindingResult } from "./context.js";
import {
  finalizeEffectOperationOverloadSets,
  finalizeOverloadSets,
} from "./overloads.js";
import { resolveSerializerAttributes } from "./serializer-attributes.js";
import { createSurfaceModuleView } from "../../parser/surface/index.js";
import { initializeModuleSurfaceForSemantics } from "../../modules/views.js";

export * from "./types.js";

export const runBindingPipeline = ({
  moduleForm,
  symbolTable,
  module,
  graph,
  moduleExports,
  moduleExportSurfaces,
  dependencies,
  includeTests,
}: BindingInputs): BindingResult => {
  const bindingContext = createBindingContext({
    moduleForm,
    symbolTable,
    module,
    graph,
    moduleExports,
    moduleExportSurfaces,
    dependencies,
    includeTests,
  });

  const surface = module
    ? initializeModuleSurfaceForSemantics({ module, moduleForm })
    : createSurfaceModuleView(moduleForm);
  if (surface.issues.length > 0) {
    throw new Error(surface.issues[0]!.message);
  }
  bindModule(surface, bindingContext);
  finalizeOverloadSets(bindingContext);
  finalizeEffectOperationOverloadSets(bindingContext);
  resolveSerializerAttributes(bindingContext);

  return toBindingResult(bindingContext);
};
