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
(`std::fs::Fs`, `std::time::Time`, `std::env::Env`, `std::random::Random`,
`std::log::Log`, `std::fetch::Fetch`, `std::input::Input`).
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

Deterministic runtime harness for scheduler/adapter conformance tests:

```ts
import { createDeterministicRuntime } from "@voyd/js-host";

const runtime = createDeterministicRuntime({
  startMonotonicMs: 0,
  startSystemMs: 1_700_000_000_000,
});

const host = await createVoydHost({
  wasm,
  scheduler: { scheduleTask: runtime.scheduleTask },
  defaultAdapters: {
    runtime: "node",
    runtimeHooks: {
      monotonicNowMillis: runtime.monotonicNowMillis,
      systemNowMillis: runtime.systemNowMillis,
      sleepMillis: runtime.sleepMillis,
    },
  },
});
```
