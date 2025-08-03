# Ergonomics

## Hybrid Nominal And Structural Sub-typing

```voyd
obj Robot

obj ArmRobot: Robot {
  vise: Vise
}

obj HumanoidRobot: Robot {
  vise: Vise
  legs: Legs
}

obj DogRobot: Robot {
  legs: Legs
}

obj Human {
  legs: Legs
}

trait Gripper
  fn grip(self) async -> void
  fn un_grip(self) async -> void

trait Moveable
  fn move_to(self, location: Location) async -> void

// Provides implementation for ArmRobot and HumanoidRobot
impl Gripper for: Robot & { vise: Vise }
  fn grip(self) async -> void
    await! self.vise.close()

  fn un_grip(self) async -> void
    await! self.vise.open()

// Provides implementation for DogRobot and HumanoidRobot, but not Human as its not a Robot
impl Moveable for: Robot & { legs: Legs }
  fn grip(self) async -> void
    await! self.vise.close()

  fn un_grip(self) async -> void
    await! self.vise.open()
```

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

Voyd avoyds this common error as the constructor / init function
is not defined by the user. This problem still exists on overloaded initializers
