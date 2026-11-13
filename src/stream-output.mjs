const utf8Strict = new TextDecoder('utf-8', { fatal: true });
let gbk;
let utf8Lossy;

function decoder(name) {
  try { return new TextDecoder(name); }
  catch { return null; }
}

function incompleteTail(bytes, max = 3) {
  for (let trim = 1; trim <= Math.min(max, bytes.length); trim += 1) {
    const index = bytes.length - trim;
    const byte = bytes[index];
    if ((byte & 0xc0) === 0x80) continue;
    if ((byte & 0x80) === 0) return 0;
    let need = 0;
    if ((byte & 0xe0) === 0xc0) need = 2;
    else if ((byte & 0xf0) === 0xe0) need = 3;
    else if ((byte & 0xf8) === 0xf0) need = 4;
    if (!need) return 0;
    return index + need > bytes.length ? trim : 0;
  }
  return 0;
}

export function decodeBytes(input, { trimLead = false, trimTail = false } = {}) {
  let bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (!bytes.length) return '';
  if (trimLead) {
    let start = 0;
    while (start < bytes.length && start < 4 && (bytes[start] & 0xc0) === 0x80) start += 1;
    bytes = bytes.subarray(start);
  }
  if (trimTail) {
    const trim = incompleteTail(bytes);
    if (trim) bytes = bytes.subarray(0, bytes.length - trim);
  }
  if (!bytes.length) return '';
  try { return utf8Strict.decode(bytes); } catch {}
  if (trimLead || trimTail) {
    let relaxed = bytes;
    if (trimTail) { const trim = incompleteTail(relaxed); if (trim) relaxed = relaxed.subarray(0, relaxed.length - trim); }
    if (trimLead) { let start = 0; while (start < relaxed.length && start < 4 && (relaxed[start] & 0xc0) === 0x80) start += 1; relaxed = relaxed.subarray(start); }
    try { return utf8Strict.decode(relaxed); } catch {}
  }
  gbk ??= decoder('gbk');
  if (gbk) {
    try { return gbk.decode(bytes); } catch {}
  }
  utf8Lossy ??= new TextDecoder();
  return utf8Lossy.decode(bytes);
}

/**
 * A byte collector that keeps both ends of a stream. The head shows how the
 * output starts; the tail keeps the diagnostics that usually appear last.
 */
export function createTailCollector(limit = 64 * 1024) {
  const total = Math.max(1024, limit);
  const headLimit = Math.floor(total / 4);
  const tailLimit = total - headLimit;
  // The head is written once into a fixed buffer; the tail is a ring that only
  // advances its start pointer, so a steady stream copies each byte once
  // instead of re-concatenating up to tailLimit bytes per chunk.
  const head = Buffer.allocUnsafe(headLimit);
  let headLength = 0;
  let ring = null;
  let ringStart = 0;
  let ringLength = 0;
  let bytes = 0;

  const appendTail = (value) => {
    const length = value.length;
    if (!length) return;
    ring ??= Buffer.allocUnsafe(tailLimit);
    if (length >= tailLimit) {
      value.copy(ring, 0, length - tailLimit, length);
      ringStart = 0;
      ringLength = tailLimit;
      return;
    }
    let writeAt = ringStart + ringLength;
    if (writeAt >= tailLimit) writeAt -= tailLimit;
    const first = Math.min(length, tailLimit - writeAt);
    value.copy(ring, writeAt, 0, first);
    if (first < length) value.copy(ring, 0, first, length);
    ringLength += length;
    if (ringLength > tailLimit) {
      ringStart = (ringStart + (ringLength - tailLimit)) % tailLimit;
      ringLength = tailLimit;
    }
  };

  const tailBytes = () => {
    if (!ringLength) return Buffer.alloc(0);
    if (ringStart + ringLength <= tailLimit) return ring.subarray(ringStart, ringStart + ringLength);
    return Buffer.concat([ring.subarray(ringStart, tailLimit), ring.subarray(0, ringStart + ringLength - tailLimit)]);
  };

  return {
    push(chunk) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (!value.length) return;
      bytes += value.length;
      if (headLength < headLimit) {
        const take = Math.min(headLimit - headLength, value.length);
        value.copy(head, headLength, 0, take);
        headLength += take;
        appendTail(value.subarray(take));
      } else appendTail(value);
    },
    read() {
      const truncated = bytes > headLimit + tailLimit;
      const omitted = Math.max(0, bytes - headLength - ringLength);
      const text = [
        decodeBytes(head.subarray(0, headLength), { trimTail: true }),
        truncated ? '\n…[truncated: 已省略 ' + omitted + ' 字节，保留开头与末尾]…\n' : '',
        decodeBytes(tailBytes(), { trimLead: true }),
      ].join('');
      return { text, truncated, bytes, omitted };
    },
  };
}

export function trimToLimit(value, limit = 64 * 1024) {
  const text = String(value ?? '');
  const buffer = Buffer.from(text);
  if (buffer.length <= limit) return { text, truncated: false, bytes: buffer.length, omitted: 0 };
  const headLimit = Math.floor(limit / 4);
  const tailLimit = limit - headLimit;
  const omitted = buffer.length - headLimit - tailLimit;
  return {
    text: decodeBytes(buffer.subarray(0, headLimit), { trimTail: true })
      + '\n…[truncated: 已省略 ' + omitted + ' 字节，保留开头与末尾]…\n'
      + decodeBytes(buffer.subarray(buffer.length - tailLimit), { trimLead: true }),
    truncated: true, bytes: buffer.length, omitted,
  };
}
