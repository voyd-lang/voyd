# @voyd/js-host

Thin JS host implementation for the Voyd host protocol.

```ts
import { createVoydHost } from "@voyd/js-host";

const host = await createVoydHost({ wasm });
host.registerHandler("com.acme.log", 0, "0x91f2abcd", (msg) => console.log(msg));
host.initEffects();

const result = await host.run("main");
```
