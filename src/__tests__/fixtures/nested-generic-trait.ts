export const nestedGenericTraitVoyd = `
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
    None {}

impl<T> Iterable<T> for Box<T>
  fn iterate(self) -> Iterator<T>
    self

pub fn run() -> i32
  let b = Box<i32> { value: 1 }
  let it: Iterable<i32> = b
  let iterator = it.iterate()
  iterator.next()
  0
`;
