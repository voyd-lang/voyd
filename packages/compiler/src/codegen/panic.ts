import binaryen from "binaryen";
import type { CodegenContext, FunctionContext } from "./context.js";
import { allocateTempLocal } from "./locals.js";
import { ensureLinearMemoryExport } from "./memory-exports.js";
import { LINEAR_MEMORY_INTERNAL } from "./effects/host-boundary/constants.js";

export const PANIC_TRAP_PTR_GLOBAL = "__voyd_panic_ptr";
export const PANIC_TRAP_LEN_GLOBAL = "__voyd_panic_len";
export const PANIC_SCRATCH_PTR_GLOBAL = "__voyd_panic_scratch_ptr";
export const PANIC_SCRATCH_CAPACITY_GLOBAL = "__voyd_panic_scratch_capacity";

const FIXED_PANIC_HELPERS = new WeakMap<binaryen.Module, Map<string, string>>();

export const ensurePanicTrapGlobals = (ctx: CodegenContext): void => {
  if (ctx.mod.getGlobal(PANIC_TRAP_PTR_GLOBAL) === 0) {
    ctx.mod.addGlobal(
      PANIC_TRAP_PTR_GLOBAL,
      binaryen.i32,
      true,
      ctx.mod.i32.const(-1),
    );
    ctx.mod.addGlobalExport(PANIC_TRAP_PTR_GLOBAL, PANIC_TRAP_PTR_GLOBAL);
  }
  if (ctx.mod.getGlobal(PANIC_TRAP_LEN_GLOBAL) === 0) {
    ctx.mod.addGlobal(
      PANIC_TRAP_LEN_GLOBAL,
      binaryen.i32,
      true,
      ctx.mod.i32.const(0),
    );
    ctx.mod.addGlobalExport(PANIC_TRAP_LEN_GLOBAL, PANIC_TRAP_LEN_GLOBAL);
  }
  if (ctx.mod.getGlobal(PANIC_SCRATCH_PTR_GLOBAL) === 0) {
    ctx.mod.addGlobal(
      PANIC_SCRATCH_PTR_GLOBAL,
      binaryen.i32,
      true,
      ctx.mod.i32.const(-1),
    );
  }
  if (ctx.mod.getGlobal(PANIC_SCRATCH_CAPACITY_GLOBAL) === 0) {
    ctx.mod.addGlobal(
      PANIC_SCRATCH_CAPACITY_GLOBAL,
      binaryen.i32,
      true,
      ctx.mod.i32.const(0),
    );
  }
};

export const compilePanicTrap = ({
  messages,
  selectMessage,
  ctx,
  fnCtx,
}: {
  messages: readonly string[];
  selectMessage: (
    stores: readonly binaryen.ExpressionRef[],
  ) => binaryen.ExpressionRef;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  if (messages.length === 0) {
    throw new Error("panic trap requires at least one message");
  }
  const encodedMessages = messages.map((message) =>
    new TextEncoder().encode(message),
  );
  const maxMessageLength = Math.max(
    ...encodedMessages.map((message) => message.byteLength),
  );
  if (maxMessageLength > 65_536) {
    throw new Error("panic message exceeds one linear-memory page");
  }

  ensurePanicTrapGlobals(ctx);
  ensureLinearMemoryExport(ctx);

  const grownPage = allocateTempLocal(binaryen.i32, fnCtx);
  const scratchPtr = () =>
    ctx.mod.global.get(PANIC_SCRATCH_PTR_GLOBAL, binaryen.i32);
  const scratchCapacity = () =>
    ctx.mod.global.get(PANIC_SCRATCH_CAPACITY_GLOBAL, binaryen.i32);
  const storeMessage = (message: Uint8Array): binaryen.ExpressionRef =>
    ctx.mod.block(null, [
      ctx.mod.global.set(
        PANIC_TRAP_LEN_GLOBAL,
        ctx.mod.i32.const(message.byteLength),
      ),
      ctx.mod.if(
        ctx.mod.i32.ge_s(scratchPtr(), ctx.mod.i32.const(0)),
        ctx.mod.block(
          null,
          Array.from(message, (byte, index) =>
            ctx.mod.i32.store8(
              0,
              1,
              ctx.mod.i32.add(scratchPtr(), ctx.mod.i32.const(index)),
              ctx.mod.i32.const(byte),
              LINEAR_MEMORY_INTERNAL,
            ),
          ),
        ),
      ),
    ]);
  const reserveScratch = ctx.mod.if(
    ctx.mod.i32.or(
      ctx.mod.i32.lt_s(scratchPtr(), ctx.mod.i32.const(0)),
      ctx.mod.i32.lt_s(scratchCapacity(), ctx.mod.i32.const(maxMessageLength)),
    ),
    ctx.mod.block(null, [
      ctx.mod.local.set(
        grownPage.index,
        ctx.mod.memory.grow(ctx.mod.i32.const(1), LINEAR_MEMORY_INTERNAL),
      ),
      ctx.mod.if(
        ctx.mod.i32.eq(
          ctx.mod.local.get(grownPage.index, binaryen.i32),
          ctx.mod.i32.const(-1),
        ),
        ctx.mod.block(null, [
          ctx.mod.global.set(PANIC_SCRATCH_PTR_GLOBAL, ctx.mod.i32.const(-1)),
          ctx.mod.global.set(
            PANIC_SCRATCH_CAPACITY_GLOBAL,
            ctx.mod.i32.const(0),
          ),
        ]),
        ctx.mod.block(null, [
          ctx.mod.global.set(
            PANIC_SCRATCH_PTR_GLOBAL,
            ctx.mod.i32.mul(
              ctx.mod.local.get(grownPage.index, binaryen.i32),
              ctx.mod.i32.const(65_536),
            ),
          ),
          ctx.mod.global.set(
            PANIC_SCRATCH_CAPACITY_GLOBAL,
            ctx.mod.i32.const(65_536),
          ),
        ]),
      ),
    ]),
  );

  return ctx.mod.block(null, [
    reserveScratch,
    selectMessage(encodedMessages.map(storeMessage)),
    ctx.mod.global.set(PANIC_TRAP_PTR_GLOBAL, scratchPtr()),
    ctx.mod.unreachable(),
  ]);
};

/**
 * Compiles a call to a module-local panic helper.
 *
 * Runtime guards can occur at many call sites. Keeping the message construction
 * in one helper avoids duplicating every byte store at each guarded call.
 */
export const compileFixedPanicTrap = ({
  message,
  ctx,
}: {
  message: string;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  const helperName = ensureFixedPanicHelper({ message, ctx });
  return ctx.mod.call(helperName, [], binaryen.none);
};

const ensureFixedPanicHelper = ({
  message,
  ctx,
}: {
  message: string;
  ctx: CodegenContext;
}): string => {
  const moduleHelpers = FIXED_PANIC_HELPERS.get(ctx.mod) ?? new Map();
  FIXED_PANIC_HELPERS.set(ctx.mod, moduleHelpers);
  const existing = moduleHelpers.get(message);
  if (existing) {
    return existing;
  }

  const encodedMessage = new TextEncoder().encode(message);
  if (encodedMessage.byteLength > 65_536) {
    throw new Error("panic message exceeds one linear-memory page");
  }

  ensurePanicTrapGlobals(ctx);
  ensureLinearMemoryExport(ctx);

  const helperName = `__voyd_fixed_panic_${moduleHelpers.size}`;
  moduleHelpers.set(message, helperName);
  const scratchPtr = () =>
    ctx.mod.global.get(PANIC_SCRATCH_PTR_GLOBAL, binaryen.i32);
  const scratchCapacity = () =>
    ctx.mod.global.get(PANIC_SCRATCH_CAPACITY_GLOBAL, binaryen.i32);
  const reserveScratch = ctx.mod.if(
    ctx.mod.i32.or(
      ctx.mod.i32.lt_s(scratchPtr(), ctx.mod.i32.const(0)),
      ctx.mod.i32.lt_s(
        scratchCapacity(),
        ctx.mod.i32.const(encodedMessage.byteLength),
      ),
    ),
    ctx.mod.block(null, [
      ctx.mod.global.set(
        PANIC_SCRATCH_PTR_GLOBAL,
        ctx.mod.memory.grow(ctx.mod.i32.const(1), LINEAR_MEMORY_INTERNAL),
      ),
      ctx.mod.if(
        ctx.mod.i32.eq(scratchPtr(), ctx.mod.i32.const(-1)),
        ctx.mod.global.set(PANIC_SCRATCH_CAPACITY_GLOBAL, ctx.mod.i32.const(0)),
        ctx.mod.block(null, [
          ctx.mod.global.set(
            PANIC_SCRATCH_PTR_GLOBAL,
            ctx.mod.i32.mul(scratchPtr(), ctx.mod.i32.const(65_536)),
          ),
          ctx.mod.global.set(
            PANIC_SCRATCH_CAPACITY_GLOBAL,
            ctx.mod.i32.const(65_536),
          ),
        ]),
      ),
    ]),
  );
  const stores = Array.from(encodedMessage, (byte, index) =>
    ctx.mod.i32.store8(
      0,
      1,
      ctx.mod.i32.add(scratchPtr(), ctx.mod.i32.const(index)),
      ctx.mod.i32.const(byte),
      LINEAR_MEMORY_INTERNAL,
    ),
  );
  const body = ctx.mod.block(null, [
    reserveScratch,
    ctx.mod.global.set(
      PANIC_TRAP_LEN_GLOBAL,
      ctx.mod.i32.const(encodedMessage.byteLength),
    ),
    ctx.mod.if(
      ctx.mod.i32.ge_s(scratchPtr(), ctx.mod.i32.const(0)),
      ctx.mod.block(null, stores),
    ),
    ctx.mod.global.set(PANIC_TRAP_PTR_GLOBAL, scratchPtr()),
    ctx.mod.unreachable(),
  ]);
  ctx.mod.addFunction(helperName, binaryen.none, binaryen.none, [], body);
  return helperName;
};
