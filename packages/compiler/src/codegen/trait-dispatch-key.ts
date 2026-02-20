import { murmurHash3 } from "@voyd/lib/murmur-hash.js";
import type { ProgramSymbolId } from "../semantics/ids.js";

export type TraitDispatchKey = {
  traitSymbol: ProgramSymbolId;
  traitMethodSymbol: ProgramSymbolId;
};

export const traitDispatchSignatureKey = ({
  traitSymbol,
  traitMethodSymbol,
}: TraitDispatchKey): string => `${traitSymbol}:${traitMethodSymbol}`;

export const traitDispatchHash = (key: TraitDispatchKey): number =>
  murmurHash3(traitDispatchSignatureKey(key));
