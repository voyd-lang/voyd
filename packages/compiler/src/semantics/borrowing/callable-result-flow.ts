/**
 * Single ownership boundary for callable result provenance and aggregate value
 * reachability. Borrow inference and package-interface construction consume
 * these exports instead of maintaining private result-flow walkers.
 */
export {
  contractWithResultProvenance,
  inferCallableResultProvenance,
  resultCallableFromLambda,
  type CallableResultProvenance,
} from "./result-provenance.js";
export {
  analyzeResultValueFlow,
  type ResultValueProjection,
  type ResultValueSource,
} from "../result-value-flow.js";
