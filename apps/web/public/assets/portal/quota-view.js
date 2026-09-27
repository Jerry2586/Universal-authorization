/** Display-only quota projection. The server remains the final build authorization boundary. */
export function buildQuotaView(license = {}) {
  const count = value => Number.isInteger(value) && value >= 0 ? value : null;
  const dailyLimit = count(license.max_builds_per_day);
  const dailyUsed = count(license.builds_used_last_24_hours);
  const totalLimit = count(license.max_builds_total);
  const totalUsed = count(license.total_builds_used ?? license.build_count);
  const unlimited = license.max_builds_total === null;
  const dailyRemaining = dailyLimit !== null && dailyUsed !== null ? Math.max(0, dailyLimit - dailyUsed) : null;
  const totalRemaining = totalLimit !== null && totalUsed !== null ? Math.max(0, totalLimit - totalUsed) : null;
  const available = dailyRemaining === 0 || totalRemaining === 0 ? 0
    : dailyRemaining === null || (!unlimited && totalRemaining === null) ? null
    : unlimited ? dailyRemaining : Math.min(dailyRemaining, totalRemaining);
  const reason = totalRemaining === 0 ? '总额度已用完，请联系管理员调整'
    : dailyRemaining === 0 ? '24 小时额度已用完，随历史用量滚动恢复'
    : available === null ? '额度信息待核验'
    : '同时受总额度和过去 24 小时上限约束';
  return { dailyLimit, dailyUsed, dailyRemaining, totalLimit, totalUsed, totalRemaining, unlimited, available, reason };
}
