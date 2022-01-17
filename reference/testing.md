# Testing Dream Code

Testing is built into Dream.

Tests are performed in a test block with an optional title:
```
test "My Test" {
  assert(2 == 2)
}
```

You can also leave a description of the test in the test block:
```
test "My Test" {
  description "Asserts that logic isn't broken"
  assert(2 == 2)
}
```

Test blocks can be nested:
```
test "My Test" {
  assert(2 == 2)
  test "Nested Test" {
    assert(2 == 2)
  }
}
```

# Test Blocks Ignore Access Modifiers

Test blocks have a special ability. They ignore access modifiers, meaning they have access
to private functions and properties.

Take this module for example:
```
// my_struct.dm

pub struct MyStruct {
  let x: Int
  pub let y: Int

  fn private_method() {
    print("Hello")
  }

  pub fn public_method() {
    private_function()
  }
}

pub fn public_function() {

}

fn private_function() {

}
```

Normally, you would not be able to access `private_method`, `private_function` or `x`:
```
use my_struct.[
  my_struct,
  public_function,
  private_function, // ERROR: private_function is private
];

let my_struct = MyStruct(x: 1, y: 2)
my_struct.private_method() // ERROR: private_method is not visible
my_struct.x // ERROR: x is not visible
```

However, in a test block those access modifiers are ignored:
```
test "My Struct" {
  use my_struct.[
    my_struct,
    public_function,
    private_function, // OK: private_function is allowed in test blocks
  ];

  let my_struct = MyStruct(x: 1, y: 2)
  my_struct.private_method() // OK: private_method is allowed in test blocks
  my_struct.x // OK: x is allowed in test blocks
}
```
