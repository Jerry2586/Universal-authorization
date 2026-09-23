export const LICENSE_STATUS = Object.freeze({
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  REVOKED: 'revoked',
});

export const TICKET_STATUS = Object.freeze({
  CREATED: 'created',
  CLAIMED: 'claimed',
  CONSUMED: 'consumed',
  CANCELLED: 'cancelled',
});

export const BUILD_STATUS = Object.freeze({
  READY: 'ready',
  PACKAGE_UNLOCKED: 'package_unlocked',
  ACTIVATED: 'activated',
  REVOKED: 'revoked',
});

export const INSTALL_KEY_STATUS = Object.freeze({
  AVAILABLE: 'available',
  CONSUMED: 'consumed',
  REVOKED: 'revoked',
});

export const INSTALL_RECEIPT_STATUS = Object.freeze({
  UNLOCKED: 'unlocked',
  ACTIVATED: 'activated',
  REVOKED: 'revoked',
});

export const ACTIVATION_STATUS = Object.freeze({
  ACTIVE: 'active',
  SUPERSEDED: 'superseded',
  REVOKED: 'revoked',
});
