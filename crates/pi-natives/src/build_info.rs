use napi_derive::napi;

#[napi(object)]
pub struct BuildInfo {
	pub version: String,
	#[napi(js_name = "languageSet")]
	pub language_set: String,
}

#[napi]
pub fn native_build_info() -> BuildInfo {
	BuildInfo {
		version: env!("CARGO_PKG_VERSION").to_string(),
		language_set: if cfg!(feature = "full-langs") {
			"full"
		} else {
			"default"
		}
		.to_string(),
	}
}
