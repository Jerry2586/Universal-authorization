import { AppError } from '../../shared/errors/app-error.js';

export interface SelfUnbindPolicyInput {
  allowSelfUnbind: boolean;
  activatedAt: Date;
  cooldownSeconds: number;
  now: Date;
}

export function assertSelfUnbindPolicy(input: SelfUnbindPolicyInput): void {
  if (!input.allowSelfUnbind) {
    throw new AppError({ code: 'SELF_UNBIND_NOT_ALLOWED', message: '当前 Key 不允许用户自助解绑设备', statusCode: 403 });
  }
  const availableAt = new Date(input.activatedAt.getTime() + input.cooldownSeconds * 1_000);
  if (input.now < availableAt) {
    throw new AppError({
      code: 'UNBIND_COOLDOWN_ACTIVE',
      message: '设备自助解绑仍在冷却期内',
      statusCode: 409,
      retryable: true,
      details: {
        available_at: availableAt.toISOString(),
        remaining_seconds: Math.ceil((availableAt.getTime() - input.now.getTime()) / 1_000),
      },
    });
  }
}
