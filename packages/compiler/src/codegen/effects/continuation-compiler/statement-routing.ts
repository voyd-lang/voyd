import type binaryen from "binaryen";
import type { CodegenContext } from "../../context.js";

export const continuationStatementShouldRun = ({
  sites,
  executionStarted,
  activeSiteOrder,
  ctx,
}: {
  sites: ReadonlySet<number>;
  executionStarted: () => binaryen.ExpressionRef;
  activeSiteOrder: () => binaryen.ExpressionRef;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  if (sites.size === 0) return executionStarted();
  return ctx.mod.i32.or(
    executionStarted(),
    activeContinuationSiteInSet({ sites, activeSiteOrder, ctx }),
  );
};

export const activeContinuationSiteInSet = ({
  sites,
  activeSiteOrder,
  ctx,
}: {
  sites: ReadonlySet<number>;
  activeSiteOrder: () => binaryen.ExpressionRef;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  if (sites.size === 0) return ctx.mod.i32.const(0);
  return [...sites]
    .map((siteOrder) =>
      ctx.mod.i32.eq(activeSiteOrder(), ctx.mod.i32.const(siteOrder)),
    )
    .reduce(
      (matches, comparison) => ctx.mod.i32.or(matches, comparison),
      ctx.mod.i32.const(0),
    );
};
