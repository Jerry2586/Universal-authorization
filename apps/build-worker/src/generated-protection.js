import { createHash } from 'node:crypto';
import JavaScriptObfuscator from 'javascript-obfuscator';
import { invariant } from '../../../packages/core/src/errors.js';

export const GENERATED_JAVASCRIPT_PROTECTION_MARKER = '/* APPGOG-PROTECTED:v1 */';

function protectionSeed(identity) {
  return Number.parseInt(createHash('sha256').update(identity).digest('hex').slice(0, 8), 16);
}

export function assertProtectedGeneratedJavaScript(source, identity, label = '生成的授权脚本') {
  const seed = protectionSeed(identity);
  const identifierPrefix = `_apg_${seed.toString(16)}_0x`;
  const compactLineCount = typeof source === 'string' ? source.split(/\r?\n/).length : 0;
  invariant(typeof source === 'string'
    && source.startsWith(`${GENERATED_JAVASCRIPT_PROTECTION_MARKER}\n`)
    && source.includes(identifierPrefix)
    && compactLineCount <= 3
    && !/[#@]\s*sourceMappingURL=/.test(source),
  'PACKAGE_GENERATED_JAVASCRIPT_UNPROTECTED', `${label}未经过要求的混淆保护，已停止交付`, 409);
}

// Generated runtime and bridge assets need protection after generation, not before it.
// Avoid anti-debugging and self-defending transforms that break legitimate host integrations.
export function protectGeneratedJavaScript(source, identity) {
  const seed = protectionSeed(identity);
  try {
    const protectedSource = `${GENERATED_JAVASCRIPT_PROTECTION_MARKER}\n${JavaScriptObfuscator.obfuscate(source, {
      compact: true, seed, identifierNamesGenerator: 'hexadecimal', identifiersPrefix: `_apg_${seed.toString(16)}_`,
      renameGlobals: true, controlFlowFlattening: false, deadCodeInjection: false,
      debugProtection: false, selfDefending: false, disableConsoleOutput: false,
      stringArray: true, stringArrayEncoding: ['base64'], stringArrayThreshold: 1,
      stringArrayRotate: true, stringArrayShuffle: true, splitStrings: true,
      splitStringsChunkLength: 8, unicodeEscapeSequence: true, sourceMap: false,
    }).getObfuscatedCode()}`;
    assertProtectedGeneratedJavaScript(protectedSource, identity);
    return protectedSource;
  } catch {
    invariant(false, 'GENERATED_JAVASCRIPT_PROTECTION_FAILED', '生成的授权脚本保护失败，已停止交付', 409);
  }
}
