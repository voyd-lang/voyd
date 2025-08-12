export const labeledParamsVoyd = `
use std::all

fn normal(a: i32, { b: i32 }) -> i32
  a + b

fn mixed(a: i32, { b: i32, with c: i32 }) -> i32
  a + b + c

pub fn normal_labels() -> i32
  normal(1, b: 2)

pub fn mixed_labels() -> i32
  mixed(1, b: 2, with: 4)
`;
