use dir/macros ***

global let header-size:i32 = 8
global let size-index:i32 = 0
global let type-index:i32 = 4
global var stack-pointer:i32 = 0

// Returns a pointer with the location of the allocation
pub fn alloc(size:i32) -> i32
	ensure-space(size)
	let address:i32 = stack-pointer
	stack-pointer = stack-pointer + size + header-size
	bnr (i32 store) (`(0) `(2) address size + header-size)
	address

// Returns dest pointer
pub fn copy(src:i32 dest:i32) -> i32
	bnr (memory copy) (dest src src.size)
	dest

pub fn size(address:i32) -> i32
	bnr (i32 load) (`(0) `(2) size-index + address)

// Sets the stack pointer to the end of a function return space, returns the return address
pub fn set-return(return-address:i32) -> i32
	stack-pointer = return-address + return-address.size
	return-address

// For external load and store use. Add header size automatically to offset
pub fn read-i32(address:i32 offset:i32) -> i32
	bnr (i32 load) (`(0) `(2) (address + offset + header-size))

// For external load and store use. Add header size automatically to offset
pub fn store-i32(address:i32 offset:i32 value:i32) -> void
	bnr (i32 store) (`(0) `(2) (address + offset + header-size) value)

fn ensure-space(size:i32) -> i32
	let mem-size:i32 = bnr (memory size)
	if (stack-pointer + size + header-size) >= (mem-size * 65536))
		bnr (memory grow) (1)
		0
