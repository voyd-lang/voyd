import { createSurfaceModuleView } from "../parser/surface/index.js";
import type {
  ModuleHeaderView,
  SurfaceModuleView,
} from "../parser/surface/index.js";
import type { Form } from "../parser/index.js";
import type { ModuleNode } from "./types.js";

export const requireModuleHeader = (module: ModuleNode): ModuleHeaderView => {
  if (!module.header) {
    throw new Error(
      `module ${module.id} has no base-syntax header; it must be created before macro expansion`,
    );
  }
  return module.header;
};

export const requireModuleSurface = (module: ModuleNode): SurfaceModuleView => {
  if (!module.surface) {
    throw new Error(
      `module ${module.id} has no expanded surface; macro expansion must finish before semantics`,
    );
  }
  if (module.surface.ast !== module.ast) {
    throw new Error(
      `module ${module.id} expanded surface is stale for its current AST`,
    );
  }
  return module.surface;
};

/** Materializes the expanded surface exactly once at the semantics phase entry. */
export const initializeModuleSurfaceForSemantics = ({
  module,
  moduleForm,
}: {
  module: ModuleNode;
  moduleForm: Form;
}): SurfaceModuleView => {
  if (module.ast !== moduleForm) {
    throw new Error(`module ${module.id} binding input does not match its AST`);
  }
  if (!module.surface) {
    module.surface = createSurfaceModuleView(moduleForm);
  }
  return requireModuleSurface(module);
};
