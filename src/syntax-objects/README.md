# Syntax Objects

Syntax objects are data structures that represent concepts within the
language. Such as functions, function calls, variables etc.

# Guidelines

- Each Syntax Object should be part of the `Expr` union
- Syntax objects must track their parent-child relationship. A child typically
  belongs to a parent when it was directly defined with the parent. I.E.
  parameters of functions, expressions / variables of block. These parent
  relationships are stored via the parent pointer and must stay up to date
  during clones. Use `ChildList` and `ChildMap` data types to help keep
  make this easier.
- Resolved values should not be considered a child of the expression they
  were resolved from. The type expression (`typeExpr`) of a parameter is
  a child of the parameter, but the type it resolves to should never
  accidentally be marked as a child of the parameter. Nor should it be
  included in the clone (instead, they type resolution can be run again)
