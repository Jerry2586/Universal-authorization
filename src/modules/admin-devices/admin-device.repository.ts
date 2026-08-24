export type DeviceStatus = 'ACTIVE' | 'BLOCKED' | 'DISABLED';
export type ActivationStatus = 'ACTIVE' | 'UNBOUND' | 'BLOCKED' | 'REPLACED';

export interface ManagedDeviceBinding {
  deviceId: string;
  tenantId: string;
  licenseId: string;
  activationId: string;
  deviceStatus: DeviceStatus;
  activationStatus: ActivationStatus;
  platform: string;
  osVersion: string | null;
  displayName: string | null;
  devicePublicKeyFingerprint: string;
  fingerprintHash: string;
  riskScore: number;
  firstSeenAt: Date;
  lastSeenAt: Date | null;
  activatedAt: Date;
  lastVerifiedAt: Date | null;
  unboundAt: Date | null;
  activeSessionCount: number;
  blocked: boolean;
  blockReason: string | null;
  blockedAt: Date | null;
}

export interface DeviceBindingListInput {
  tenantId: string;
  licenseId: string;
  activationStatus?: ActivationStatus;
  limit: number;
  offset: number;
}

export interface AdminDeviceActionInput {
  tenantId: string;
  deviceId: string;
  adminUserId: string;
  reason: string;
  now: Date;
  requestId: string;
  ipAddress: string | null;
}

export interface ForceUnbindDeviceInput extends AdminDeviceActionInput {
  licenseId: string;
}

export interface DeviceActionSnapshot {
  deviceId: string;
  deviceStatus: DeviceStatus;
  activationStatuses: readonly {
    activationId: string;
    licenseId: string;
    status: ActivationStatus;
  }[];
}

export interface ForceUnbindDeviceResult {
  deviceId: string;
  licenseId: string;
  activationId: string;
  previousActivationStatus: ActivationStatus;
  activationStatus: 'UNBOUND';
  unboundAt: Date;
  revokedSessionIds: readonly string[];
  changed: boolean;
  before: DeviceActionSnapshot;
  after: DeviceActionSnapshot;
}

export interface BlockDeviceResult {
  deviceId: string;
  deviceStatus: 'BLOCKED';
  blockId: string;
  blockedAt: Date;
  blockedActivationCount: number;
  revokedSessionIds: readonly string[];
  changed: boolean;
  before: DeviceActionSnapshot;
  after: DeviceActionSnapshot;
}

export interface UnblockDeviceResult {
  deviceId: string;
  deviceStatus: DeviceStatus;
  releasedBlockCount: number;
  releasedAt: Date;
  changed: boolean;
  before: DeviceActionSnapshot;
  after: DeviceActionSnapshot;
}

export interface AdminDeviceRepository {
  listLicenseDevices(input: DeviceBindingListInput): Promise<readonly ManagedDeviceBinding[]>;
  forceUnbind(input: ForceUnbindDeviceInput): Promise<ForceUnbindDeviceResult>;
  block(input: AdminDeviceActionInput): Promise<BlockDeviceResult>;
  unblock(input: AdminDeviceActionInput): Promise<UnblockDeviceResult>;
}
