export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const PNG_CRC_TABLE = new Uint32Array(256).map((_, index) => {
	let crc = index;
	for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
	return crc >>> 0;
});

export function pngCrc32(bytes: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

export function pngChunk(type: string, data = Buffer.alloc(0)): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const typeBytes = Buffer.from(type, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(pngCrc32(Buffer.concat([typeBytes, data])), 0);
	return Buffer.concat([length, typeBytes, data, crc]);
}
