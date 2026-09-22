import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { posix } from 'node:path';
import { DomainError, invariant } from './errors.js';

const LOCAL_FILE = 0x04034b50;
const CENTRAL_FILE = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function safeName(rawName) {
  const name = rawName.replaceAll('\\', '/').replace(/^\.\//, '');
  invariant(name && !name.startsWith('/') && !/^[a-zA-Z]:\//.test(name), 'ZIP_PATH_INVALID', 'ZIP 包含绝对路径', 400);
  const normalized = posix.normalize(name);
  invariant(normalized !== '..' && !normalized.startsWith('../') && !normalized.includes('/../'), 'ZIP_PATH_INVALID', 'ZIP 包含越界路径', 400);
  invariant(!normalized.includes('\0'), 'ZIP_PATH_INVALID', 'ZIP 文件名无效', 400);
  return normalized;
}

function findEnd(buffer) {
  const minimum = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL) return offset;
  }
  throw new Error('ZIP_END_NOT_FOUND');
}

export function readZip(buffer, limits = {}) {
  invariant(Buffer.isBuffer(buffer) && buffer.length >= 22, 'ZIP_INVALID', '上传文件不是有效 ZIP', 400);
  const maxEntries = limits.maxEntries ?? 5000;
  const maxUncompressedBytes = limits.maxUncompressedBytes ?? 256 * 1024 * 1024;
  const maxSingleFileBytes = limits.maxSingleFileBytes ?? 64 * 1024 * 1024;
  const end = findEnd(buffer);
  const count = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  const centralOffset = buffer.readUInt32LE(end + 16);
  invariant(count <= maxEntries, 'ZIP_TOO_MANY_FILES', `ZIP 文件数量不能超过 ${maxEntries}`, 413);
  invariant(centralOffset + centralSize <= buffer.length, 'ZIP_INVALID', 'ZIP 中央目录损坏', 400);
  const files = new Map();
  let offset = centralOffset;
  let totalSize = 0;
  for (let index = 0; index < count; index += 1) {
    invariant(buffer.readUInt32LE(offset) === CENTRAL_FILE, 'ZIP_INVALID', 'ZIP 中央目录格式无效', 400);
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = safeName(buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'));
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    invariant((flags & 1) === 0, 'ZIP_ENCRYPTED', '不支持加密 ZIP，请上传 Xboard 可直接安装的普通 ZIP', 400);
    invariant(method === 0 || method === 8, 'ZIP_COMPRESSION_UNSUPPORTED', `ZIP 文件 ${name} 使用了不支持的压缩方式`, 400);
    const unixMode = externalAttributes >>> 16;
    invariant((unixMode & 0o170000) !== 0o120000, 'ZIP_SYMLINK_REJECTED', 'ZIP 不能包含符号链接', 400);
    invariant(uncompressedSize <= maxSingleFileBytes, 'ZIP_FILE_TOO_LARGE', `文件 ${name} 超出大小限制`, 413);
    totalSize += uncompressedSize;
    invariant(totalSize <= maxUncompressedBytes, 'ZIP_EXPANDED_TOO_LARGE', 'ZIP 解压后体积超出限制', 413);
    if (compressedSize > 0) invariant(uncompressedSize / compressedSize <= 250, 'ZIP_SUSPICIOUS_RATIO', `文件 ${name} 压缩比异常`, 400);
    invariant(buffer.readUInt32LE(localOffset) === LOCAL_FILE, 'ZIP_INVALID', `ZIP 文件 ${name} 的本地头无效`, 400);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    invariant(compressed.length === compressedSize, 'ZIP_INVALID', `ZIP 文件 ${name} 数据不完整`, 400);
    let content;
    try {
      content = method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: maxSingleFileBytes + 1 });
    } catch {
      throw new DomainError('ZIP_INFLATE_FAILED', `ZIP 文件 ${name} 无法安全解压`, 400);
    }
    invariant(content.length === uncompressedSize, 'ZIP_INVALID', `ZIP 文件 ${name} 解压长度不一致`, 400);
    invariant(crc32(content) === expectedCrc, 'ZIP_CRC_INVALID', `ZIP 文件 ${name} 校验失败`, 400);
    invariant(!files.has(name), 'ZIP_DUPLICATE_PATH', `ZIP 包含重复路径 ${name}`, 400);
    files.set(name, content);
  }
  return files;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

export function writeZip(inputFiles, options = {}) {
  const files = inputFiles instanceof Map ? [...inputFiles.entries()] : Object.entries(inputFiles);
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  const stamp = dosDateTime(options.date ?? new Date());
  for (const [rawName, rawContent] of files.sort(([left], [right]) => left.localeCompare(right))) {
    const name = safeName(rawName);
    const nameBuffer = Buffer.from(name, 'utf8');
    const content = Buffer.isBuffer(rawContent) ? rawContent : Buffer.from(rawContent);
    const compressed = deflateRawSync(content, { level: 9 });
    const useDeflate = compressed.length < content.length;
    const body = useDeflate ? compressed : content;
    const method = useDeflate ? 8 : 0;
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_FILE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.day, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuffer, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_FILE, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.day, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBuffer);
    localOffset += local.length + nameBuffer.length + body.length;
  }
  const centralOffset = localOffset;
  const centralBuffer = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralBuffer, end]);
}
