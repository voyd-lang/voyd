export const traitObjectDynamicDispatchVoyd = `
use std::all

trait Runner
  fn run(self) -> i32

obj A {}
obj B {}

impl Runner for A
  fn run(self) -> i32 1

impl Runner for B
  fn run(self) -> i32 2

fn call_run(r: Runner) -> i32
  r.run()

pub fn run() -> i32
  call_run(A {}) + call_run(B {})
`;
