# `@voyd-lang/package-adapter`

Defines the host-language descriptor used to implement Voyd external package
interfaces. It is deliberately independent of VX, the compiler, and the host
runtime.

Package authors normally generate a typed `defineAdapter` helper:

```bash
voyd generate adapter ./src --out ./generated
```

```ts
import { defineAdapter } from "./generated/voyd-adapter.js";

export default defineAdapter({
  "example:text/format@1": {
    format(value) {
      return value.trim();
    },
  },
});
```

The lower-level `defineVoydPackageAdapter(contract, implementation)` API checks
the ABI version and requires an exact implementation for every declared sync or
async function. It returns a deeply frozen descriptor and performs no global
registration or Wasm instantiation.
