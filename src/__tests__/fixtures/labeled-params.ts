export const labeledParamsVoyd = `
use std::all

fn normal(a: i32, { b: i32 }) -> i32
  a + b

fn mixed(a: i32, { b: i32, with c: i32 }) -> i32
  a + b + c

fn move({ x: i32, y: i32, z: i32 }) -> i32
  x + y + z

pub fn normal_labels() -> i32
  normal(1, b: 2)

pub fn mixed_labels() -> i32
  mixed(1, b: 2, with: 4)

pub fn move_vec() -> i32
  let vec = { x: 1, y: 2, z: 3 }
  move(vec)
`;
