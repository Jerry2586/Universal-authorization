import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDeliveryView } from '../apps/license-api/src/modules/packaging/delivery-view.js';

test('包级交付投影区分未激活、安装解锁、在线激活、被替代和撤销，不再重复提供已使用Key下载', () => {
  const now='2026-09-26T00:00:00Z';
  const job={build_id:'one',status:'succeeded'};
  let record={build_status:'ready',license_status:'active',install_key_status:'available'};
  const repository={buildDeliveryById:id=>{assert.equal(id,'one');return record;}};
  let state=buildDeliveryView(repository,job,now);
  assert.equal(state.activation_state,'not_installed');assert.equal(state.can_download,true);
  record={...record,build_status:'unlocked',install_key_status:'consumed',consumed_at:now};
  state=buildDeliveryView(repository,job,now);assert.equal(state.activation_state,'unlocked');assert.equal(state.can_download,false);
  record={...record,build_status:'activated',activation_status:'active',activation_generation:2,license_generation:2};
  state=buildDeliveryView(repository,job,now);assert.equal(state.activation_state,'active');assert.equal(state.can_download,false);
  record.activation_status='superseded';assert.equal(buildDeliveryView(repository,job,now).activation_state,'superseded');
  record.activation_status='active';record.license_generation=3;assert.equal(buildDeliveryView(repository,job,now).activation_state,'revoked');
  record.license_status='suspended';assert.equal(buildDeliveryView(repository,job,now).activation_state,'revoked');
});
