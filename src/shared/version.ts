export function compareVersions(left: string, right: string): number {
  const leftParts = tokenize(left);
  const rightParts = tokenize(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart === rightPart) continue;
    if (typeof leftPart === 'number' && typeof rightPart === 'number') return leftPart < rightPart ? -1 : 1;
    if (typeof leftPart === 'number') return 1;
    if (typeof rightPart === 'number') return -1;
    const result = leftPart.localeCompare(rightPart, 'en', { sensitivity: 'base' });
    if (result !== 0) return result < 0 ? -1 : 1;
  }
  return 0;
}

function tokenize(version: string): Array<number | string> {
  return version
    .trim()
    .replace(/^v/i, '')
    .split(/[.+_-]/)
    .flatMap((part) => part.match(/\d+|[A-Za-z]+/g) ?? [part])
    .map((part) => /^\d+$/.test(part) ? Number(part) : part.toLowerCase());
}
