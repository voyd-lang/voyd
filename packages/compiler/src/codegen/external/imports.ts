import binaryen from "binaryen";
import type {
  CodegenContext,
  FunctionContext,
  HirCallExpr,
} from "../context.js";
import type { ProgramFunctionInstanceId, TypeId } from "../../semantics/ids.js";
import { allocateTempLocal } from "../locals.js";
import { ensureLinearMemoryExport } from "../memory-exports.js";
import { ensureSelectedHostTransportProvider } from "../host-transport/selected-provider.js";
import { wasmTypeFor, getRequiredExprType } from "../types.js";
import {
  deriveBoundarySchema,
  withDtoFingerprint,
  type BoundarySchema,
} from "../boundary/schema.js";
import {
  writeDtoValueToTree,
  readDtoValueFromTree,
} from "../boundary/dto-tree-codec.js";
import type { EffectRegistry } from "../effects/effect-registry.js";
import { murmurHash3 } from "@voyd-lang/lib/murmur-hash.js";
import { arrayGet } from "@voyd-lang/lib/binaryen-gc/index.js";
import {
  makeSelectedExternalInvocation,
  SELECTED_HOST_FRAME_TAG,
  SELECTED_HOST_FRAME_VERSION,
} from "../host-transport/frame-codec.js";

export const EXTERNAL_IMPORT_MODULE = "voyd.external";
export const EXTERNAL_REQUIREMENTS_SECTION = "voyd.external_requirements";
export const EXTERNAL_BUFFER_SIZE_IMPORT = "buffer_size";
export const EXTERNAL_BUFFER_ERROR_IMPORT = "buffer_error";

export type ExternalFunctionRequirement = {
  kind: "sync" | "async";
  interfaceId: string;
  functionName: string;
  params: readonly BoundarySchema[];
  result: BoundarySchema;
  effect?: {
    opId: number;
    signatureHash: string;
    resumeKind: "resume" | "tail";
  };
};

const EXTERNAL_IMPORTS_KEY = Symbol("voyd.external.imports");
const EXTERNAL_REQUIREMENTS_KEY = Symbol("voyd.external.requirements");

export const compileExternalCall = ({
  identity,
  call,
  args,
  ctx,
  fnCtx,
  instanceId,
  paramTypeIds: plannedParamTypeIds,
}: {
  identity: { interfaceId: string; functionName: string };
  call: HirCallExpr;
  args: readonly binaryen.ExpressionRef[];
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  instanceId?: ProgramFunctionInstanceId;
  paramTypeIds?: readonly TypeId[];
}): binaryen.ExpressionRef => {
  const paramTypeIds =
    plannedParamTypeIds ??
    call.args.map((arg) => getRequiredExprType(arg.expr, ctx, instanceId));
  if (paramTypeIds.length !== args.length) {
    throw new Error(
      `external call argument plan mismatch for ${identity.interfaceId}::${identity.functionName}`,
    );
  }
  const resultTypeId = getRequiredExprType(call.id, ctx, instanceId);
  const params = paramTypeIds.map((typeId, index) =>
    withDtoFingerprint(
      deriveBoundarySchema({
        typeId,
        ctx,
        label: `${identity.interfaceId}::${identity.functionName} arg${index}`,
        options: { tagStandaloneVariants: true },
      }),
    ),
  );
  const result = withDtoFingerprint(
    deriveBoundarySchema({
      typeId: resultTypeId,
      ctx,
      label: `${identity.interfaceId}::${identity.functionName} result`,
      options: { tagStandaloneVariants: true },
    }),
  );

  recordExternalRequirement({
    ctx,
    requirement: {
      kind: "sync",
      ...identity,
      params,
      result,
    },
  });
  ensureLinearMemoryExport(ctx);
  const importName = ensureExternalFunctionImport({ ctx, ...identity });
  const bufferSizeImport = ensureExternalBufferSizeImport(ctx);
  const bufferErrorImport = ensureExternalBufferErrorImport(ctx);
  const provider = ensureSelectedHostTransportProvider(ctx);
  const providerValueType = wasmTypeFor(provider.valueTypeId, ctx);
  const arrayType = provider.arrayWithCapacity.resultType;
  const storageType = provider.arrayRawStorage.resultType;
  const capacityLocal = allocateTempLocal(binaryen.i32, fnCtx);
  const encodedLengthLocal = allocateTempLocal(binaryen.i32, fnCtx);
  const writtenLocal = allocateTempLocal(binaryen.i32, fnCtx);
  const decodedLocal = allocateTempLocal(providerValueType, fnCtx);
  const frameArrayLocal = allocateTempLocal(arrayType, fnCtx);
  const frameStorageLocal = allocateTempLocal(storageType, fnCtx);
  const outcomeArrayLocal = allocateTempLocal(arrayType, fnCtx);
  const outcomeStorageLocal = allocateTempLocal(storageType, fnCtx);
  const typedPayloadArrayLocal = allocateTempLocal(arrayType, fnCtx);
  const typedPayloadStorageLocal = allocateTempLocal(storageType, fnCtx);
  const capacityRef = () =>
    ctx.mod.local.get(capacityLocal.index, binaryen.i32);
  const encodedLengthRef = () =>
    ctx.mod.local.get(encodedLengthLocal.index, binaryen.i32);
  const writtenRef = () => ctx.mod.local.get(writtenLocal.index, binaryen.i32);
  const frameField = (index: number) =>
    arrayGet(
      ctx.mod,
      ctx.mod.local.get(frameStorageLocal.index, storageType),
      ctx.mod.i32.const(index),
      providerValueType,
      false,
    );
  const outcomeField = (index: number) =>
    arrayGet(
      ctx.mod,
      ctx.mod.local.get(outcomeStorageLocal.index, storageType),
      ctx.mod.i32.const(index),
      providerValueType,
      false,
    );
  const typedPayloadField = (index: number) =>
    arrayGet(
      ctx.mod,
      ctx.mod.local.get(typedPayloadStorageLocal.index, storageType),
      ctx.mod.i32.const(index),
      providerValueType,
      false,
    );
  const invocationFrame = makeSelectedExternalInvocation({
    ...identity,
    args: args.map((arg, index) => {
      const schema = params[index]!;
      if (!schema.fingerprint) {
        throw new Error(
          `missing DTO fingerprint for ${identity.interfaceId}::${identity.functionName} arg${index}`,
        );
      }
      return {
        fingerprint: schema.fingerprint,
        value: packExternalValue({
          value: arg,
          schema,
          ctx,
          fnCtx,
        }),
      };
    }),
    ctx,
    fnCtx,
    provider,
  });

  const setup: binaryen.ExpressionRef[] = [
    ctx.mod.local.set(
      capacityLocal.index,
      ctx.mod.call(bufferSizeImport, [], binaryen.i32),
    ),
    ctx.mod.local.set(
      encodedLengthLocal.index,
      ctx.mod.call(
        provider.encodeValue.wasmName,
        [invocationFrame, ctx.mod.i32.const(0), capacityRef()],
        binaryen.i32,
      ),
    ),
    ctx.mod.if(
      ctx.mod.i32.lt_s(encodedLengthRef(), ctx.mod.i32.const(0)),
      ctx.mod.block(null, [
        ctx.mod.call(
          bufferErrorImport,
          [
            ctx.mod.i32.sub(ctx.mod.i32.const(0), encodedLengthRef()),
            ctx.mod.i32.const(0),
          ],
          binaryen.none,
        ),
        ctx.mod.unreachable(),
      ]),
    ),
    ctx.mod.local.set(
      writtenLocal.index,
      ctx.mod.call(
        importName,
        [
          ctx.mod.i32.const(0),
          encodedLengthRef(),
          capacityRef(),
          capacityRef(),
        ],
        binaryen.i32,
      ),
    ),
    trapIfNegative(writtenRef(), ctx),
    ctx.mod.local.set(
      decodedLocal.index,
      ctx.mod.call(
        provider.decodeValue.wasmName,
        [capacityRef(), writtenRef()],
        providerValueType,
      ),
    ),
    ctx.mod.local.set(
      frameArrayLocal.index,
      ctx.mod.call(
        provider.unpackArray.wasmName,
        [ctx.mod.local.get(decodedLocal.index, providerValueType)],
        arrayType,
      ),
    ),
    ctx.mod.local.set(
      frameStorageLocal.index,
      ctx.mod.call(
        provider.arrayRawStorage.wasmName,
        [ctx.mod.local.get(frameArrayLocal.index, arrayType)],
        storageType,
      ),
    ),
    ctx.mod.if(
      ctx.mod.i32.or(
        ctx.mod.i32.ne(
          ctx.mod.call(
            provider.unpackI32.wasmName,
            [frameField(0)],
            binaryen.i32,
          ),
          ctx.mod.i32.const(SELECTED_HOST_FRAME_VERSION),
        ),
        ctx.mod.i32.ne(
          ctx.mod.call(
            provider.unpackI32.wasmName,
            [frameField(1)],
            binaryen.i32,
          ),
          ctx.mod.i32.const(SELECTED_HOST_FRAME_TAG.externalCompletion),
        ),
      ),
      ctx.mod.unreachable(),
      ctx.mod.nop(),
    ),
    ctx.mod.local.set(
      outcomeArrayLocal.index,
      ctx.mod.call(provider.unpackArray.wasmName, [frameField(4)], arrayType),
    ),
    ctx.mod.local.set(
      outcomeStorageLocal.index,
      ctx.mod.call(
        provider.arrayRawStorage.wasmName,
        [ctx.mod.local.get(outcomeArrayLocal.index, arrayType)],
        storageType,
      ),
    ),
    ctx.mod.if(
      ctx.mod.i32.ne(
        ctx.mod.call(
          provider.unpackI32.wasmName,
          [outcomeField(0)],
          binaryen.i32,
        ),
        ctx.mod.i32.const(0),
      ),
      ctx.mod.unreachable(),
      ctx.mod.nop(),
    ),
    ctx.mod.local.set(
      typedPayloadArrayLocal.index,
      ctx.mod.call(provider.unpackArray.wasmName, [outcomeField(1)], arrayType),
    ),
    ctx.mod.local.set(
      typedPayloadStorageLocal.index,
      ctx.mod.call(
        provider.arrayRawStorage.wasmName,
        [ctx.mod.local.get(typedPayloadArrayLocal.index, arrayType)],
        storageType,
      ),
    ),
  ];

  const value = unpackExternalValue({
    value: typedPayloadField(1),
    schema: result,
    ctx,
    fnCtx,
  });
  const resultType = wasmTypeFor(resultTypeId, ctx);
  return ctx.mod.block(null, [...setup, value], resultType);
};

export const emitExternalRequirementsSection = ({
  mod,
  programHelpers,
  effectRegistry,
  includeDeclarations = false,
}: {
  mod: binaryen.Module;
  programHelpers: CodegenContext["programHelpers"];
  effectRegistry: EffectRegistry;
  includeDeclarations?: boolean;
}): void => {
  const requirements = programHelpers.getHelperState(
    EXTERNAL_REQUIREMENTS_KEY,
    () => new Map<string, ExternalFunctionRequirement>(),
  );
  effectRegistry.entries.forEach((entry) => {
    if (
      !entry.external ||
      (entry.external.declaredOnly && !includeDeclarations)
    )
      return;
    const requirement: ExternalFunctionRequirement = {
      kind: "async",
      interfaceId: entry.effectId.id,
      functionName: entry.opName,
      params: entry.external.params,
      result: entry.external.result,
      effect: {
        opId: entry.opId,
        signatureHash: `0x${entry.signatureHash.toString(16).padStart(8, "0")}`,
        resumeKind: entry.resumeKind === 1 ? "tail" : "resume",
      },
    };
    const key = externalRequirementKey(requirement);
    const existing = requirements.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(requirement)) {
      throw new Error(`external function contract mismatch for ${key}`);
    }
    requirements.set(key, requirement);
  });
  if (requirements.size === 0) return;
  const functions = [...requirements.values()].sort((left, right) =>
    externalRequirementKey(left).localeCompare(externalRequirementKey(right)),
  );
  assertComponentCompatibleSchemas(functions);
  mod.addCustomSection(
    EXTERNAL_REQUIREMENTS_SECTION,
    new TextEncoder().encode(JSON.stringify({ version: 1, functions })),
  );
};

const assertComponentCompatibleSchemas = (
  functions: readonly ExternalFunctionRequirement[],
): void => {
  const declarations = new Map<number, BoundarySchema>();
  const register = (schema: BoundarySchema): void => {
    if (schema.kind === "ref") return;
    if (
      (schema.kind === "array" ||
        schema.kind === "record" ||
        schema.kind === "union") &&
      schema.typeId !== undefined
    ) {
      declarations.set(schema.typeId, schema);
      schema.aliases?.forEach((alias) => declarations.set(alias, schema));
    }
    if (schema.kind === "array") register(schema.element);
    if (schema.kind === "record")
      schema.fields.forEach((field) => register(field.schema));
    if (schema.kind === "union") {
      schema.variants.forEach((variant) =>
        variant.fields.forEach((field) => register(field.schema)),
      );
    }
  };
  const roots = functions.flatMap((fn) => [...fn.params, fn.result]);
  roots.forEach(register);

  const complete = new Set<number>();
  const active = new Set<number>();
  const visit = (schema: BoundarySchema, label: string): void => {
    if (schema.kind === "ref") {
      const target = declarations.get(schema.typeId);
      if (!target) {
        throw new Error(
          `external DTO ${label} references unknown type ${schema.typeId}`,
        );
      }
      visit(target, label);
      return;
    }
    const typeId =
      schema.kind === "array" ||
      schema.kind === "record" ||
      schema.kind === "union"
        ? schema.typeId
        : undefined;
    if (typeId !== undefined) {
      if (active.has(typeId)) {
        throw new Error(
          `external DTO ${label} is recursive; Component Model values require an acyclic DTO (use an indexed or handle-based representation)`,
        );
      }
      if (complete.has(typeId)) return;
      active.add(typeId);
    }
    if (schema.kind === "array") visit(schema.element, label);
    if (schema.kind === "record")
      schema.fields.forEach((field) => visit(field.schema, label));
    if (schema.kind === "union") {
      schema.variants.forEach((variant) =>
        variant.fields.forEach((field) => visit(field.schema, label)),
      );
    }
    if (typeId !== undefined) {
      active.delete(typeId);
      complete.add(typeId);
    }
  };
  functions.forEach((fn) =>
    [...fn.params, fn.result].forEach((schema) =>
      visit(schema, `${fn.interfaceId}::${fn.functionName}`),
    ),
  );
};

const ensureExternalFunctionImport = ({
  ctx,
  interfaceId,
  functionName,
}: {
  ctx: CodegenContext;
  interfaceId: string;
  functionName: string;
}): string => {
  const imports = ctx.programHelpers.getHelperState(
    EXTERNAL_IMPORTS_KEY,
    () => new Map<string, string>(),
  );
  const base = `${interfaceId}::${functionName}`;
  const existing = imports.get(base);
  if (existing) return existing;
  const hash = (murmurHash3(base) >>> 0).toString(16).padStart(8, "0");
  const internal = `__voyd_external_import_${sanitizeIdentifier(base)}_${hash}`;
  ctx.mod.addFunctionImport(
    internal,
    EXTERNAL_IMPORT_MODULE,
    base,
    binaryen.createType([
      binaryen.i32,
      binaryen.i32,
      binaryen.i32,
      binaryen.i32,
    ]),
    binaryen.i32,
  );
  imports.set(base, internal);
  return internal;
};

const ensureExternalBufferSizeImport = (ctx: CodegenContext): string => {
  const imports = ctx.programHelpers.getHelperState(
    EXTERNAL_IMPORTS_KEY,
    () => new Map<string, string>(),
  );
  const existing = imports.get(EXTERNAL_BUFFER_SIZE_IMPORT);
  if (existing) return existing;
  const internal = "__voyd_external_buffer_size";
  ctx.mod.addFunctionImport(
    internal,
    EXTERNAL_IMPORT_MODULE,
    EXTERNAL_BUFFER_SIZE_IMPORT,
    binaryen.none,
    binaryen.i32,
  );
  imports.set(EXTERNAL_BUFFER_SIZE_IMPORT, internal);
  return internal;
};

const ensureExternalBufferErrorImport = (ctx: CodegenContext): string => {
  const imports = ctx.programHelpers.getHelperState(
    EXTERNAL_IMPORTS_KEY,
    () => new Map<string, string>(),
  );
  const existing = imports.get(EXTERNAL_BUFFER_ERROR_IMPORT);
  if (existing) return existing;
  const internal = "__voyd_external_buffer_error";
  ctx.mod.addFunctionImport(
    internal,
    EXTERNAL_IMPORT_MODULE,
    EXTERNAL_BUFFER_ERROR_IMPORT,
    binaryen.createType([binaryen.i32, binaryen.i32]),
    binaryen.none,
  );
  imports.set(EXTERNAL_BUFFER_ERROR_IMPORT, internal);
  return internal;
};

const recordExternalRequirement = ({
  ctx,
  requirement,
}: {
  ctx: CodegenContext;
  requirement: ExternalFunctionRequirement;
}): void => {
  const requirements = ctx.programHelpers.getHelperState(
    EXTERNAL_REQUIREMENTS_KEY,
    () => new Map<string, ExternalFunctionRequirement>(),
  );
  const key = externalRequirementKey(requirement);
  const existing = requirements.get(key);
  if (existing && JSON.stringify(existing) !== JSON.stringify(requirement)) {
    throw new Error(`external function contract mismatch for ${key}`);
  }
  requirements.set(key, requirement);
};

const externalRequirementKey = (
  requirement: Pick<
    ExternalFunctionRequirement,
    "interfaceId" | "functionName"
  >,
): string => `${requirement.interfaceId}::${requirement.functionName}`;

const packExternalValue = ({
  value,
  schema,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  schema: BoundarySchema;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const provider = ensureSelectedHostTransportProvider(ctx);
  return writeDtoValueToTree({ value, schema, ctx, fnCtx, provider });
};

const unpackExternalValue = ({
  value,
  schema,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  schema: BoundarySchema;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const provider = ensureSelectedHostTransportProvider(ctx);
  return readDtoValueFromTree({ value, schema, ctx, fnCtx, provider });
};

const trapIfNegative = (
  value: binaryen.ExpressionRef,
  ctx: CodegenContext,
): binaryen.ExpressionRef =>
  ctx.mod.if(
    ctx.mod.i32.lt_s(value, ctx.mod.i32.const(0)),
    ctx.mod.unreachable(),
    ctx.mod.nop(),
  );

const sanitizeIdentifier = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");
