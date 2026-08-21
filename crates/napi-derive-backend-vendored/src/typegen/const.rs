use super::{ToTypeDef, TypeDef};
use crate::{
	NapiConst, ty_to_ts_type,
	typegen::{JSDoc, add_alias},
};

impl ToTypeDef for NapiConst {
	fn to_type_def(&self) -> Option<TypeDef> {
		if self.skip_typescript {
			return None;
		}

		add_alias(self.name.to_string(), self.js_name.to_string());

		Some(TypeDef {
			kind:          "const".to_owned(),
			name:          self.js_name.to_owned(),
			original_name: Some(self.name.to_string()),
			def:           format!(
				"export const {}: {}",
				&self.js_name,
				ty_to_ts_type(&self.type_name, false, false, false).0
			),
			js_mod:        self.js_mod.to_owned(),
			js_doc:        JSDoc::new(&self.comments),
		})
	}
}
