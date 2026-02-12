import binaryen from "binaryen";

export const VOYD_BINARYEN_FEATURES =
  binaryen.Features.GC |
  binaryen.Features.ReferenceTypes |
  binaryen.Features.TailCall |
  binaryen.Features.Multivalue |
  binaryen.Features.BulkMemory |
  binaryen.Features.SignExt |
  binaryen.Features.MutableGlobals |
  binaryen.Features.ExtendedConst;
