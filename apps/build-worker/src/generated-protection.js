import { createHash } from 'node:crypto';
import JavaScriptObfuscator from 'javascript-obfuscator';
import { invariant } from '../../../packages/core/src/errors.js';

// Generated runtime and bridge assets need protection after generation, not before it.
// Avoid anti-debugging and self-defending transforms that break legitimate host integrations.
export function protectGeneratedJavaScript(source, identity) {
  const seed = Number.parseInt(createHash('sha256').update(identity).digest('hex').slice(0, 8), 16);
  try {
    return `/* APPGOG-PROTECTED:v1 */\n${JavaScriptObfuscator.obfuscate(source, {
      compact: true, seed, identifierNamesGenerator: 'hexadecimal', identifiersPrefix: `_apg_${seed.toString(16)}_`,
      renameGlobals: false, controlFlowFlattening: false, deadCodeInjection: false,
      debugProtection: false, selfDefending: false, disableConsoleOutput: false,
      stringArray: true, stringArrayEncoding: ['base64'], stringArrayThreshold: 1,
      stringArrayRotate: true, stringArrayShuffle: true, splitStrings: true,
      splitStringsChunkLength: 8, unicodeEscapeSequence: true, sourceMap: false,
    }).getObfuscatedCode()}`;
  } catch {
    invariant(false, 'GENERATED_JAVASCRIPT_PROTECTION_FAILED', '生成的授权脚本保护失败，已停止交付', 409);
  }
}
