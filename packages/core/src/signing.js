import { sign, verify } from 'node:crypto';
import { base64urlDecode, base64urlEncode, stableJson } from './encoding.js';
import { DomainError, invariant } from './errors.js';

const HEADER = Object.freeze({ alg: 'EdDSA', typ: 'APPGOG-ACT', v: 1 });

export function signCompactToken(payload, privateKey) {
  const header = base64urlEncode(stableJson(HEADER));
  const body = base64urlEncode(stableJson(payload));
  const content = `${header}.${body}`;
  const signature = sign(null, Buffer.from(content), privateKey);
  return `${content}.${base64urlEncode(signature)}`;
}

export function verifyCompactToken(token, publicKey) {
  try {
    const parts = token.split('.');
    invariant(parts.length === 3, 'TOKEN_INVALID', '授权凭证格式无效', 401);
    const [headerPart, payloadPart, signaturePart] = parts;
    const header = JSON.parse(base64urlDecode(headerPart).toString('utf8'));
    invariant(header.alg === 'EdDSA' && header.typ === 'APPGOG-ACT' && header.v === 1, 'TOKEN_INVALID', '授权凭证头无效', 401);
    const valid = verify(
      null,
      Buffer.from(`${headerPart}.${payloadPart}`),
      publicKey,
      base64urlDecode(signaturePart),
    );
    invariant(valid, 'TOKEN_SIGNATURE_INVALID', '授权凭证签名无效', 401);
    return JSON.parse(base64urlDecode(payloadPart).toString('utf8'));
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('TOKEN_INVALID', '授权凭证无法解析', 401);
  }
}
