export const optionalParamsVoyd = `
use std::all

fn greet(name: String, middle?: String) -> i32
  match(middle)
    Some<String>:
      2
    None:
      1

pub fn greet_with_middle() -> i32
  greet("John", "Quincy")

pub fn greet_without_middle() -> i32
  greet("John")

fn banner({ title: String, subtitle?: String }) -> i32
  match(subtitle)
    Some<String>:
      2
    None:
      1

pub fn banner_with_subtitle() -> i32
  banner(title: "Hi", subtitle: "There")

pub fn banner_without_subtitle() -> i32
  banner(title: "Hi")

pub fn closure_with_arg() -> i32
  let f = (name: String, middle?: String) => greet(name, middle)
  f("John", "Quincy")

pub fn closure_without_arg() -> i32
  let f = (name: String, middle?: String) => greet(name, middle)
  f("John")
`;
