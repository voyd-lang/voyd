
# Overloading and Traits With Default Implementations in Dream

Dream supports both method overloading and default implementations. In other languages
like swift, [this can cause subtle bugs](http://developear.com/blog/2017/02/26/swift-protocols.html)

Dream solves this by only allowing traits to be implemented in their own impl blocks. Those
impl blocks can only contain code that implements the features of that trait. So if you accidentally
add a parameter that would revert the implementation to the default, the compiler would
throw an error saying the method inside the impl block is unrelated to the trait being implemented.
