export const traitObjectMultipleParamsVoyd = `
use std::all

trait Iterator<T>
  fn next(self) -> Optional<T>

trait Iterable<T>
  fn iterate(self) -> Iterator<T>

obj ArrayIterator<T> {
  index: i32,
  array: Array<T>
}

impl<T> Iterator<T> for ArrayIterator<T>
  fn next(self) -> Optional<T>
    if self.index >= self.array.length then:
      None {}
    else:
      let r = self.array.get(self.index)
      self.index = self.index + 1
      r

impl<T> Iterable<T> for Array<T>
  fn iterate(self) -> Iterator<T>
    ArrayIterator<T> { index: 0, array: self }

pub fn run() -> i32
  let f_arr = [1.0, 2.0, 3.0]
  let i_arr = [1, 2, 3]
  f_arr.sum2(i_arr)

fn sum_iterable(it: Iterable<i32>) -> i32
  let iterator = it.iterate()
  let looper: (s: i32) -> i32 = (start: i32) =>
    iterator.next().match(opt)
      Some<i32>:
        looper(start + opt.value)
      None:
        start
  looper(0)

fn sum_iterable(it: Iterable<f64>) -> f64
  let iterator = it.iterate()
  let looper: (s: f64) -> f64 = (start: f64) =>
    iterator.next().match(opt)
      Some<f64>:
        looper(start + opt.value)
      None:
        start
  looper(0.0)

fn sum2(it1: Iterable<f64>, it2: Iterable<i32>) -> i32
  let f_sum = it1.sum_iterable()
  let i_sum = it2.sum_iterable()
  if f_sum > 20.0 then:
    1
  else:
    if i_sum > 2 then:
      2
    else:
      3
`;
