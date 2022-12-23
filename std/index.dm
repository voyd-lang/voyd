use dir/macros ***
use dir/memory ***
use dir/string ***

pub def-wasm-operator('<' lt_s i32 i32)
pub def-wasm-operator('>' gt_s i32 i32)
pub def-wasm-operator('<=' le_s i32 i32)
pub def-wasm-operator('>=' ge_s i32 i32)
pub def-wasm-operator('==' eq i32 i32)
pub def-wasm-operator('and' 'and' i32 i32)
pub def-wasm-operator('or' 'or' i32 i32)
pub def-wasm-operator('xor' 'xor' i32 i32)
pub def-wasm-operator('not' ne i32 i32)
pub def-wasm-operator('+' add i32 i32)
pub def-wasm-operator('-' sub i32 i32)
pub def-wasm-operator('*' mul i32 i32)
pub def-wasm-operator('/' div_s i32 i32)

pub def-wasm-operator('<' lt f32 i32)
pub def-wasm-operator('>' gt f32 i32)
pub def-wasm-operator('<=' le f32 i32)
pub def-wasm-operator('>=' ge f32 i32)
pub def-wasm-operator('==' eq f32 i32)
pub def-wasm-operator('not' ne f32 i32)
pub def-wasm-operator('+' add f32 f32)
pub def-wasm-operator('-' sub f32 f32)
pub def-wasm-operator('*' mul f32 f32)
pub def-wasm-operator('/' div f32 f32)
