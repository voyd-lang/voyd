import type {
  CodegenContext,
  EffectPerformSite,
  HirExprId,
  HirFunction,
  HirStmtId,
} from "../context.js";

export interface GroupContinuationCfg {
  sitesByExpr: Map<HirExprId, ReadonlySet<number>>;
  sitesByStmt: Map<HirStmtId, ReadonlySet<number>>;
  siteOrderByExpr: Map<HirExprId, number>;
}

const emptySites = (): ReadonlySet<number> => new Set<number>();

const unionInto = (into: Set<number>, from: ReadonlySet<number>): void => {
  from.forEach((site) => into.add(site));
};

const siteOrdersFromExpr = ({
  exprId,
  ctx,
  memo,
  siteOrderByExpr,
  visitStmt,
}: {
  exprId: HirExprId;
  ctx: CodegenContext;
  memo: Map<HirExprId, ReadonlySet<number>>;
  siteOrderByExpr: Map<HirExprId, number>;
  visitStmt: (stmtId: HirStmtId) => ReadonlySet<number>;
}): ReadonlySet<number> => {
  const cached = memo.get(exprId);
  if (cached) return cached;

  const expr = ctx.hir.expressions.get(exprId);
  if (!expr) return emptySites();

  const sites = new Set<number>();
  const ownSite = siteOrderByExpr.get(exprId);
  if (typeof ownSite === "number") {
    sites.add(ownSite);
  }

  switch (expr.exprKind) {
    case "identifier":
    case "literal":
    case "overload-set":
    case "continue":
    case "break":
      break;
    case "call":
      unionInto(sites, siteOrdersFromExpr({
        exprId: expr.callee,
        ctx,
        memo,
        siteOrderByExpr,
        visitStmt,
      }));
      expr.args.forEach((arg) =>
        unionInto(
          sites,
          siteOrdersFromExpr({
            exprId: arg.expr,
            ctx,
            memo,
            siteOrderByExpr,
            visitStmt,
          })
        )
      );
      break;
    case "block":
      expr.statements.forEach((stmtId) =>
        unionInto(sites, visitStmt(stmtId))
      );
      if (typeof expr.value === "number") {
        unionInto(
          sites,
          siteOrdersFromExpr({
            exprId: expr.value,
            ctx,
            memo,
            siteOrderByExpr,
            visitStmt,
          })
        );
      }
      break;
    case "tuple":
      expr.elements.forEach((element) =>
        unionInto(
          sites,
          siteOrdersFromExpr({
            exprId: element,
            ctx,
            memo,
            siteOrderByExpr,
            visitStmt,
          })
        )
      );
      break;
    case "loop":
      unionInto(
        sites,
        siteOrdersFromExpr({
          exprId: expr.body,
          ctx,
          memo,
          siteOrderByExpr,
          visitStmt,
        })
      );
      break;
    case "while":
      unionInto(
        sites,
        siteOrdersFromExpr({
          exprId: expr.condition,
          ctx,
          memo,
          siteOrderByExpr,
          visitStmt,
        })
      );
      unionInto(
        sites,
        siteOrdersFromExpr({
          exprId: expr.body,
          ctx,
          memo,
          siteOrderByExpr,
          visitStmt,
        })
      );
      break;
    case "cond":
    case "if":
      expr.branches.forEach((branch) => {
        unionInto(
          sites,
          siteOrdersFromExpr({
            exprId: branch.condition,
            ctx,
            memo,
            siteOrderByExpr,
            visitStmt,
          })
        );
        unionInto(
          sites,
          siteOrdersFromExpr({
            exprId: branch.value,
            ctx,
            memo,
            siteOrderByExpr,
            visitStmt,
          })
        );
      });
      if (typeof expr.defaultBranch === "number") {
        unionInto(
          sites,
          siteOrdersFromExpr({
            exprId: expr.defaultBranch,
            ctx,
            memo,
            siteOrderByExpr,
            visitStmt,
          })
        );
      }
      break;
    case "match":
      unionInto(
        sites,
        siteOrdersFromExpr({
          exprId: expr.discriminant,
          ctx,
          memo,
          siteOrderByExpr,
          visitStmt,
        })
      );
      expr.arms.forEach((arm) => {
        if (typeof arm.guard === "number") {
          unionInto(
            sites,
            siteOrdersFromExpr({
              exprId: arm.guard,
              ctx,
              memo,
              siteOrderByExpr,
              visitStmt,
            })
          );
        }
        unionInto(
          sites,
          siteOrdersFromExpr({
            exprId: arm.value,
            ctx,
            memo,
            siteOrderByExpr,
            visitStmt,
          })
        );
      });
      break;
    case "object-literal":
      expr.entries.forEach((entry) =>
        unionInto(
          sites,
          siteOrdersFromExpr({
            exprId: entry.value,
            ctx,
            memo,
            siteOrderByExpr,
            visitStmt,
          })
        )
      );
      break;
    case "field-access":
      unionInto(
        sites,
        siteOrdersFromExpr({
          exprId: expr.target,
          ctx,
          memo,
          siteOrderByExpr,
          visitStmt,
        })
      );
      break;
    case "assign":
      if (typeof expr.target === "number") {
        unionInto(
          sites,
          siteOrdersFromExpr({
            exprId: expr.target,
            ctx,
            memo,
            siteOrderByExpr,
            visitStmt,
          })
        );
      }
      unionInto(
        sites,
        siteOrdersFromExpr({
          exprId: expr.value,
          ctx,
          memo,
          siteOrderByExpr,
          visitStmt,
        })
      );
      break;
    case "lambda":
    case "effect-handler":
      break;
  }

  memo.set(exprId, sites);
  return sites;
};

const siteOrdersFromStmt = ({
  stmtId,
  ctx,
  memoStmt,
  visitExpr,
}: {
  stmtId: HirStmtId;
  ctx: CodegenContext;
  memoStmt: Map<HirStmtId, ReadonlySet<number>>;
  visitExpr: (exprId: HirExprId) => ReadonlySet<number>;
}): ReadonlySet<number> => {
  const cached = memoStmt.get(stmtId);
  if (cached) return cached;
  const stmt = ctx.hir.statements.get(stmtId);
  if (!stmt) return emptySites();

  const sites = new Set<number>();
  switch (stmt.kind) {
    case "expr-stmt":
      unionInto(sites, visitExpr(stmt.expr));
      break;
    case "return":
      if (typeof stmt.value === "number") {
        unionInto(sites, visitExpr(stmt.value));
      }
      break;
    case "let":
      unionInto(sites, visitExpr(stmt.initializer));
      break;
  }

  memoStmt.set(stmtId, sites);
  return sites;
};

export const buildGroupContinuationCfg = ({
  fn,
  groupSites,
  ctx,
}: {
  fn: HirFunction;
  groupSites: readonly EffectPerformSite[];
  ctx: CodegenContext;
}): GroupContinuationCfg => {
  const siteOrderByExpr = new Map<HirExprId, number>();
  groupSites.forEach((site) => siteOrderByExpr.set(site.exprId, site.siteOrder));

  const sitesByExpr = new Map<HirExprId, ReadonlySet<number>>();
  const sitesByStmt = new Map<HirStmtId, ReadonlySet<number>>();

  const visitExpr = (exprId: HirExprId): ReadonlySet<number> =>
    siteOrdersFromExpr({
      exprId,
      ctx,
      memo: sitesByExpr,
      siteOrderByExpr,
      visitStmt,
    });

  const visitStmt = (stmtId: HirStmtId): ReadonlySet<number> =>
    siteOrdersFromStmt({
      stmtId,
      ctx,
      memoStmt: sitesByStmt,
      visitExpr,
    });

  visitExpr(fn.body);

  return { sitesByExpr, sitesByStmt, siteOrderByExpr };
};
