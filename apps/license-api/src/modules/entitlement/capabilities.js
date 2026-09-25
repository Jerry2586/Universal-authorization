import { parseJsonObject } from '../shared/service-utils.js';

const LEGACY_CAPABILITIES = Object.freeze([
  'settings:read', 'settings:write', 'theme:enable',
  'xboard:connect', 'protected:read', 'updates:read',
]);

export function capabilitiesFor(record) {
  if (record.plan_capabilities_json == null && (!record.plan_code || record.plan_code === 'legacy')) return [...LEGACY_CAPABILITIES];
  const capabilities = parseJsonObject(record.plan_capabilities_json, []);
  return Array.isArray(capabilities) ? capabilities.filter(value => LEGACY_CAPABILITIES.includes(value)) : [];
}
