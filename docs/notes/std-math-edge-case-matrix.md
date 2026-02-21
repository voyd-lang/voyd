# std::math Edge-Case Matrix

This note tracks the deterministic hardening coverage for `std::math`.
These suites run in CI via `npm test -w @voyd/std`.

## Integer invariants and boundaries

- `rem_euclid` invariants over signed ranges:
  - non-negative remainder
  - remainder strictly less than modulus
  - `(value - remainder)` divisible by modulus
- `next_multiple_of` invariants over signed ranges:
  - result is `>= value`
  - result is divisible by factor
  - `result - value < factor`
- signed extreme boundaries:
  - `i32::MIN` modulo and next-multiple behavior
  - upper-bound non-overflow stability near `i32::MAX`
- perf smoke:
  - 20k-iteration deterministic loop over `rem_euclid`, `next_multiple_of`,
    and `is_power_of_two`

Coverage source:
- `packages/std/src/math/int.test.voyd`

## Float boundaries and deterministic sweeps

- NaN/infinity behavior checks:
  - `exp(+inf)`, `log2(0.0)`, `ln(-1.0)`, `sqrt(-1.0)`
  - `fract(NaN)`, rounding behavior over infinities
- deterministic transcendental sweeps:
  - `exp(ln(x)) ~= x` for positive range samples
  - `sin(x)^2 + cos(x)^2 ~= 1` across angle sweep
- API shape checks:
  - UFCS usage for pow/trig/log/hypot
  - f32/f64 parity checks for advanced float helpers

Coverage source:
- `packages/std/src/math/float.test.voyd`

## Interpolation/clamping properties

- clamp invariants across deterministic sweep:
  - output remains in requested bounds
- map-range roundtrip sweep:
  - map to normalized range and back, preserving original input within epsilon
- overload + UFCS behavior:
  - positional and labeled overloads
  - UFCS call sites for `lerp`, `inverse_lerp`, `map_range`

Coverage source:
- `packages/std/src/math/interpolate.test.voyd`

## Budget strategy

These checks are deterministic and CI-friendly. Performance is guarded as a
smoke budget (no hard millisecond threshold) to avoid environment flake while
still catching algorithmic regressions in hot integer paths.
