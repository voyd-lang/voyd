import type { TypeId } from "./ids.js";
import type { SemanticsPipelineResult } from "./pipeline.js";
import type { SymbolRef } from "./typing/symbol-ref.js";
import { symbolRefKey } from "./typing/symbol-ref.js";
import type { ObjectTemplate, ObjectTypeInfo } from "./typing/types.js";

export type ProgramSemanticsIndex = {
  getModule(moduleId: string): SemanticsPipelineResult | undefined;
  getSymbolName(ref: SymbolRef): string | undefined;
  getObjectTemplate(ref: SymbolRef): ObjectTemplate | undefined;
  getObjectInfoByNominal(nominal: TypeId): ObjectTypeInfo | undefined;
};

export const buildProgramSemanticsIndex = (
  modules: readonly SemanticsPipelineResult[]
): ProgramSemanticsIndex => {
  const modulesById = new Map<string, SemanticsPipelineResult>(
    modules.map((mod) => [mod.moduleId, mod] as const)
  );

  const symbolNameByRef = new Map<string, string>();
  const objectTemplateByOwner = new Map<string, ObjectTemplate>();
  const objectInfoByNominal = new Map<TypeId, ObjectTypeInfo>();

  modules.forEach((mod) => {
    mod.typing.objects.templates().forEach((template) => {
      objectTemplateByOwner.set(
        symbolRefKey({ moduleId: mod.moduleId, symbol: template.symbol }),
        template
      );
    });

    mod.typing.objectsByNominal.forEach((info, nominal) => {
      objectInfoByNominal.set(nominal, info);
    });
  });

  const getModule = (moduleId: string): SemanticsPipelineResult | undefined =>
    modulesById.get(moduleId);

  const getSymbolName = (ref: SymbolRef): string | undefined => {
    const key = symbolRefKey(ref);
    const cached = symbolNameByRef.get(key);
    if (cached) {
      return cached;
    }
    const mod = modulesById.get(ref.moduleId);
    const record = mod?.symbolTable.getSymbol(ref.symbol);
    if (!record) {
      return undefined;
    }
    symbolNameByRef.set(key, record.name);
    return record.name;
  };

  const getObjectTemplate = (ref: SymbolRef): ObjectTemplate | undefined =>
    objectTemplateByOwner.get(symbolRefKey(ref));

  const getObjectInfoByNominal = (nominal: TypeId): ObjectTypeInfo | undefined =>
    objectInfoByNominal.get(nominal);

  return {
    getModule,
    getSymbolName,
    getObjectTemplate,
    getObjectInfoByNominal,
  };
};

