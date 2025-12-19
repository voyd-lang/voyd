import binaryen from "binaryen";
import { initExtensionHelpers } from "@voyd/compiler/codegen/rtt/extension.js";
import { defineStructType } from "@voyd/lib/binaryen-gc/index.js";
import {
  initFieldLookupHelpers,
  FieldLookupHelpers,
} from "./field-accessor.js";
import {
  initMethodLookupHelpers,
  MethodLookupHelpers,
} from "./method-accessor.js";

export { LOOKUP_FIELD_ACCESSOR } from "./field-accessor.js";
export { LOOKUP_METHOD_ACCESSOR } from "./method-accessor.js";

export const RTT_METADATA_SLOTS = {
  ANCESTORS: 0,
  FIELD_INDEX_TABLE: 1,
  METHOD_TABLE: 2,
} as const;

export const RTT_METADATA_SLOT_COUNT = Object.keys(
  RTT_METADATA_SLOTS
).length;

export type RttMetadataSlot =
  (typeof RTT_METADATA_SLOTS)[keyof typeof RTT_METADATA_SLOTS];

export interface RttContext {
  baseType: binaryen.Type;
  extensionHelpers: ReturnType<typeof initExtensionHelpers>;
  fieldLookupHelpers: FieldLookupHelpers;
  methodLookupHelpers: MethodLookupHelpers;
}

export const createRttContext = (mod: binaryen.Module): RttContext => {
  const extensionHelpers = initExtensionHelpers(mod);
  const fieldLookupHelpers = initFieldLookupHelpers(mod);
  const methodLookupHelpers = initMethodLookupHelpers(mod);

  const baseType = defineStructType(mod, {
    name: "voydBaseObject",
    fields: [
      {
        name: "__ancestors_table",
        type: extensionHelpers.i32Array,
        mutable: false,
      },
      {
        name: "__field_index_table",
        type: fieldLookupHelpers.lookupTableType,
        mutable: false,
      },
      {
        name: "__method_lookup_table",
        type: methodLookupHelpers.lookupTableType,
        mutable: false,
      },
    ],
    final: false,
  });

  return {
    baseType,
    extensionHelpers,
    fieldLookupHelpers,
    methodLookupHelpers,
  };
};
