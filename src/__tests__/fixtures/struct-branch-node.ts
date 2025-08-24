export const structBranchNodeVoyd = `
use std::all

obj Box { val: i32 }

type Branch = Optional<Node> | Box

type Node = {
  value: i32,
  left: Branch,
  right: Branch
}

fn work(node: Node, sum: i32) -> i32
  let extract = (branch: Branch) -> i32 =>
    branch.match(l)
      Some<Node>:
        work(l.value, sum)
      None:
        0
      Box:
        l.val

  let left = extract(node.left)
  let right = extract(node.right)
  node.value + sum + left + right

pub fn main() -> i32
  work({
    value: 3,
    left: Box { val: 5 },
    right: Some {
      value: {
        value: 2,
        left: None {},
        right: None {}
      }
    }
  }, 0)
`;
