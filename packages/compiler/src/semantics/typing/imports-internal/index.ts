// Internal barrel for import-typing helpers.
// Name is `imports-internal` because `imports.ts` is the public API surface.
export {
  createTranslation,
  createTypeTranslation,
  mapTypeParam,
  translateFunctionSignature,
} from "../import-type-translation.js";
export {
  findExport,
  importTargetFor,
  makeDependencyContext,
  mapLocalSymbolToDependency,
} from "../import-resolution.js";
export {
  mapDependencySymbolToLocal,
  registerImportedObjectTemplate,
  registerImportedTraitDecl,
  registerImportedTraitImplTemplates,
} from "../import-symbol-mapping.js";
export { ensureImportedOwnerTemplatesAvailable } from "../import-owner-templates.js";
