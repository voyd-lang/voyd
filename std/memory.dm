use dir/macros ***

global let header-size:i32 = 8
global var stack-pointer:i32 = 0

// Returns a pointer with the location of the allocation
pub fn alloc(size:i32) -> i32
	ensure-space(size)
	let address:i32 = stack-pointer
	stack-pointer = stack-pointer + size + header-size
	address

// Sets the stack pointer to the end of a function return space, returns the return address
pub fn set-return(return-address:i32) -> i32
	let size:i32 = bnr (i32 load) ((host-num 0) (host-num 0) return-address)
	stack-pointer = return-address + size
	return-address

pub fn read-i32(address:i32 offset:i32) -> i32
	bnr (i32 load) ((host-num 0) (host-num 0) (address + offset + header-size))

pub fn store-i32(address:i32 offset:i32 value:i32) -> void
	bnr (i32 store) ((host-num 0) (host-num 0) (address + offset + header-size) value)

fn ensure-space(size:i32) -> i32
	let mem-size:i32 = bnr (memory size)
	if (stack-pointer + size + header-size) >= (mem-size * 65536))
		bnr (memory grow) (1)
		0
