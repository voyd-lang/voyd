export const nestedGenericTraitParamVoyd = `
use std::all

trait Iterator<T>
  fn next(self) -> Optional<T>

trait Iterable<T>
  fn iterate(self) -> Iterator<T>

obj Box<T> {
  value: T
}

impl<T> Iterator<T> for Box<T>
  fn next(self) -> Optional<T>
    Some { value: self.value }

impl<T> Iterable<T> for Box<T>
  fn iterate(self) -> Iterator<T>
    self

pub fn run() -> i32
  let b = Box<i32> { value: 4 }
  call_iterator(b)

fn call_iterator(it: Iterable<i32>) -> i32
  let iterator = it.iterate()
  iterator.next().match(o)
    Some<i32>:
      o.value
    None:
      -1
`;
