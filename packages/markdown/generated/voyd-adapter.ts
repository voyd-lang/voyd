import { defineVoydPackageAdapter } from "@voyd-lang/package-adapter";
import type { VoydPackageAdapterInvocationContext } from "@voyd-lang/package-adapter";
import { contract } from "./contract.js";

export type AdapterImplementation = {
  readonly "voyd:markdown/renderer@1": {
    readonly "render_static": (this: VoydPackageAdapterInvocationContext, arg0: string) => { "nodes": readonly { "attrs": readonly { "name": string; "value": string }[]; "children": readonly number[]; "kind": string; "tag": string; "value": string }[]; "root": number };
  };
};

export const defineAdapter = (implementation: AdapterImplementation) =>
  defineVoydPackageAdapter(contract, implementation);
