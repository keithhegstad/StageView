// ── Codec detection ─────────────────────────────────────────────────────────
// Builds the RFC 6381 codec string MSE needs (e.g. "avc1.640028",
// "hev1.1.6.L120.B0") from the bytes of an fMP4 init segment.
// Returns null until the decoder configuration record has arrived.

function findFourcc(bytes, fourcc) {
  const c = [...fourcc].map((ch) => ch.charCodeAt(0));
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (bytes[i] === c[0] && bytes[i + 1] === c[1] && bytes[i + 2] === c[2] && bytes[i + 3] === c[3]) {
      return i;
    }
  }
  return -1;
}

function hex2(b) {
  return b.toString(16).padStart(2, '0');
}

function detectCodecString(bytes) {
  // AVCDecoderConfigurationRecord: version, profile, compatibility, level
  const avcC = findFourcc(bytes, 'avcC');
  if (avcC >= 0) {
    if (avcC + 8 > bytes.length) return null;
    return `avc1.${hex2(bytes[avcC + 5])}${hex2(bytes[avcC + 6])}${hex2(bytes[avcC + 7])}`;
  }

  // HEVCDecoderConfigurationRecord: version, space/tier/profile, 32 compat
  // flags, 48 constraint bits, level
  const hvcC = findFourcc(bytes, 'hvcC');
  if (hvcC >= 0) {
    if (hvcC + 17 > bytes.length) return null;
    const entry = findFourcc(bytes, 'hvc1') >= 0 ? 'hvc1' : 'hev1';
    const b = bytes[hvcC + 5];
    const space = ['', 'A', 'B', 'C'][b >> 6];
    const tier = b & 0x20 ? 'H' : 'L';
    const profile = b & 0x1f;

    // RFC 6381 writes the compatibility flags bit-reversed
    let compat = ((bytes[hvcC + 6] << 24) | (bytes[hvcC + 7] << 16) | (bytes[hvcC + 8] << 8) | bytes[hvcC + 9]) >>> 0;
    let reversed = 0;
    for (let k = 0; k < 32; k++) {
      reversed = ((reversed << 1) | (compat & 1)) >>> 0;
      compat >>>= 1;
    }

    const constraints = Array.from(bytes.slice(hvcC + 10, hvcC + 16));
    while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop();
    const constraintStr = constraints.map((x) => '.' + x.toString(16).toUpperCase()).join('');

    const level = bytes[hvcC + 16];
    return `${entry}.${space}${profile}.${reversed.toString(16).toUpperCase()}.${tier}${level}${constraintStr}`;
  }

  return null;
}

if (typeof module !== 'undefined') module.exports = { detectCodecString };
