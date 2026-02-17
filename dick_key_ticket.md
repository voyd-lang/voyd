# Ticket: Complete `DictKey` Constraint Enforcement Across Modules

## Status

`DictKey` cross-module constraint enforcement is now fixed.

`TY9999` for valid `Dict<String, ...>` usage is no longer reproduced in std.

## What Was Fixed

1. Imported constraint traits are now discovered from constrained member signatures, not only object type parameters.
2. Trait-satisfaction logic now supports symbol-ref based matching when local trait alias mapping is unavailable.
3. Imported function signature `typeParamMap` is remapped to local symbols/types.
4. Unexported symbol aliasing no longer pollutes import-value priming.
5. Regression coverage added for:
   - constrained object methods across modules,
   - constrained object methods with transitive key-type dependencies.

Detailed implementation notes are in:
- `compiler_blocker_dict_constraints.md`

## Current Remaining Blocker (Not DictKey)

Full std validation is now blocked by codegen:
- `CG0001: codegen missing binding for symbol less`
- tracked in `compiler_blocker_codegen_less_binding.md`.

## Last Verified

1. Date: `2026-02-17`
2. DictKey constraint status: resolved.
3. Full std gate status: blocked by unrelated codegen issue above.
