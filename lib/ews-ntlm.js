// ews-ntlm.js — NTLMv2 authentication handshake (pure, Node-testable).
// Exchange servers that reject Basic accept NTLM; Gecko cannot feed explicit
// credentials to its NTLM authenticator non-interactively, so we do the
// 3-message handshake ourselves on top of plain HTTP POSTs:
//   POST Authorization: NTLM <type1> -> 401 WWW-Authenticate: NTLM <type2>
//   POST Authorization: NTLM <type3> -> 200
//
// Primitives (MD4/MD5/HMAC-MD5) are implemented locally; WebCrypto has no
// MD4. Exports:
//   md4(bytes), md5(bytes), hmacMd5(key, msg), utf16le(str),
//   ntHash(password), buildType1Message(), parseType2Message(b64),
//   buildType3Message({ user, domain, password, type2, workstation })

// --- byte helpers ------------------------------------------------------------

function hexToBytes(hex) {
  var out = new Uint8Array(hex.length / 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHex(bytes) {
  var s = "";
  for (var i = 0; i < bytes.length; i++) {
    s += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
  }
  return s;
}

function utf8Bytes(str) {
  // TextEncoder is available in the experiment sandbox; in Node it is global.
  return new TextEncoder().encode(String(str));
}

// UTF-16LE bytes (NT strings are always UTF-16LE).
function utf16le(str) {
  var s = String(str);
  var out = new Uint8Array(s.length * 2);
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    out[i * 2] = c & 0xff;
    out[i * 2 + 1] = (c >> 8) & 0xff;
  }
  return out;
}

function u32le(value) {
  var b = new Uint8Array(4);
  b[0] = value & 0xff;
  b[1] = (value >>> 8) & 0xff;
  b[2] = (value >>> 16) & 0xff;
  b[3] = (value >>> 24) & 0xff;
  return b;
}

function u32leAt(bytes, off) {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | bytes[off + 3] * 0x1000000) >>> 0;
}

function u16leAt(bytes, off) {
  return bytes[off] | (bytes[off + 1] << 8);
}

function u16le(value) {
  var b = new Uint8Array(2);
  b[0] = value & 0xff;
  b[1] = (value >> 8) & 0xff;
  return b;
}

function concat() {
  var len = 0;
  for (var i = 0; i < arguments.length; i++) {
    len += arguments[i].length;
  }
  var out = new Uint8Array(len);
  var pos = 0;
  for (var j = 0; j < arguments.length; j++) {
    out.set(arguments[j], pos);
    pos += arguments[j].length;
  }
  return out;
}

// --- MD4 ---------------------------------------------------------------------

function md4(input) {
  var x = input;
  var bitLen = x.length * 8;
  var padded = concat(x, new Uint8Array([0x80]), new Uint8Array(((56 - ((x.length + 1) % 64)) + 64) % 64), u32le(bitLen), u32le(0));
  var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  for (var off = 0; off < padded.length; off += 64) {
    var X = new Array(16);
    for (var i = 0; i < 16; i++) {
      X[i] = u32leAt(padded, off + i * 4);
    }
    var a = a0, b = b0, c = c0, d = d0;

    // Round 1: F(b,c,d), shifts 3/7/11/19.
    var s1 = [3, 7, 11, 19];
    for (var r1 = 0; r1 < 16; r1++) {
      var f1 = (b & c) | (~b & d);
      var t1 = (a + f1 + X[r1]) | 0;
      a = d;
      d = c;
      c = b;
      b = rotl(t1, s1[r1 % 4]);
    }
    // Round 2: G, order 0,4,8,...,15, shifts 3/5/9/13.
    var s2 = [3, 5, 9, 13];
    var order2 = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15];
    for (var r2 = 0; r2 < 16; r2++) {
      var g2 = (b & c) | (b & d) | (c & d);
      var t2 = (a + g2 + X[order2[r2]] + 0x5a827999) | 0;
      a = d;
      d = c;
      c = b;
      b = rotl(t2, s2[r2 % 4]);
    }
    // Round 3: H, order 0,8,4,12,...,15, shifts 3/9/11/15.
    var s3 = [3, 9, 11, 15];
    var order3 = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
    for (var r3 = 0; r3 < 16; r3++) {
      var h3 = b ^ c ^ d;
      var t3 = (a + h3 + X[order3[r3]] + 0x6ed9eba1) | 0;
      a = d;
      d = c;
      c = b;
      b = rotl(t3, s3[r3 % 4]);
    }

    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  return concat(u32le(a0 >>> 0), u32le(b0 >>> 0), u32le(c0 >>> 0), u32le(d0 >>> 0));
}

// --- MD5 ---------------------------------------------------------------------

// Left-rotate.
function rotl(x, n) {
  return ((x << n) | (x >>> (32 - n))) | 0;
}

function md5(input) {
  var x = input;
  var bitLen = x.length * 8;
  var padded = concat(x, new Uint8Array([0x80]), new Uint8Array(((56 - ((x.length + 1) % 64)) + 64) % 64), u32le(bitLen >>> 0), u32le(Math.floor(bitLen / 0x100000000)));
  var K = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
  ];
  var S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  for (var off = 0; off < padded.length; off += 64) {
    var M = new Array(16);
    for (var i = 0; i < 16; i++) {
      M[i] = u32leAt(padded, off + i * 4);
    }
    var a = a0, b = b0, c = c0, d = d0;
    for (var k = 0; k < 64; k++) {
      var f, g;
      if (k < 16) {
        f = (b & c) | (~b & d);
        g = k;
      } else if (k < 32) {
        f = (d & b) | (~d & c);
        g = (5 * k + 1) % 16;
      } else if (k < 48) {
        f = b ^ c ^ d;
        g = (3 * k + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * k) % 16;
      }
      var tmp = d;
      d = c;
      c = b;
      b = (b + rotl((a + f + K[k] + M[g]) | 0, S[(k >> 4) * 4 + (k % 4)])) | 0;
      a = tmp;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  return concat(u32le(a0 >>> 0), u32le(b0 >>> 0), u32le(c0 >>> 0), u32le(d0 >>> 0));
}

// --- HMAC-MD5 ----------------------------------------------------------------

function hmacMd5(key, msg) {
  var k = key.length > 64 ? md5(key) : key;
  var ipad = new Uint8Array(64);
  var opad = new Uint8Array(64);
  for (var i = 0; i < 64; i++) {
    var kb = i < k.length ? k[i] : 0;
    ipad[i] = kb ^ 0x36;
    opad[i] = kb ^ 0x5c;
  }
  return md5(concat(opad, md5(concat(ipad, msg))));
}

// --- NTLM messages -----------------------------------------------------------

var NTLMSSP_SIG = [0x4e, 0x54, 0x4c, 0x4d, 0x53, 0x53, 0x50, 0x00]; // "NTLMSSP\0"
// NEGOTIATE_UNICODE | REQUEST_TARGET | NEGOTIATE_NTLM | NEGOTIATE_NTLM2_KEY
// (required for the NTLMv2 response format) | NEGOTIATE_TARGET_INFO |
// NEGOTIATE_128.
var FLAGS = 0x00000001 | 0x00000004 | 0x00000200 | 0x00080000 | 0x00800000 | 0x20000000;

function ntHash(password) {
  return md4(utf16le(password));
}

function bytesToBase64(bytes) {
  var bin = "";
  for (var i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  // btoa exists in the experiment sandbox and in Node >= 16.
  return btoa(bin);
}

function base64ToBytes(b64) {
  // Firefox's atob is strict (Node's decoder is lenient): strip anything
  // that is not base64 — header values may carry stray whitespace/quotes.
  var clean = String(b64).replace(/[^A-Za-z0-9+/=]/g, "");
  var bin = atob(clean);
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function buildType1Message() {
  var m = new Uint8Array(16);
  m.set(NTLMSSP_SIG, 0);
  m.set(u32le(1), 8); // type 1
  m.set(u32le(FLAGS), 12);
  return bytesToBase64(m);
}

// Parse a type 2 (challenge) message from the WWW-Authenticate token.
function parseType2Message(b64) {
  var m = base64ToBytes(b64);
  if (m.length < 32 || String.fromCharCode.apply(null, m.subarray(0, 8)) !== "NTLMSSP\0") {
    throw new Error(
      "NTLM: invalid type2 message (token head: " + String(b64).substring(0, 32) + ", decoded " + m.length + " bytes)"
    );
  }
  var type = u32leAt(m, 8);
  if (type !== 2) {
    throw new Error("NTLM: not a type2 message (type=" + type + ")");
  }
  var tiLen = u16leAt(m, 40);
  var tiOff = u32leAt(m, 44);
  return {
    challenge: m.subarray(24, 32),
    targetInfo: tiLen > 0 ? m.subarray(tiOff, tiOff + tiLen) : new Uint8Array(0),
  };
}

// FILETIME (100ns units since 1601-01-01 UTC), low+high 32-bit words.
function filetimeNow() {
  var t = (Date.now() + 11644473600000) * 10000;
  var low = t % 0x100000000;
  var high = Math.floor(t / 0x100000000);
  return concat(u32le(low >>> 0), u32le(high >>> 0));
}

function securityBuffer(data, payloadOffset) {
  var len = data.length;
  return {
    fields: concat(u16le(len), u16le(len), u32le(payloadOffset)),
    data: data,
    size: len,
  };
}

// Build the type 3 (authenticate) message. `type2` is the base64 token from
// the challenge response. `identity` is { user, domain, password }.
function buildType3Message(opts) {
  var type2 = parseType2Message(opts.type2);
  var challenge = type2.challenge;

  var user = utf16le(opts.user);
  var domain = utf16le(opts.domain || "");
  var workstation = utf16le(opts.workstation || "");

  var ntHashBytes = ntHash(opts.password);
  var identity = concat(utf16le(String(opts.user).toUpperCase()), utf16le(String(opts.domain || "").toUpperCase()));
  var ntlmv2Hash = hmacMd5(ntHashBytes, identity);

  var blob = concat(
    new Uint8Array([0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    filetimeNow(),
    (function () {
      var nonce = new Uint8Array(8);
      for (var i = 0; i < 8; i++) {
        nonce[i] = Math.floor(Math.random() * 256);
      }
      return nonce;
    })(),
    new Uint8Array([0x00, 0x00, 0x00, 0x00]),
    type2.targetInfo
  );
  var ntlmv2Response = concat(hmacMd5(ntlmv2Hash, concat(challenge, blob)), blob);

  var lmResponse = new Uint8Array(24); // NTLMv2: LM response not used
  var sessionKey = new Uint8Array(16);

  // Layout: sig(8) + type(4) + 6 security buffer fields (8 bytes each:
  // LM, NTLM, domain, user, workstation, session key) + flags(4) = 64,
  // then the payload.
  var payloadOff = 8 + 4 + 6 * 8 + 4;

  var bufLM = securityBuffer(lmResponse, payloadOff);
  var bufNT = securityBuffer(ntlmv2Response, payloadOff + lmResponse.length);
  var bufDomain = securityBuffer(domain, payloadOff + lmResponse.length + ntlmv2Response.length);
  var bufUser = securityBuffer(user, payloadOff + lmResponse.length + ntlmv2Response.length + domain.length);
  var bufWs = securityBuffer(workstation, payloadOff + lmResponse.length + ntlmv2Response.length + domain.length + user.length);
  var bufKey = securityBuffer(sessionKey, payloadOff + lmResponse.length + ntlmv2Response.length + domain.length + user.length + workstation.length);

  var m = concat(
    NTLMSSP_SIG,
    u32le(3),
    bufLM.fields,
    bufNT.fields,
    bufDomain.fields,
    bufUser.fields,
    bufWs.fields,
    bufKey.fields,
    u32le(FLAGS),
    lmResponse,
    ntlmv2Response,
    domain,
    user,
    workstation,
    sessionKey
  );
  return bytesToBase64(m);
}

// 'DOMAIN\\user' -> { user, domain }; bare user/UPN -> domain ''.
function parseIdentity(email) {
  var s = String(email || "");
  var i = s.indexOf("\\");
  if (i > 0) {
    return { domain: s.substring(0, i), user: s.substring(i + 1) };
  }
  return { domain: "", user: s };
}

// Node test export.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    md4: md4,
    md5: md5,
    hmacMd5: hmacMd5,
    utf8Bytes: utf8Bytes,
    utf16le: utf16le,
    ntHash: ntHash,
    bytesToHex: bytesToHex,
    hexToBytes: hexToBytes,
    bytesToBase64: bytesToBase64,
    buildType1Message: buildType1Message,
    parseType2Message: parseType2Message,
    buildType3Message: buildType3Message,
    parseIdentity: parseIdentity,
  };
}
