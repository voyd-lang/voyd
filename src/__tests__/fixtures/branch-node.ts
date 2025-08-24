export const branchNodeVoyd = `
use std::all

obj Box { val: i32 }

type Branch = Optional<Node> | Box

obj Node {
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
  let node = Node {
    value: 3,
    left: Box { val: 5 },
    right: Some {
      value: Node {
        value: 2,
        left: None {},
        right: None {}
      }
    }
  }
  work(node, 0)
`;
