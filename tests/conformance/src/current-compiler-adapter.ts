import { createSdk, type EffectHandler } from "@voyd-lang/sdk";
import type {
  ConformanceCompileResult,
  ConformanceCompilerAdapter,
  ConformanceEffectResponse,
  ConformanceHostInteraction,
} from "./compiler-adapter.js";

export const createCurrentCompilerAdapter = (): ConformanceCompilerAdapter => {
  const sdk = createSdk();

  return {
    async compile(request): Promise<ConformanceCompileResult> {
      const result = await sdk.compile(request);
      if (!result.success) {
        return {
          success: false,
          diagnostics: result.diagnostics.map((diagnostic) => ({
            code: diagnostic.code,
            message: diagnostic.message,
            phase: diagnostic.phase,
            span: diagnostic.span,
          })),
        };
      }

      return {
        success: true,
        wasm: result.wasm,
        program: {
          async run({ entryName, host }) {
            const interactions: ConformanceHostInteraction[] = [];
            const handlersByLabelSuffix = Object.fromEntries(
              Object.entries(host?.effects ?? {}).map(([label, response]) => [
                label,
                createEffectHandler({ label, response, interactions }),
              ]),
            );

            try {
              const value = await result.run({
                entryName,
                ...(Object.keys(handlersByLabelSuffix).length > 0
                  ? { handlersByLabelSuffix }
                  : {}),
              });
              return { success: true, value, interactions };
            } catch (error) {
              return {
                success: false,
                trap: normalizeRuntimeTrap(error),
                interactions,
              };
            }
          },
        },
      };
    },
  };
};

const createEffectHandler = ({
  label,
  response,
  interactions,
}: {
  label: string;
  response: ConformanceEffectResponse;
  interactions: ConformanceHostInteraction[];
}): EffectHandler =>
  ((
    control: {
      resume(value?: unknown): unknown;
      end(value?: unknown): unknown;
    },
    ...args: unknown[]
  ) => {
    interactions.push({ kind: "effect", label, args });
    return control[response.action](response.value);
  }) as EffectHandler;

export const normalizeRuntimeTrap = (
  error: unknown,
): { name: string; message: string } => {
  if (!(error instanceof WebAssembly.RuntimeError)) {
    throw error;
  }
  return { name: error.name, message: error.message };
};
