import type binaryen from "binaryen";
import type { CodegenContext } from "../context.js";

export const RUNTIME_DIAGNOSTICS_SECTION = "voyd.runtime_diagnostics";
const RUNTIME_DIAGNOSTICS_VERSION = 1;

type RuntimeDiagnosticsSourceSpan = {
  file: string;
  start: number;
  end: number;
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
};

type RuntimeDiagnosticsFunctionEntry = {
  wasmName: string;
  moduleId: string;
  functionName: string;
  span: RuntimeDiagnosticsSourceSpan;
};

type RuntimeDiagnosticsSection = {
  version: number;
  functions: RuntimeDiagnosticsFunctionEntry[];
};

const toOneBasedColumn = (value: number | undefined): number | undefined =>
  typeof value === "number" ? value + 1 : undefined;

const functionNameFor = ({
  ctx,
  symbol,
}: {
  ctx: CodegenContext;
  symbol: number;
}): string => {
  const id = ctx.program.symbols.idOf({ moduleId: ctx.moduleId, symbol });
  return ctx.program.symbols.getName(id) ?? `${symbol}`;
};

export const emitRuntimeDiagnosticsSection = ({
  contexts,
  mod,
}: {
  contexts: readonly CodegenContext[];
  mod: binaryen.Module;
}): void => {
  const byWasmName = new Map<string, RuntimeDiagnosticsFunctionEntry>();

  contexts.forEach((ctx) => {
    const metasBySymbol = ctx.functions.get(ctx.moduleId);
    if (!metasBySymbol) {
      return;
    }
    ctx.module.hir.items.forEach((item) => {
      if (item.kind !== "function") {
        return;
      }
      const metas = metasBySymbol.get(item.symbol);
      if (!metas || metas.length === 0) {
        return;
      }
      const location = ctx.module.functionLocations.get(item.symbol);
      const span: RuntimeDiagnosticsSourceSpan = {
        file: item.span.file,
        start: item.span.start,
        end: item.span.end,
        ...(location
          ? {
              startLine: location.startLine,
              startColumn: toOneBasedColumn(location.startColumn),
              endLine: location.endLine,
              endColumn: toOneBasedColumn(location.endColumn),
            }
          : {}),
      };
      const functionName = functionNameFor({ ctx, symbol: item.symbol });
      metas.forEach((meta) => {
        if (byWasmName.has(meta.wasmName)) {
          return;
        }
        byWasmName.set(meta.wasmName, {
          wasmName: meta.wasmName,
          moduleId: ctx.moduleId,
          functionName,
          span,
        });
      });
    });
  });

  if (byWasmName.size === 0) {
    return;
  }

  const payload: RuntimeDiagnosticsSection = {
    version: RUNTIME_DIAGNOSTICS_VERSION,
    functions: Array.from(byWasmName.values()).sort((a, b) =>
      a.wasmName.localeCompare(b.wasmName)
    ),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  mod.addCustomSection(RUNTIME_DIAGNOSTICS_SECTION, bytes);
};
