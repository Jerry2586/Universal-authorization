import { invariant } from '../../../../../packages/core/src/errors.js';

export async function handleActivationHttp({
  method, url, request, response, service, portal, readJson, respondJson, corsHeaders, rateLimit,
}) {
  const requireLicenseService = () => invariant(
    portal.serviceEnabled('license_service_enabled'),
    'LICENSE_SERVICE_MAINTENANCE', '授权服务正在维护', 503,
  );

  if (method === 'POST' && url.pathname === '/api/v1/installation-challenges') {
    requireLicenseService();
    rateLimit('installation-challenge', 60, 15 * 60 * 1000);
    const body = await readJson(request);
    respondJson(response, 201, service.createInstallationChallenge({
      purpose: body.purpose, publicKey: body.installation_public_key, context: body.context,
    }), corsHeaders);
    return true;
  }

  if (method === 'POST' && ['/api/v1/install-unlocks', '/api/v2/install-unlocks'].includes(url.pathname)) {
    requireLicenseService();
    rateLimit('install-unlock', 30, 15 * 60 * 1000);
    const body = await readJson(request);
    if (url.pathname.startsWith('/api/v2/')) invariant(body.install_window_id && body.install_window_token,
      'INSTALL_WINDOW_REQUIRED', '请先点击开始激活并取得 60 分钟安装激活窗口', 401);
    const result = service.unlockInstall({
      installKey: body.install_key, buildId: body.build_id, packageProof: body.package_proof, domain: body.domain,
      backendUrl: body.backend_url, installationId: body.installation_id,
      installationPublicKey: body.installation_public_key,
      challengeId: body.challenge_id, challengeSignature: body.challenge_signature,
      installWindowId: body.install_window_id, installWindowToken: body.install_window_token,
    });
    respondJson(response, 201, {
      install_receipt_id: result.receiptId, install_receipt_secret: result.receiptSecret, unlocked_at: result.unlockedAt,
    }, corsHeaders);
    return true;
  }

  if (method === 'POST' && url.pathname === '/api/v1/install-windows/start') {
    requireLicenseService();
    rateLimit('install-window-start', 30, 15 * 60 * 1000);
    const body = await readJson(request);
    const result = service.startInstallWindow({
      buildId: body.build_id, packageProof: body.package_proof, domain: body.domain,
      installationId: body.installation_id, windowToken: body.install_window_token,
    });
    respondJson(response, 201, {
      install_window_id: result.windowId, started_at: result.startedAt,
      expires_at: result.expiresAt, status: result.status,
      cleanup_required: result.cleanupRequired,
    }, corsHeaders);
    return true;
  }

  if (method === 'POST' && url.pathname === '/api/v1/install-windows/expire') {
    requireLicenseService();
    rateLimit('install-window-expire', 60, 15 * 60 * 1000);
    const body = await readJson(request);
    const result = service.expireInstallWindow({
      windowId: body.install_window_id, windowToken: body.install_window_token,
    });
    respondJson(response, 200, {
      status: result.status, expires_at: result.expiresAt,
      cleanup_required: result.cleanupRequired, cleanup_action: result.cleanupAction,
    }, corsHeaders);
    return true;
  }

  if (method === 'POST' && url.pathname === '/api/v1/activations') {
    requireLicenseService();
    rateLimit('activate', 30, 15 * 60 * 1000);
    const body = await readJson(request);
    const result = service.activate({
      licenseKey: body.license_key, installReceiptId: body.install_receipt_id,
      installReceiptSecret: body.install_receipt_secret, buildId: body.build_id,
      packageProof: body.package_proof, domain: body.domain,
      backendUrl: body.backend_url, installationId: body.installation_id,
      installationPublicKey: body.installation_public_key,
      challengeId: body.challenge_id, challengeSignature: body.challenge_signature,
    });
    respondJson(response, 201, {
      activation_id: result.activationId, activation_token: result.token,
      refresh_secret: result.refreshSecret, expires_at: result.expiresAt,
    }, corsHeaders);
    return true;
  }

  if (method === 'POST' && url.pathname === '/api/v1/activations/refresh') {
    requireLicenseService();
    rateLimit('refresh', 120, 15 * 60 * 1000);
    const body = await readJson(request);
    const result = service.refresh({
      activationId: body.activation_id, refreshSecret: body.refresh_secret,
      domain: body.domain, installationId: body.installation_id, backendUrl: body.backend_url,
      installationPublicKey: body.installation_public_key,
      challengeId: body.challenge_id, challengeSignature: body.challenge_signature,
    });
    respondJson(response, 200, { activation_token: result.token, expires_at: result.expiresAt }, corsHeaders);
    return true;
  }

  if (method === 'POST' && url.pathname === '/api/v1/activations/recover') {
    requireLicenseService();
    rateLimit('activation-recover', 20, 15 * 60 * 1000);
    const body = await readJson(request);
    const result = service.recoverActivation({
      licenseKey: body.license_key, buildId: body.build_id, packageProof: body.package_proof,
      domain: body.domain, backendUrl: body.backend_url, installationId: body.installation_id,
      installationPublicKey: body.installation_public_key,
      challengeId: body.challenge_id, challengeSignature: body.challenge_signature,
    });
    respondJson(response, 200, {
      activation_id: result.activationId, activation_token: result.token,
      refresh_secret: result.refreshSecret, expires_at: result.expiresAt,
      recovery_generation: result.recoveryGeneration,
    }, corsHeaders);
    return true;
  }

  if (method === 'POST' && url.pathname === '/api/v1/offline-licenses') {
    requireLicenseService();
    rateLimit('offline-license', 20, 15 * 60 * 1000);
    const body = await readJson(request);
    const result = service.issueOfflineLicenseFile({
      activationId: body.activation_id, refreshSecret: body.refresh_secret,
      installationId: body.installation_id, installationPublicKey: body.installation_public_key,
      challengeId: body.challenge_id, challengeSignature: body.challenge_signature,
    });
    respondJson(response, 201, {
      format: result.format, file_id: result.fileId, activation_id: result.activationId,
      activation_token: result.activationToken, issued_at: result.issuedAt, expires_at: result.expiresAt,
    }, corsHeaders);
    return true;
  }

  if (method === 'POST' && url.pathname === '/api/v1/product-migrations') {
    requireLicenseService();
    rateLimit('product-migration', 20, 15 * 60 * 1000);
    const body = await readJson(request);
    const result = service.issueProductMigrationGrant({
      activationId: body.activation_id, refreshSecret: body.refresh_secret,
      targetInstallationPublicKey: body.target_installation_public_key,
      installationPublicKey: body.installation_public_key,
      challengeId: body.challenge_id, challengeSignature: body.challenge_signature,
    });
    respondJson(response, 201, {
      migration_grant_id: result.grantId, migration_grant: result.grantToken,
      target_installation_id: result.targetInstallationId,
      expires_at: result.expiresAt, rollback_until: result.rollbackUntil,
    }, corsHeaders);
    return true;
  }

  if (method === 'POST' && url.pathname === '/api/v1/product-migrations/accept') {
    requireLicenseService();
    rateLimit('product-migration-accept', 20, 15 * 60 * 1000);
    const body = await readJson(request);
    const result = service.acceptProductMigration({
      grantToken: body.migration_grant, buildId: body.build_id,
      packageProof: body.package_proof, domain: body.domain, backendUrl: body.backend_url,
      installationId: body.installation_id, installationPublicKey: body.installation_public_key,
      challengeId: body.challenge_id, challengeSignature: body.challenge_signature,
    });
    respondJson(response, 201, {
      activation_id: result.activationId, activation_token: result.token,
      refresh_secret: result.refreshSecret, expires_at: result.expiresAt,
      source_status: result.sourceStatus, target_status: result.targetStatus,
    }, corsHeaders);
    return true;
  }

  if (method === 'POST' && url.pathname === '/api/v1/product-migrations/prepare') {
    requireLicenseService();
    rateLimit('product-migration-prepare', 20, 15 * 60 * 1000);
    const body = await readJson(request);
    const result = service.prepareProductMigration({
      grantToken: body.migration_grant, buildId: body.build_id,
      packageProof: body.package_proof, domain: body.domain, backendUrl: body.backend_url,
      installationId: body.installation_id, installationPublicKey: body.installation_public_key,
      challengeId: body.challenge_id, challengeSignature: body.challenge_signature,
    });
    respondJson(response, 201, {
      migration_grant_id: result.grantId,
      candidate_activation_id: result.activationId,
      candidate_refresh_secret: result.refreshSecret,
      rollback_until: result.rollbackUntil,
      source_status: result.sourceStatus, target_status: result.targetStatus,
    }, corsHeaders);
    return true;
  }

  if (method === 'POST' && url.pathname === '/api/v1/product-migrations/commit') {
    requireLicenseService();
    rateLimit('product-migration-commit', 20, 15 * 60 * 1000);
    const body = await readJson(request);
    const result = service.commitProductMigration({
      grantToken: body.migration_grant,
      installationId: body.installation_id, installationPublicKey: body.installation_public_key,
      challengeId: body.challenge_id, challengeSignature: body.challenge_signature,
    });
    respondJson(response, 200, {
      activation_id: result.activationId, activation_token: result.token,
      expires_at: result.expiresAt, rollback_until: result.rollbackUntil,
      source_status: result.sourceStatus, target_status: result.targetStatus,
    }, corsHeaders);
    return true;
  }

  if (method === 'POST' && url.pathname === '/api/v1/product-migrations/rollback') {
    requireLicenseService();
    rateLimit('product-migration-rollback', 20, 15 * 60 * 1000);
    const body = await readJson(request);
    const result = service.rollbackProductMigration({
      grantToken: body.migration_grant, refreshSecret: body.refresh_secret, reason: body.reason,
      installationId: body.installation_id, installationPublicKey: body.installation_public_key,
      challengeId: body.challenge_id, challengeSignature: body.challenge_signature,
    });
    respondJson(response, 200, {
      rolled_back: result.rolledBack,
      activation_id: result.activationId, activation_token: result.token,
      expires_at: result.expiresAt,
      source_status: result.sourceStatus, target_status: result.targetStatus,
    }, corsHeaders);
    return true;
  }

  return false;
}
