// Vendored from oh-my-pi (MIT) crates/pi-natives/src/utils.rs @
// a85bd5228d9f0f619deade1db78fa49420a721e1 Modified for gajae-code: no source
// changes.
#[macro_export]
macro_rules! env_uint {
	// With clamp range: ... => [$min, $max];
	($( $vis:vis static $name:ident : $type:ty = $env:literal or $default:expr => [$min:expr, $max:expr];)*) => {
		$(
			$vis static $name: std::sync::LazyLock<$type> = std::sync::LazyLock::new(|| {
				std::env::var($env)
					.ok()
					.and_then(|v| std::str::FromStr::from_str(&v).ok())
					.unwrap_or($default)
					.clamp($min, $max)
			});
		)*
	};
	// Without clamp range: ...; (no => [])
	($( $vis:vis static $name:ident : $type:ty = $env:literal or $default:expr;)*) => {
		$(
			$vis static $name: std::sync::LazyLock<$type> = std::sync::LazyLock::new(|| {
				std::env::var($env)
					.ok()
					.and_then(|v| std::str::FromStr::from_str(&v).ok())
					.unwrap_or($default)
			});
		)*
	};
}

/// Saturating cast from `u64` to `u32`, clamping at [`u32::MAX`].
pub const fn clamp_u32(value: u64) -> u32 {
	if value > u32::MAX as u64 {
		u32::MAX
	} else {
		value as u32
	}
}
