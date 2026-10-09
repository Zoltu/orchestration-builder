import type { VersionToken } from './types.js'

// FIPS 180-4 round constants.
const ROUND_CONSTANTS: number[] = [
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

function rotateRight(value: number, bits: number): number {
	return (value >>> bits) | (value << (32 - bits))
}

// Under noUncheckedIndexedAccess a plain array read is `number | undefined`; the loop bounds make the value present, so a missing constant is a real invariant break and fails fast.
function roundConstant(index: number): number {
	const value = ROUND_CONSTANTS[index]
	if (value === undefined) throw new Error(`sha256: round constant ${index} is out of bounds`)
	return value
}

function formatWord(value: number): string {
	return (value >>> 0).toString(16).padStart(8, '0')
}

// Pure-JS SHA-256 over the UTF-8 bytes of `text`. A hand-rolled hash is required because the module is browser-pure: `Bun.CryptoHasher` is server-only and `crypto.subtle` is unavailable outside a secure context.
export function sha256Hex(text: string): VersionToken {
	const bytes = new TextEncoder().encode(text)
	const bitLength = bytes.length * 8
	const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64
	const padded = new Uint8Array(paddedLength)
	padded.set(bytes)
	padded[bytes.length] = 0x80
	for (let byteIndex = 0; byteIndex < 8; byteIndex++) {
		padded[paddedLength - 1 - byteIndex] = Math.floor(bitLength / 2 ** (8 * byteIndex)) & 0xff
	}
	const message = new DataView(padded.buffer)
	const schedule = new DataView(new ArrayBuffer(256))
	let h0 = 0x6a09e667
	let h1 = 0xbb67ae85
	let h2 = 0x3c6ef372
	let h3 = 0xa54ff53a
	let h4 = 0x510e527f
	let h5 = 0x9b05688c
	let h6 = 0x1f83d9ab
	let h7 = 0x5be0cd19
	for (let offset = 0; offset < paddedLength; offset += 64) {
		for (let index = 0; index < 16; index++) {
			schedule.setUint32(index * 4, message.getUint32(offset + index * 4))
		}
		for (let index = 16; index < 64; index++) {
			const previous15 = schedule.getUint32((index - 15) * 4)
			const previous2 = schedule.getUint32((index - 2) * 4)
			const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3)
			const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10)
			schedule.setUint32(index * 4, (schedule.getUint32((index - 16) * 4) + sigma0 + schedule.getUint32((index - 7) * 4) + sigma1) | 0)
		}
		let a = h0
		let b = h1
		let c = h2
		let d = h3
		let e = h4
		let f = h5
		let g = h6
		let h = h7
		for (let index = 0; index < 64; index++) {
			const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
			const choose = (e & f) ^ (~e & g)
			const temp1 = (h + sum1 + choose + roundConstant(index) + schedule.getUint32(index * 4)) | 0
			const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
			const majority = (a & b) ^ (a & c) ^ (b & c)
			const temp2 = (sum0 + majority) | 0
			h = g
			g = f
			f = e
			e = (d + temp1) | 0
			d = c
			c = b
			b = a
			a = (temp1 + temp2) | 0
		}
		h0 = (h0 + a) | 0
		h1 = (h1 + b) | 0
		h2 = (h2 + c) | 0
		h3 = (h3 + d) | 0
		h4 = (h4 + e) | 0
		h5 = (h5 + f) | 0
		h6 = (h6 + g) | 0
		h7 = (h7 + h) | 0
	}
	return formatWord(h0) + formatWord(h1) + formatWord(h2) + formatWord(h3) + formatWord(h4) + formatWord(h5) + formatWord(h6) + formatWord(h7)
}
