import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  Check,
  Clipboard,
  Download,
  Eye,
  KeyRound,
  Laptop,
  PauseCircle,
  PlayCircle,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Smartphone,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import { api, queryString } from '../api/client';
import type { DeviceBinding, License, Page, Policy, Product } from '../api/types';
import { Drawer, Empty, Modal, SkeletonRows } from '../components/Ui';
import { useToast } from '../components/Toast';

const stateName: Record<string, string> = {
  CREATED: '未激活',
  ACTIVE: '生效中',
  SUSPENDED: '已暂停',
  EXPIRED: '已过期',
  REVOKED: '已吊销',
  DISABLED: '已禁用',
};

type Delivery = {
  generation_batch_id: string;
  plain_key?: string;
  count?: number;
  items?: Array<{ plain_key: string; license: License }>;
  license?: License;
};

type ManagedAction = {
  path: string;
  body?: unknown;
  successMessage: string;
};

type ConfirmAction =
  | { kind: 'revoke' }
  | { kind: 'unbind' | 'block' | 'unblock'; deviceId: string; deviceName: string };

export function KeysPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [productId, setProductId] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<Delivery | null>(null);

  const products = useQuery({
    queryKey: ['products'],
    queryFn: () => api<Page<Product>>('/admin/v1/products?limit=100&offset=0'),
  });
  const policies = useQuery({
    queryKey: ['policies'],
    queryFn: () => api<Page<Policy>>('/admin/v1/license-policies?limit=100&offset=0'),
  });
  const keys = useQuery({
    queryKey: ['keys', status, productId],
    queryFn: () =>
      api<Page<License>>(
        `/admin/v1/license-keys${queryString({
          limit: 100,
          offset: 0,
          status: status || undefined,
          product_id: productId || undefined,
        })}`,
      ),
  });

  const visible = useMemo(
    () =>
      keys.data?.items.filter((key) =>
        key.display_key.toLowerCase().includes(search.toLowerCase()),
      ) ?? [],
    [keys.data, search],
  );

  const generate = useMutation({
    mutationFn: ({ body, batch }: { body: unknown; batch: boolean }) =>
      api<Delivery>(batch ? '/admin/v1/license-keys/batch' : '/admin/v1/license-keys', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      setDelivery(data);
      void qc.invalidateQueries({ queryKey: ['keys'] });
      toast('Key 已成功生成，请立即保存明文');
    },
    onError: (error: Error) => toast(error.message, 'error'),
  });

  return (
    <div className="page-stack">
      <div className="toolbar wrap">
        <div className="search">
          <Search />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索 Key 前缀或后缀"
          />
        </div>
        <select value={productId} onChange={(event) => setProductId(event.target.value)}>
          <option value="">全部产品</option>
          {products.data?.items.map((product) => (
            <option key={product.id} value={product.id}>
              {product.name}
            </option>
          ))}
        </select>
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">全部状态</option>
          {Object.entries(stateName).map(([value, name]) => (
            <option key={value} value={value}>
              {name}
            </option>
          ))}
        </select>
        <button
          className="primary"
          onClick={() => {
            setDelivery(null);
            setCreateOpen(true);
          }}
        >
          <Plus />生成 Key
        </button>
      </div>

      <section className="panel table-panel">
        {keys.isLoading ? (
          <SkeletonRows />
        ) : visible.length === 0 ? (
          <Empty
            icon={<KeyRound />}
            title="没有匹配的 Key"
            text="调整筛选条件，或生成一枚新的授权 Key。"
          />
        ) : (
          <div className="data-table">
            <div className="tr head">
              <span>Key</span>
              <span>状态</span>
              <span>授权类型</span>
              <span>设备 / 并发</span>
              <span>到期时间</span>
              <span />
            </div>
            {visible.map((key) => (
              <button className="tr" key={key.id} onClick={() => setSelectedId(key.id)}>
                <span>
                  <code>{key.display_key}</code>
                  <small>{key.id.slice(0, 8)}</small>
                </span>
                <span>
                  <i className={`status-dot ${key.status.toLowerCase()}`} />
                  <b className={`badge ${key.status.toLowerCase()}`}>
                    {stateName[key.status] ?? key.status}
                  </b>
                </span>
                <span>{key.license_type}</span>
                <span>
                  {key.max_devices} / {key.max_concurrent_sessions}
                </span>
                <span>
                  {key.expires_at
                    ? new Date(key.expires_at).toLocaleDateString('zh-CN')
                    : '永久'}
                </span>
                <span>
                  <Eye />
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      <GenerateModal
        open={createOpen}
        close={() => setCreateOpen(false)}
        products={products.data?.items ?? []}
        policies={policies.data?.items ?? []}
        submit={(body, batch) => generate.mutate({ body, batch })}
        busy={generate.isPending}
        delivery={delivery}
      />
      <KeyDrawer id={selectedId} close={() => setSelectedId(null)} />
    </div>
  );
}

function GenerateModal({
  open,
  close,
  products,
  policies,
  submit,
  busy,
  delivery,
}: {
  open: boolean;
  close(): void;
  products: Product[];
  policies: Policy[];
  submit(body: unknown, batch: boolean): void;
  busy: boolean;
  delivery: Delivery | null;
}) {
  const [batch, setBatch] = useState(false);
  const [product, setProduct] = useState('');
  const toast = useToast();
  const matching = policies.filter(
    (policy) =>
      policy.status === 'ACTIVE' &&
      (policy.product_id === null || policy.product_id === product),
  );

  function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    submit(
      {
        product_id: form.get('product_id'),
        policy_id: form.get('policy_id'),
        ...(batch ? { count: Number(form.get('count')) } : {}),
        metadata: { note: String(form.get('note') || '') },
        features: [],
      },
      batch,
    );
  }

  const plainKeys = delivery
    ? delivery.plain_key
      ? [delivery.plain_key]
      : (delivery.items?.map((item) => item.plain_key) ?? [])
    : [];

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(plainKeys.join('\n'));
      toast('明文 Key 已复制到剪贴板');
    } catch {
      toast('浏览器未允许读取剪贴板，请使用下载功能保存', 'error');
    }
  }

  function download() {
    const blob = new Blob([`${plainKeys.join('\n')}\n`], { type: 'text/plain;charset=utf-8' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `license-keys-${delivery?.generation_batch_id ?? Date.now()}.txt`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={delivery ? '保存明文 Key' : '生成授权 Key'}
      subtitle={
        delivery
          ? '明文只在本次生成响应中出现，关闭后无法再次读取。'
          : '选择产品和策略，服务端将安全生成随机 Key。'
      }
      wide
    >
      {delivery ? (
        <div className="delivery">
          <div className="delivery-warning">
            <ShieldAlert />
            <span>
              <strong>请立即安全保存</strong>
              <small>后台数据库只保存哈希，无法找回这些明文 Key。</small>
            </span>
          </div>
          <div className="key-box">
            {plainKeys.map((key, index) => (
              <code key={index}>{key}</code>
            ))}
          </div>
          <div className="form-actions">
            <button className="secondary" onClick={() => void copyAll()}>
              <Clipboard />复制全部
            </button>
            <button className="primary" onClick={download}>
              <Download />下载 TXT
            </button>
          </div>
        </div>
      ) : (
        <form className="form-grid" onSubmit={submitForm}>
          <label>
            生成方式
            <select
              value={batch ? 'batch' : 'single'}
              onChange={(event) => setBatch(event.target.value === 'batch')}
            >
              <option value="single">单枚 Key</option>
              <option value="batch">批量生成</option>
            </select>
          </label>
          {batch && (
            <label>
              生成数量
              <input name="count" type="number" min="1" max="500" defaultValue="10" required />
            </label>
          )}
          <label>
            产品
            <select
              name="product_id"
              value={product}
              onChange={(event) => setProduct(event.target.value)}
              required
            >
              <option value="">请选择产品</option>
              {products
                .filter((item) => item.status === 'ACTIVE')
                .map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            授权策略
            <select name="policy_id" required>
              <option value="">请选择策略</option>
              {matching.map((policy) => (
                <option value={policy.id} key={policy.id}>
                  {policy.name} · {policy.license_type}
                </option>
              ))}
            </select>
          </label>
          <label className="full">
            交付备注
            <input name="note" placeholder="例如：客户名称 / 订单号（可选）" />
          </label>
          <div className="form-actions full">
            <button className="ghost" type="button" onClick={close}>
              取消
            </button>
            <button className="primary" disabled={busy || !product}>
              {busy ? '正在安全生成...' : batch ? '批量生成' : '生成 Key'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function KeyDrawer({ id, close }: { id: string | null; close(): void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  const detail = useQuery({
    queryKey: ['license', id],
    queryFn: () => api<License>(`/admin/v1/license-keys/${id}`),
    enabled: Boolean(id),
  });
  const devices = useQuery({
    queryKey: ['devices', id],
    queryFn: () =>
      api<Page<DeviceBinding>>(`/admin/v1/license-keys/${id}/devices?limit=100&offset=0`),
    enabled: Boolean(id),
  });
  const action = useMutation({
    mutationFn: ({ path, body }: ManagedAction) =>
      api(`/admin/v1/${path}`, {
        method: 'POST',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({ queryKey: ['license', id] });
      void qc.invalidateQueries({ queryKey: ['keys'] });
      void qc.invalidateQueries({ queryKey: ['devices', id] });
      setConfirmAction(null);
      toast(variables.successMessage);
    },
    onError: (error: Error) => toast(error.message, 'error'),
  });

  const key = detail.data;
  if (!id) return null;

  function submitConfirmedAction(reason: string) {
    if (!confirmAction) return;
    if (confirmAction.kind === 'revoke') {
      action.mutate({
        path: `license-keys/${id}/revoke`,
        body: { reason },
        successMessage: 'Key 已永久吊销',
      });
      return;
    }

    action.mutate({
      path: `devices/${confirmAction.deviceId}/${confirmAction.kind}`,
      body: {
        reason,
        ...(confirmAction.kind === 'unbind' ? { license_id: id } : {}),
      },
      successMessage:
        confirmAction.kind === 'unbind'
          ? '设备已强制解绑'
          : confirmAction.kind === 'block'
            ? '设备已封禁'
            : '设备已解封',
    });
  }

  async function copyDisplayKey() {
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key.display_key);
      toast('Key 标识已复制');
    } catch {
      toast('浏览器未允许访问剪贴板', 'error');
    }
  }

  return (
    <>
      <Drawer
        open
        title={key?.display_key ?? '加载 Key 详情'}
        subtitle={key ? `${stateName[key.status] ?? key.status} · ${key.license_type}` : '正在读取安全数据'}
        onClose={close}
      >
        {!key ? (
          <SkeletonRows />
        ) : (
          <>
            <div className="key-identity">
              <code>{key.display_key}</code>
              <button aria-label="复制 Key 标识" title="复制 Key 标识" onClick={() => void copyDisplayKey()}>
                <Clipboard />
              </button>
              <span className={`badge ${key.status.toLowerCase()}`}>
                {stateName[key.status] ?? key.status}
              </span>
            </div>

            <div className="detail-grid">
              <div>
                <small>最大设备</small>
                <strong>{key.max_devices}</strong>
              </div>
              <div>
                <small>最大并发</small>
                <strong>{key.max_concurrent_sessions}</strong>
              </div>
              <div>
                <small>激活时间</small>
                <strong>
                  {key.activated_at
                    ? new Date(key.activated_at).toLocaleDateString('zh-CN')
                    : '未激活'}
                </strong>
              </div>
              <div>
                <small>到期时间</small>
                <strong>
                  {key.expires_at
                    ? new Date(key.expires_at).toLocaleDateString('zh-CN')
                    : '永久'}
                </strong>
              </div>
            </div>

            <section className="action-zone">
              <h3>Key 操作</h3>
              <div>
                {key.status === 'SUSPENDED' ? (
                  <button
                    className="secondary"
                    disabled={action.isPending}
                    onClick={() =>
                      action.mutate({
                        path: `license-keys/${id}/resume`,
                        successMessage: 'Key 已恢复使用',
                      })
                    }
                  >
                    <PlayCircle />恢复
                  </button>
                ) : (
                  <button
                    className="secondary"
                    disabled={action.isPending || ['REVOKED', 'EXPIRED'].includes(key.status)}
                    onClick={() =>
                      action.mutate({
                        path: `license-keys/${id}/suspend`,
                        successMessage: 'Key 已暂停使用',
                      })
                    }
                  >
                    <PauseCircle />暂停
                  </button>
                )}
                <button
                  className="secondary"
                  disabled={action.isPending || key.status === 'REVOKED'}
                  onClick={() =>
                    action.mutate({
                      path: `license-keys/${id}/renew`,
                      body: { extend_seconds: 30 * 86400 },
                      successMessage: 'Key 已续期 30 天',
                    })
                  }
                >
                  <RefreshCw />续期 30 天
                </button>
                <button
                  className="danger"
                  disabled={action.isPending || key.status === 'REVOKED'}
                  onClick={() => setConfirmAction({ kind: 'revoke' })}
                >
                  <Ban />永久吊销
                </button>
              </div>
            </section>

            <section className="device-zone">
              <div className="section-title">
                <div>
                  <h3>绑定设备</h3>
                  <p>{devices.data?.items.length ?? 0} 条设备记录</p>
                </div>
                <Smartphone />
              </div>
              {devices.isLoading ? (
                <SkeletonRows />
              ) : devices.data?.items.length === 0 ? (
                <div className="compact-empty">当前 Key 尚未绑定设备。</div>
              ) : (
                <div className="device-list">
                  {devices.data?.items.map((device, index) => {
                    const deviceId = String(device.device_id ?? device.id ?? '');
                    const deviceName = String(device.display_name ?? device.device_name ?? '未命名设备');
                    const blocked = Boolean(device.blocked);
                    return (
                      <div key={deviceId || index}>
                        <span className="device-icon">
                          {String(device.platform ?? '')
                            .toLowerCase()
                            .includes('win') ? (
                            <Laptop />
                          ) : (
                            <Smartphone />
                          )}
                        </span>
                        <div>
                          <strong>{deviceName}</strong>
                          <small>
                            {String(device.platform ?? '未知平台')} ·{' '}
                            {String(device.activation_status ?? device.status ?? 'UNKNOWN')}
                          </small>
                        </div>
                        <span className={`badge ${blocked ? 'revoked' : 'active'}`}>
                          {blocked ? '已封禁' : '正常'}
                        </span>
                        <div className="device-actions">
                          <button
                            aria-label={`解绑 ${deviceName}`}
                            title="强制解绑"
                            disabled={action.isPending || !deviceId}
                            onClick={() =>
                              setConfirmAction({ kind: 'unbind', deviceId, deviceName })
                            }
                          >
                            <XCircle />
                          </button>
                          <button
                            aria-label={`${blocked ? '解封' : '封禁'} ${deviceName}`}
                            title={blocked ? '解封设备' : '封禁设备'}
                            disabled={action.isPending || !deviceId}
                            onClick={() =>
                              setConfirmAction({
                                kind: blocked ? 'unblock' : 'block',
                                deviceId,
                                deviceName,
                              })
                            }
                          >
                            {blocked ? <Check /> : <ShieldAlert />}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        )}
      </Drawer>

      <OperationModal
        key={confirmAction ? `${confirmAction.kind}:${'deviceId' in confirmAction ? confirmAction.deviceId : id}` : 'closed'}
        action={confirmAction}
        keyLabel={key?.display_key ?? ''}
        busy={action.isPending}
        close={() => setConfirmAction(null)}
        submit={submitConfirmedAction}
      />
    </>
  );
}

function OperationModal({
  action,
  keyLabel,
  busy,
  close,
  submit,
}: {
  action: ConfirmAction | null;
  keyLabel: string;
  busy: boolean;
  close(): void;
  submit(reason: string): void;
}) {
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');

  if (!action) return null;

  const config =
    action.kind === 'revoke'
      ? {
          title: '永久吊销授权 Key',
          subtitle: '这是不可恢复的高风险操作，请确认影响范围。',
          subject: keyLabel,
          description: '吊销后该 Key 将无法激活、验证或恢复，现有授权会话也将失效。',
          label: '吊销原因',
          placeholder: '例如：Key 泄露、订单退款、违规使用',
          confirmText: '永久吊销',
          buttonText: '确认永久吊销',
          dangerous: true,
        }
      : action.kind === 'unbind'
        ? {
            title: '强制解绑设备',
            subtitle: '释放当前设备占用的授权名额。',
            subject: action.deviceName,
            description: '设备上的当前绑定会被释放，用户下次使用时需要重新激活。',
            label: '解绑原因',
            placeholder: '例如：用户申请换机、设备已报废',
            confirmText: '',
            buttonText: '确认解绑',
            dangerous: false,
          }
        : action.kind === 'block'
          ? {
              title: '封禁设备',
              subtitle: '阻止该设备继续使用授权服务。',
              subject: action.deviceName,
              description: '设备将被加入封禁记录，并拒绝后续激活和验证请求。',
              label: '封禁原因',
              placeholder: '例如：设备被盗、检测到异常使用',
              confirmText: '',
              buttonText: '确认封禁',
              dangerous: true,
            }
          : {
              title: '解封设备',
              subtitle: '恢复该设备访问授权服务的资格。',
              subject: action.deviceName,
              description: '解封后设备可以再次发起激活或验证请求，请确保已经完成人工核验。',
              label: '解封原因',
              placeholder: '例如：人工核验通过、风险已解除',
              confirmText: '',
              buttonText: '确认解封',
              dangerous: false,
            };

  const trimmedReason = reason.trim();
  const canSubmit =
    trimmedReason.length > 0 &&
    trimmedReason.length <= 255 &&
    (!config.confirmText || confirmation === config.confirmText) &&
    !busy;

  function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canSubmit) submit(trimmedReason);
  }

  return (
    <Modal open title={config.title} subtitle={config.subtitle} onClose={busy ? () => undefined : close}>
      <form className="operation-form" onSubmit={submitForm}>
        <div className={`operation-impact ${config.dangerous ? 'critical' : ''}`}>
          <span>
            <TriangleAlert />
          </span>
          <div>
            <small>操作对象</small>
            <strong>{config.subject}</strong>
            <p>{config.description}</p>
          </div>
        </div>

        <label>
          <span>
            {config.label}<small>{trimmedReason.length}/255</small>
          </span>
          <textarea
            autoFocus
            value={reason}
            maxLength={255}
            rows={4}
            placeholder={config.placeholder}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>

        {config.confirmText && (
          <label>
            <span>安全确认</span>
            <input
              value={confirmation}
              placeholder={`请输入“${config.confirmText}”`}
              autoComplete="off"
              onChange={(event) => setConfirmation(event.target.value)}
            />
            <small className="field-help">
              为防止误操作，请完整输入“{config.confirmText}”。
            </small>
          </label>
        )}

        <div className="form-actions operation-actions">
          <button className="ghost" type="button" disabled={busy} onClick={close}>
            取消
          </button>
          <button className={config.dangerous ? 'danger confirm-danger' : 'primary'} disabled={!canSubmit}>
            {busy ? <span className="spinner" /> : config.dangerous ? <ShieldAlert /> : <Check />}
            {busy ? '正在执行...' : config.buttonText}
          </button>
        </div>
      </form>
    </Modal>
  );
}
