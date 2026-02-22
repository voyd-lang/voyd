# @voyd/js-host

Thin JS host implementation for the Voyd host protocol.

```ts
import { createVoydHost } from "@voyd/js-host";

const host = await createVoydHost({ wasm });
host.registerHandler("com.acme.log", 0, "0x91f2abcd", (msg) => console.log(msg));
host.initEffects();

const result = await host.run("main");
```

`createVoydHost` installs default std capability adapters by default
(`std::fs::Fs`, `std::time::Time`, `std::env::Env`, `std::random::Random`, `std::log::Log`).
Disable with `defaultAdapters: false` if you want full manual handler control.

Advanced control (fairness + cancellation):

```ts
const host = await createVoydHost({
  wasm,
  scheduler: { maxInternalStepsPerTick: 1024 },
  defaultAdapters: false,
});

const run = host.runManaged("main");
// run.cancel("user-request");
const outcome = await run.outcome;
```
