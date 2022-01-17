# Unsafe Code

Some functions are marked as unsafe. An unsafe function can cause undefined behavior if not used
with extreme care.

Some examples of unsafe functions are:
- linear memory access functions (i32_load, i32_store, etc.)
- Atomic memory access functions
- Host operation functions (grow_memory)
- Raw threading functions

# Using an Unsafe Function

To use an unsafe function you must call the function within an unsafe block or another
unsafe function:
```
unsafe fn do_unsafe_thing() {
  // Do unsafe things
}

unsafe fn call_unsafe_function() {
  do_unsafe_thing()
}

fn safely_call_unsafe_function() {
  unsafe {
    call_unsafe_function()
  }
}

fn bad_unsafe_function() {
  do_unsafe_thing() // ERROR: do_unsafe_thing is unsafe
}
```

Calling unsafe functions from unsafe blocks means that you know what your doing, have covered the
block with robust unit tests, and have a really good reason for doing so.
