import { parseJsonObject } from '../shared/service-utils.js';

const LEGACY_CAPABILITIES = Object.freeze([
  'settings:read', 'settings:write', 'theme:enable',
  'xboard:connect', 'protected:read', 'updates:read',
]);

export function capabilitiesFor(record) {
  const capabilities = parseJsonObject(record.plan_capabilities_json, []);
  return Array.isArray(capabilities) && capabilities.length > 0 ? capabilities : [...LEGACY_CAPABILITIES];
}
