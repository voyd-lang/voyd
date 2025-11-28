export const traitObjectsVoyd = `
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

pub fn dynamic_dispatch() -> i32
  call_run(A {}) + call_run(B {})

trait MyIterator<T>
  fn next(self) -> Optional<T>

trait MyIterable<T>
  fn iterate(self) -> MyIterator<T>

obj ArrayMyIterator<T> {
  index: i32,
  array: Array<T>
}

impl<T> MyIterator<T> for ArrayMyIterator<T>
  fn next(self) -> Optional<T>
    if self.index >= self.array.length then:
      None {}
    else:
      let r = self.array.get(self.index)
      self.index = self.index + 1
      r

impl<T> MyIterable<T> for Array<T>
  fn iterate(self) -> MyIterator<T>
    ArrayMyIterator<T> { index: 0, array: self }

fn sum_iterable(it: MyIterable<i32>) -> i32
  let iterator = it.iterate()
  let looper: (s: i32) -> i32 = (start: i32) =>
    iterator.next().match(opt)
      Some<i32>:
        looper(start + opt.value)
      None:
        start
  looper(0)

fn sum_iterable(it: MyIterable<f64>) -> f64
  let iterator = it.iterate()
  let looper: (s: f64) -> f64 = (start: f64) =>
    iterator.next().match(opt)
      Some<f64>:
        looper(start + opt.value)
      None:
        start
  looper(0.0)

fn sum2(it1: MyIterable<f64>, it2: MyIterable<i32>) -> i32
  let f_sum = it1.sum_iterable()
  let i_sum = it2.sum_iterable()
  if f_sum > 20.0 then:
    1
  else:
    if i_sum > 2 then:
      2
    else:
      3

pub fn multiple_params() -> i32
  let f_arr = [1.0, 2.0, 3.0]
  let i_arr = [1, 2, 3]
  f_arr.sum2(i_arr)

trait Trait<T>
  fn id(self) -> T

obj Wrapper<T> {
  value: T
}

impl<T> Trait<T> for Wrapper<T>
  fn id(self) -> T
    self.value

pub fn generic_trait() -> i32
  let w = Wrapper<i32> { value: 1 }
  let t: Trait<i32> = w
  t.id()

obj Box<T> {
  value: T
}

impl<T> MyIterator<T> for Box<T>
  fn next(self) -> Optional<T>
    Some { value: self.value }

impl<T> MyIterable<T> for Box<T>
  fn iterate(self) -> MyIterator<T>
    self

fn call_iterator(it: MyIterable<i32>) -> i32
  let iterator = it.iterate()
  iterator.next().match(o)
    Some<i32>:
      o.value
    None:
      -1

pub fn nested_generic_param() -> i32
  let b = Box<i32> { value: 4 }
  call_iterator(b)
`;

