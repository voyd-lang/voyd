import binaryen from "binaryen";
import type { CodegenContext, HirExpression, HirExprId, TypeId } from "../../context.js";
import { createEffectRuntime } from "../../effects/runtime-abi.js";
import { createEffectsState } from "../../effects/state.js";
import { selectEffectsBackend } from "../../effects/codegen-backend.js";
import { DiagnosticEmitter } from "../../../diagnostics/index.js";
import { createProgramHelperRegistry } from "../../program-helpers.js";

type TypeDescriptor =
  | { kind: "primitive"; name: string }
  | { kind: "fixed-array"; element: TypeId }
  | { kind: "structural-object"; fields: { name: string; type: TypeId; optional: boolean }[] };

export const createTestCodegenContext = (): {
  ctx: CodegenContext;
  descriptors: Map<TypeId, TypeDescriptor>;
  exprTypes: Map<HirExprId, TypeId>;
  expressions: Map<HirExprId, HirExpression>;
} => {
  const mod = new binaryen.Module();
  mod.setFeatures(binaryen.Features.All);
  const effectsRuntime = createEffectRuntime(mod);
  const diagnostics = new DiagnosticEmitter();
  const programHelpers = createProgramHelperRegistry();

  const descriptors = new Map<TypeId, TypeDescriptor>();
  const exprTypes = new Map<HirExprId, TypeId>();
  const expressions = new Map<HirExprId, HirExpression>();

  const moduleView = {
    moduleId: "test",
    meta: {
      moduleId: "test",
      packageId: "test",
      isPackageRoot: true,
      imports: [],
      effects: [],
    },
    hir: { expressions } as any,
    effects: { isEmpty: () => true, getRow: () => ({ operations: [] }) } as any,
    types: {
      getExprType: (id: number) => exprTypes.get(id) as any,
      getResolvedExprType: (id: number) => exprTypes.get(id) as any,
      getValueType: () => undefined,
      getTailResumption: () => undefined,
    },
    effectsInfo: {
      functions: new Map(),
      operations: new Map(),
      handlers: new Map(),
      calls: new Map(),
      handlerTails: new Map(),
      lambdas: new Map(),
    },
  } as const;

  const ctx: CodegenContext = {
    mod,
    moduleId: "test",
    moduleLabel: "test",
    program: {
      effects: {
        isEmpty: () => true,
        getRow: () => ({ operations: [] }),
        getOrderedModules: () => ["test"],
        getGlobalId: () => undefined,
        getByGlobalId: () => undefined,
        getEffectCount: () => 0,
      } as any,
      primitives: {
        unknown: -1,
        void: -2,
        bool: -3,
        i32: -4,
        i64: -5,
        f32: -6,
        f64: -7,
        defaultEffectRow: 0,
      } as any,
      types: {
        getTypeDesc: (id: number) => {
          const desc = descriptors.get(id);
          if (!desc) {
            throw new Error(`missing descriptor for type ${id}`);
          }
          return desc as any;
        },
        getScheme: () => ({ id: 0, params: [], body: 0 }),
        instantiate: () => 0,
        unify: () => ({ ok: false, conflict: { left: 0, right: 0, message: "unsupported" } }),
        substitute: (typeId: number) => typeId,
        getNominalOwner: () => undefined,
        getNominalAncestry: () => [],
        getStructuralLayout: () => undefined,
        getRuntimeTypeId: (typeId: number) => typeId,
      },
      symbols: {
        getName: () => undefined,
        getLocalName: () => undefined,
        getPackageId: () => undefined,
        getIntrinsicType: () => undefined,
        getIntrinsicFunctionFlags: () => ({
          intrinsic: false,
          intrinsicUsesSignature: false,
        }),
        getIntrinsicName: () => undefined,
        isModuleScoped: () => false,
      },
      functions: {
        getSignature: () => undefined,
        getInstantiationInfo: () => undefined,
        getInstanceExprType: () => undefined,
        getFunctionId: () => undefined,
        getInstanceId: () => undefined,
        getFunctionRef: () => undefined,
        getInstance: () => ({
          functionId: 0 as any,
          typeArgs: [],
          symbolRef: { moduleId: "test", symbol: 0 },
        }),
        formatInstance: () => "instance0",
      },
      optionals: { getOptionalInfo: () => undefined },
      objects: {
        getTemplate: () => undefined,
        getInfoByNominal: () => undefined,
        getNominalOwnerRef: () => undefined,
        getNominalInstancesByOwner: () => [],
      },
      traits: {
        getImplsByNominal: () => [],
        getImplsByTrait: () => [],
        getTraitMethodImpl: () => undefined,
      },
      calls: {
        getCallInfo: () => ({ traitDispatch: false }),
      },
      instances: { getAll: () => [], getById: () => undefined },
      imports: {
        getLocal: () => undefined,
        getTarget: () => undefined,
      },
      modules: new Map([["test", moduleView as any]]),
    } as any,
    module: moduleView as any,
    diagnostics,
    options: {
      optimize: false,
      validate: false,
      emitEffectHelpers: false,
      continuationBackend: {},
      testMode: false,
      effectsHostBoundary: "off",
      testScope: "all",
    },
    programHelpers,
    functions: new Map(),
    functionInstances: new Map() as any,
    itemsToSymbols: new Map(),
    structTypes: new Map(),
    structHeapTypes: new Map(),
    structuralIdCache: new Map(),
    resolvingStructuralIds: new Set(),
    fixedArrayTypes: new Map(),
    closureTypes: new Map(),
    functionRefTypes: new Map(),
    recursiveBinders: new Map(),
    runtimeTypeRegistry: new Map(),
    runtimeTypeIds: { byKey: new Map(), nextId: { value: 1 } },
    lambdaEnvs: new Map(),
    lambdaFunctions: new Map(),
    rtt: { baseType: binaryen.none, extensionHelpers: { i32Array: binaryen.i32 } } as any,
    effectsRuntime,
    effectsBackend: undefined as any,
    effectsState: createEffectsState(),
    effectLowering: {
      sitesByExpr: new Map(),
      sites: [],
      callArgTemps: new Map(),
      tempTypeIds: new Map(),
    },
    outcomeValueTypes: new Map(),
  };

  ctx.effectsBackend = selectEffectsBackend(ctx);

  return { ctx, descriptors, exprTypes, expressions };
};
