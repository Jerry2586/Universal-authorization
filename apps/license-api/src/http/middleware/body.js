import { DomainError } from '../../../../../packages/core/src/errors.js';

export async function readJson(request, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new DomainError('BODY_TOO_LARGE', '请求内容过大', 413);
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new DomainError('JSON_INVALID', '请求 JSON 格式无效', 400);
  }
}

export async function readBuffer(request, limit) {
  const announced = Number(request.headers['content-length'] ?? 0);
  if (announced > limit) throw new DomainError('BODY_TOO_LARGE', '上传文件超出大小限制', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new DomainError('BODY_TOO_LARGE', '上传文件超出大小限制', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
