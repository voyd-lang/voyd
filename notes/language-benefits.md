# Common Errors In TypeScript Solved

## Failure to initialize all class properties

```typescript
export class Parameter extends NamedEntity {
  readonly syntaxType = "parameter";
  /** External label the parameter must be called with e.g. myFunc(label: value) */
  label?: Identifier;
  type?: Type;
  typeExpr?: Expr;

  constructor(
    opts: NamedEntityOpts & {
      label?: Identifier;
      type?: Type;
      typeExpr?: Expr;
    }
  ) {
    super(opts);
    this.label = opts.label;
    this.type = opts.type;
    // This is missing and not caught by the compiler
    // this.typeExpr = opts.typeExpr;
  }
}
```

Void avoids this common error as the constructor / init function
is not defined by the user. This problem still exists on overloaded initializers
