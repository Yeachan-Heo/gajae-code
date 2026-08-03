//! Image metadata sniffing from file headers. Port of
//! `packages/utils/src/mime.ts`.

/// Supported image mime types (TS `SUPPORTED_IMAGE_MIME_TYPES`).
pub const SUPPORTED_IMAGE_MIME_TYPES: [&str; 4] =
	["image/png", "image/jpeg", "image/gif", "image/webp"];

/// Metadata extracted from an image header.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ImageMetadata {
	pub mime_type: &'static str,
	pub width:     Option<u32>,
	pub height:    Option<u32>,
	pub channels:  Option<u8>,
	pub has_alpha: Option<bool>,
}

impl ImageMetadata {
	const fn bare(mime_type: &'static str) -> Self {
		Self { mime_type, width: None, height: None, channels: None, has_alpha: None }
	}
}

fn magic_equals(header: &[u8], offset: usize, magic: &[u8]) -> bool {
	header.len() >= offset + magic.len() && &header[offset..offset + magic.len()] == magic
}

fn u16_be(header: &[u8], offset: usize) -> u16 {
	u16::from_be_bytes([header[offset], header[offset + 1]])
}

fn parse_png(header: &[u8]) -> Option<ImageMetadata> {
	if !magic_equals(header, 0, &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
		return None;
	}
	if !magic_equals(header, 12, b"IHDR") || header.len() < 26 {
		return Some(ImageMetadata::bare("image/png"));
	}
	let width = u32::from_be_bytes(header[16..20].try_into().unwrap());
	let height = u32::from_be_bytes(header[20..24].try_into().unwrap());
	let (channels, has_alpha) = match header[25] {
		0 => (Some(1), Some(false)),
		2 => (Some(3), Some(false)),
		3 => (Some(3), None),
		4 => (Some(2), Some(true)),
		6 => (Some(4), Some(true)),
		_ => (None, None),
	};
	Some(ImageMetadata {
		mime_type: "image/png",
		width: Some(width),
		height: Some(height),
		channels,
		has_alpha,
	})
}

fn parse_jpeg(header: &[u8]) -> Option<ImageMetadata> {
	if !magic_equals(header, 0, &[0xff, 0xd8, 0xff]) {
		return None;
	}
	if header.len() < 4 {
		return Some(ImageMetadata::bare("image/jpeg"));
	}
	let mut offset = 2usize;
	while offset + 9 < header.len() {
		if header[offset] != 0xff {
			offset += 1;
			continue;
		}
		let mut marker_offset = offset + 1;
		while marker_offset < header.len() && header[marker_offset] == 0xff {
			marker_offset += 1;
		}
		if marker_offset >= header.len() {
			break;
		}
		let marker = header[marker_offset];
		let segment_offset = marker_offset + 1;
		if marker == 0xd8 || marker == 0xd9 || marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
			offset = segment_offset;
			continue;
		}
		if segment_offset + 1 >= header.len() {
			break;
		}
		let segment_length = u16_be(header, segment_offset) as usize;
		if segment_length < 2 {
			break;
		}
		let is_start_of_frame =
			(0xc0..=0xcf).contains(&marker) && marker != 0xc4 && marker != 0xc8 && marker != 0xcc;
		if is_start_of_frame {
			if segment_offset + 7 >= header.len() {
				break;
			}
			let height = u16_be(header, segment_offset + 3);
			let width = u16_be(header, segment_offset + 5);
			let channels = header[segment_offset + 7];
			return Some(ImageMetadata {
				mime_type: "image/jpeg",
				width:     Some(u32::from(width)),
				height:    Some(u32::from(height)),
				channels:  Some(channels),
				has_alpha: Some(false),
			});
		}
		offset = segment_offset + segment_length;
	}
	Some(ImageMetadata::bare("image/jpeg"))
}

fn parse_gif(header: &[u8]) -> Option<ImageMetadata> {
	if !magic_equals(header, 0, b"GIF87a") && !magic_equals(header, 0, b"GIF89a") {
		return None;
	}
	if header.len() < 10 {
		return Some(ImageMetadata::bare("image/gif"));
	}
	Some(ImageMetadata {
		mime_type: "image/gif",
		width:     Some(u32::from(u16::from_le_bytes([header[6], header[7]]))),
		height:    Some(u32::from(u16::from_le_bytes([header[8], header[9]]))),
		channels:  Some(3),
		has_alpha: None,
	})
}

fn parse_webp(header: &[u8]) -> Option<ImageMetadata> {
	if !magic_equals(header, 0, b"RIFF") || !magic_equals(header, 8, b"WEBP") {
		return None;
	}
	if header.len() < 30 {
		return Some(ImageMetadata::bare("image/webp"));
	}
	if magic_equals(header, 12, b"VP8X") {
		let has_alpha = (header[20] & 0x10) != 0;
		let width =
			(u32::from(header[24]) | (u32::from(header[25]) << 8) | (u32::from(header[26]) << 16)) + 1;
		let height =
			(u32::from(header[27]) | (u32::from(header[28]) << 8) | (u32::from(header[29]) << 16)) + 1;
		return Some(ImageMetadata {
			mime_type: "image/webp",
			width:     Some(width),
			height:    Some(height),
			channels:  Some(if has_alpha { 4 } else { 3 }),
			has_alpha: Some(has_alpha),
		});
	}
	if magic_equals(header, 12, b"VP8L") {
		if header.len() < 25 {
			return Some(ImageMetadata::bare("image/webp"));
		}
		let bits = u32::from_le_bytes(header[21..25].try_into().unwrap());
		let width = (bits & 0x3fff) + 1;
		let height = ((bits >> 14) & 0x3fff) + 1;
		let has_alpha = ((bits >> 28) & 0x1) == 1;
		return Some(ImageMetadata {
			mime_type: "image/webp",
			width:     Some(width),
			height:    Some(height),
			channels:  Some(if has_alpha { 4 } else { 3 }),
			has_alpha: Some(has_alpha),
		});
	}
	if magic_equals(header, 12, b"VP8 ") {
		let width = u32::from(u16::from_le_bytes([header[26], header[27]]) & 0x3fff);
		let height = u32::from(u16::from_le_bytes([header[28], header[29]]) & 0x3fff);
		return Some(ImageMetadata {
			mime_type: "image/webp",
			width:     Some(width),
			height:    Some(height),
			channels:  Some(3),
			has_alpha: Some(false),
		});
	}
	Some(ImageMetadata::bare("image/webp"))
}

/// Sniff image metadata from a file header (TS `parseImageMetadata`).
pub fn parse_image_metadata(header: &[u8]) -> Option<ImageMetadata> {
	parse_png(header)
		.or_else(|| parse_jpeg(header))
		.or_else(|| parse_gif(header))
		.or_else(|| parse_webp(header))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn png_rgba() {
		let mut h = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
		h.extend_from_slice(&[0, 0, 0, 13]); // IHDR length
		h.extend_from_slice(b"IHDR");
		h.extend_from_slice(&64u32.to_be_bytes()); // width
		h.extend_from_slice(&32u32.to_be_bytes()); // height
		h.push(8); // bit depth
		h.push(6); // color type RGBA
		let m = parse_image_metadata(&h).unwrap();
		assert_eq!(m.mime_type, "image/png");
		assert_eq!((m.width, m.height), (Some(64), Some(32)));
		assert_eq!((m.channels, m.has_alpha), (Some(4), Some(true)));
	}

	#[test]
	fn gif_dimensions() {
		let mut h = b"GIF89a".to_vec();
		h.extend_from_slice(&100u16.to_le_bytes());
		h.extend_from_slice(&50u16.to_le_bytes());
		let m = parse_image_metadata(&h).unwrap();
		assert_eq!(m.mime_type, "image/gif");
		assert_eq!((m.width, m.height, m.channels), (Some(100), Some(50), Some(3)));
	}

	#[test]
	fn jpeg_sof() {
		// SOI + SOF0 segment with dimensions.
		let mut h = vec![0xff, 0xd8, 0xff];
		h.push(0xc0); // SOF0 marker (after the 0xff above)
		h.extend_from_slice(&17u16.to_be_bytes()); // segment length
		h.push(8); // precision
		h.extend_from_slice(&240u16.to_be_bytes()); // height
		h.extend_from_slice(&320u16.to_be_bytes()); // width
		h.push(3); // channels
		h.extend_from_slice(&[0; 16]);
		let m = parse_image_metadata(&h).unwrap();
		assert_eq!(m.mime_type, "image/jpeg");
		assert_eq!((m.width, m.height, m.channels), (Some(320), Some(240), Some(3)));
	}

	#[test]
	fn webp_vp8x() {
		let mut h = b"RIFF".to_vec();
		h.extend_from_slice(&[0; 4]);
		h.extend_from_slice(b"WEBP");
		h.extend_from_slice(b"VP8X");
		h.extend_from_slice(&[0; 4]); // chunk size
		h.push(0x10); // flags: alpha
		h.extend_from_slice(&[0, 0, 0]); // reserved
		h.extend_from_slice(&[99, 0, 0]); // width-1 = 99
		h.extend_from_slice(&[49, 0, 0]); // height-1 = 49
		let m = parse_image_metadata(&h).unwrap();
		assert_eq!(m.mime_type, "image/webp");
		assert_eq!((m.width, m.height), (Some(100), Some(50)));
		assert_eq!((m.channels, m.has_alpha), (Some(4), Some(true)));
	}

	#[test]
	fn unknown_returns_none() {
		assert!(parse_image_metadata(b"plain text").is_none());
		assert!(parse_image_metadata(&[]).is_none());
	}
}
