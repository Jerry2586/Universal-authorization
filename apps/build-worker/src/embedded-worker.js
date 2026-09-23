export function startEmbeddedWorker({ portal, buildEngine, artifactStore, workerId = 'embedded-worker-1', intervalMs = 1200 }) {
  let timer = null;
  let stopped = false;
  let running = false;

  async function tick() {
    if (stopped || running) return;
    running = true;
    let leased = null;
    try {
      leased = portal.leaseBuild(workerId);
      if (!leased) return;
      portal.updateBuildProgress(workerId, leased.job.id, { progress: 18, message: '正在安全检查主题 ZIP' });
      const result = await buildEngine.build({
        sourceRef: leased.source.source_ref,
        product: leased.build.product,
        version: leased.build.version,
        buildId: leased.build.buildId,
        packageId: leased.build.packageId,
        packageSecret: leased.build.packageSecret,
        packageManifestToken: leased.build.packageManifestToken,
        watermark: leased.build.watermark,
        domain: leased.build.domain,
      });
      portal.updateBuildProgress(workerId, leased.job.id, { progress: 82, message: '正在生成可安装 ZIP' });
      const artifactRef = `builds/${leased.job.id}/APPGOG-${leased.build.version}-${leased.build.buildId}.zip`;
      artifactStore.put(artifactRef, result.buffer);
      portal.completeBuild(workerId, leased.job.id, {
        build_id: leased.build.buildId,
        artifact_ref: artifactRef,
        artifact_sha256: result.sha256,
        install_key: leased.build.installKey,
        package_proof: leased.build.packageSecret,
      });
    } catch (error) {
      if (leased?.job?.id) {
        try {
          portal.failBuild(workerId, leased.job.id, {
            code: error.code ?? 'BUILD_FAILED',
            message: error.message ?? '构建失败',
          });
        } catch {
          // The portal already revoked a failed lease or build.
        }
      }
      console.error('[embedded-worker]', error);
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  }

  timer = setTimeout(tick, 200);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
