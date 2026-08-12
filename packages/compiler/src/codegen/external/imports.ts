import binaryen from "binaryen";
import type {
  CodegenContext,
  FunctionContext,
  HirCallExpr,
} from "../context.js";
import type { ProgramFunctionInstanceId, TypeId } from "../../semantics/ids.js";
import {
  allocateTempLocal,
  loadLocalValue,
  storeLocalValue,
} from "../locals.js";
import { ensureLinearMemoryExport } from "../memory-exports.js";
import { ensureSelectedHostTransportProvider } from "../host-transport/selected-provider.js";
import { wasmTypeFor, getRequiredExprType } from "../types.js";
import {
  deriveBoundarySchema,
  withDtoFingerprint,
  type BoundarySchema,
} from "../boundary/schema.js";
import {
  hostStreamWriterResultTypeId,
  writeDtoValueToHostStream,
  writeHostStreamEvent,
} from "../boundary/dto-stream-writer.js";
import {
  readDtoValueFromHostStream,
  readHostStreamValue,
} from "../boundary/dto-stream-reader.js";
import type { EffectRegistry } from "../effects/effect-registry.js";
import { murmurHash3 } from "@voyd-lang/lib/murmur-hash.js";
import {
  SELECTED_HOST_FRAME_TAG,
  SELECTED_HOST_FRAME_VERSION,
} from "../host-transport/frame-codec.js";
import { emitStringLiteral } from "../expressions/primitives.js";

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
  const writerType = wasmTypeFor(provider.writerTypeId, ctx);
  const readerType = wasmTypeFor(provider.readerTypeId, ctx);
  const capacityLocal = allocateTempLocal(binaryen.i32, fnCtx);
  const encodedLengthLocal = allocateTempLocal(binaryen.i32, fnCtx);
  const writtenLocal = allocateTempLocal(binaryen.i32, fnCtx);
  const writerLocal = allocateTempLocal(
    writerType,
    fnCtx,
    provider.writerTypeId,
    ctx,
  );
  const readerLocal = allocateTempLocal(
    readerType,
    fnCtx,
    provider.readerTypeId,
    ctx,
  );
  const resultLocal = allocateTempLocal(
    wasmTypeFor(resultTypeId, ctx),
    fnCtx,
    resultTypeId,
    ctx,
  );
  const capacityRef = () =>
    ctx.mod.local.get(capacityLocal.index, binaryen.i32);
  const encodedLengthRef = () =>
    ctx.mod.local.get(encodedLengthLocal.index, binaryen.i32);
  const writtenRef = () => ctx.mod.local.get(writtenLocal.index, binaryen.i32);
  const writerRef = () => loadLocalValue(writerLocal, ctx);
  const readerRef = () => loadLocalValue(readerLocal, ctx);
  const write = (
    name: string,
    writeArgs: readonly binaryen.ExpressionRef[] = [],
  ) =>
    writeHostStreamEvent({
      writer: writerRef(),
      writerTypeId: provider.writerTypeId,
      name,
      args: writeArgs,
      ctx,
      fnCtx,
    });
  const read = (name: string) =>
    readHostStreamValue({
      reader: readerRef(),
      readerTypeId: provider.readerTypeId,
      name,
      ctx,
      fnCtx,
    });
  const dtoWriteResultTypeId = hostStreamWriterResultTypeId({
    writerTypeId: provider.writerTypeId,
    ctx,
  });
  const writeInvocation = [
    write("begin_array", [ctx.mod.i32.const(5)]),
    write("write_i32", [ctx.mod.i32.const(SELECTED_HOST_FRAME_VERSION)]),
    write("write_i32", [
      ctx.mod.i32.const(SELECTED_HOST_FRAME_TAG.externalInvocation),
    ]),
    write("write_string", [emitStringLiteral(identity.interfaceId, ctx)]),
    write("write_string", [emitStringLiteral(identity.functionName, ctx)]),
    write("begin_array", [ctx.mod.i32.const(args.length)]),
    ...args.flatMap((arg, index) => {
      const schema = params[index]!;
      if (!schema.fingerprint) {
        throw new Error(
          `missing DTO fingerprint for ${identity.interfaceId}::${identity.functionName} arg${index}`,
        );
      }
      return [
        write("begin_array", [ctx.mod.i32.const(2)]),
        write("write_string", [emitStringLiteral(schema.fingerprint, ctx)]),
        ctx.mod.drop(
          writeDtoValueToHostStream({
            writer: writerRef,
            writerTypeId: provider.writerTypeId,
            value: arg,
            schema,
            resultTypeId: dtoWriteResultTypeId,
            ctx,
            fnCtx,
          }),
        ),
        write("end_array"),
      ];
    }),
    write("end_array"),
    write("end_array"),
  ];

  const setup: binaryen.ExpressionRef[] = [
    ctx.mod.local.set(
      capacityLocal.index,
      ctx.mod.call(bufferSizeImport, [], binaryen.i32),
    ),
    ctx.mod.local.set(
      writerLocal.index,
      ctx.mod.call(
        provider.createWriter.wasmName,
        [ctx.mod.i32.const(0), capacityRef()],
        provider.createWriter.resultType,
      ),
    ),
    ...writeInvocation,
    ctx.mod.local.set(
      encodedLengthLocal.index,
      ctx.mod.call(
        provider.finishWriter.wasmName,
        [writerRef()],
        provider.finishWriter.resultType,
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
    storeLocalValue({
      binding: readerLocal,
      value: ctx.mod.call(
        provider.createReader.wasmName,
        [capacityRef(), writtenRef()],
        provider.createReader.resultType,
      ),
      ctx,
      fnCtx,
    }),
    ctx.mod.if(
      ctx.mod.i32.or(
        ctx.mod.i32.or(
          ctx.mod.i32.ne(read("begin_array"), ctx.mod.i32.const(5)),
          ctx.mod.i32.ne(
            read("read_i32"),
            ctx.mod.i32.const(SELECTED_HOST_FRAME_VERSION),
          ),
        ),
        ctx.mod.i32.ne(
          read("read_i32"),
          ctx.mod.i32.const(SELECTED_HOST_FRAME_TAG.externalCompletion),
        ),
      ),
      ctx.mod.unreachable(),
    ),
    ctx.mod.drop(read("read_string")),
    ctx.mod.drop(read("read_string")),
    ctx.mod.if(
      ctx.mod.i32.ne(read("begin_array"), ctx.mod.i32.const(2)),
      ctx.mod.unreachable(),
    ),
    ctx.mod.if(
      ctx.mod.i32.ne(read("read_i32"), ctx.mod.i32.const(0)),
      ctx.mod.unreachable(),
    ),
    ctx.mod.if(
      ctx.mod.i32.ne(read("begin_array"), ctx.mod.i32.const(2)),
      ctx.mod.unreachable(),
    ),
    ctx.mod.drop(read("read_string")),
    storeLocalValue({
      binding: resultLocal,
      value: readDtoValueFromHostStream({
        reader: readerRef(),
        readerTypeId: provider.readerTypeId,
        schema: result,
        ctx,
        fnCtx,
      }),
      ctx,
      fnCtx,
    }),
    ctx.mod.drop(read("end_array")),
    ctx.mod.drop(read("end_array")),
    ctx.mod.drop(read("end_array")),
    ctx.mod.if(
      ctx.mod.i32.eqz(
        ctx.mod.call(
          provider.readerComplete.wasmName,
          [readerRef()],
          provider.readerComplete.resultType,
        ),
      ),
      ctx.mod.unreachable(),
    ),
  ];
  const resultType = wasmTypeFor(resultTypeId, ctx);
  return ctx.mod.block(
    null,
    [...setup, loadLocalValue(resultLocal, ctx)],
    resultType,
  );
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
