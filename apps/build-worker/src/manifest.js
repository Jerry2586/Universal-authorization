import { createHash, randomInt } from 'node:crypto';

export function createBuildInjection({ product, version, buildId, packageId, packageSecret, licenseServer, publicKey }) {
  const chunks = splitAndShuffle(packageSecret);
  return {
    product,
    version,
    build_id: buildId,
    package_id: packageId,
    license_server: licenseServer,
    public_key: publicKey,
    package_proof_parts: chunks.parts,
    package_proof_order: chunks.order,
    manifest_checksum: createHash('sha256').update(`${buildId}:${packageId}:${version}`).digest('hex'),
  };
}

export function restorePackageProof(manifest) {
  return manifest.package_proof_order.map((index) => manifest.package_proof_parts[index]).join('');
}

function splitAndShuffle(value) {
  const size = Math.ceil(value.length / 5);
  const natural = [];
  for (let offset = 0; offset < value.length; offset += size) natural.push(value.slice(offset, offset + size));
  const order = natural.map((_, index) => index);
  for (let index = order.length - 1; index > 0; index -= 1) {
    const swap = randomInt(index + 1);
    [order[index], order[swap]] = [order[swap], order[index]];
  }
  const parts = order.map((originalIndex) => natural[originalIndex]);
  const restoreOrder = natural.map((_, originalIndex) => order.indexOf(originalIndex));
  return { parts, order: restoreOrder };
}
