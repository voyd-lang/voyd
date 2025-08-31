export const structuralInferenceVoyd = `
use std::all

fn get_x<T>(o: { x: T }) -> T
  o.x

pub fn test1() -> i32
  let obj = { x: 1, y: 2 }
  get_x(obj)
`;
