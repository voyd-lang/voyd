export const genericUnifyArrayPairVoyd = `
use std::all

// Equivalent test: infer T structurally from an Array<T> parameter
fn head<T>(arr: Array<T>) -> i32
  42

pub fn run() -> i32
  let arr: Array<i32> = [42]
  head(arr)
`;
