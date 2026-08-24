import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Building2, KeyRound, Save, Settings2 } from 'lucide-react';
import { api } from '../api/client';
import type { TenantSettings } from '../api/types';
import { useToast } from '../components/Toast';
import { SkeletonRows } from '../components/Ui';

export function SettingsPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const query = useQuery({
    queryKey: ['tenant-settings'],
    queryFn: () => api<TenantSettings>('/admin/v1/settings/tenant'),
  });
  const save = useMutation({
    mutationFn: (body: unknown) => api<TenantSettings>('/admin/v1/settings/tenant', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
    onSuccess: (data) => {
      queryClient.setQueryData(['tenant-settings'], data);
      toast('工作区设置已保存');
    },
    onError: (error: Error) => toast(error.message, 'error'),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    save.mutate({
      console_name: form.get('console_name'),
      support_email: form.get('support_email'),
      default_license_days: Number(form.get('default_license_days')),
      default_max_devices: Number(form.get('default_max_devices')),
      expiry_warning_days: Number(form.get('expiry_warning_days')),
    });
  }

  if (query.isLoading) return <section className="panel"><SkeletonRows /></section>;
  if (!query.data) return <section className="panel error-text">工作区设置读取失败：{query.error?.message}</section>;

  const settings = query.data;
  return <div className="settings-page">
    <section className="foundation-hero">
      <div>
        <span className="eyebrow"><Settings2 />工作区设置</span>
        <h2>统一管理后台和授权默认值</h2>
        <p>配置直接写入 PostgreSQL system_settings，不是浏览器本地演示数据。</p>
      </div>
    </section>

    <form className="settings-stack" onSubmit={submit}>
      <section className="panel settings-card">
        <header><Building2 /><div><h3>后台基本信息</h3><p>定义当前工作区在管理场景中使用的名称与支持邮箱。</p></div></header>
        <div className="form-grid">
          <label>后台名称<input name="console_name" required defaultValue={settings.console_name} /></label>
          <label>支持邮箱<input name="support_email" type="email" defaultValue={settings.support_email} /></label>
        </div>
      </section>

      <section className="panel settings-card">
        <header><KeyRound /><div><h3>Key 默认参数</h3><p>保存统一的授权配置基线，不会追溯修改现有策略或已生成 Key。</p></div></header>
        <div className="form-grid">
          <label>默认有效期（天）<input name="default_license_days" type="number" min={1} max={36500} defaultValue={settings.default_license_days} /></label>
          <label>默认设备上限<input name="default_max_devices" type="number" min={1} max={1000} defaultValue={settings.default_max_devices} /></label>
          <label>到期预警天数<input name="expiry_warning_days" type="number" min={1} max={365} defaultValue={settings.expiry_warning_days} /></label>
        </div>
      </section>

      <section className="panel settings-card notice-card">
        <header><BellRing /><div><h3>配置边界</h3><p>此处保存的是新业务使用的默认基线；具体 Key 仍以所选授权策略及生成时提交的覆盖参数为准。</p></div></header>
      </section>

      <div className="sticky-save">
        <span>{settings.updated_at ? '最后保存：' + new Date(settings.updated_at).toLocaleString('zh-CN') : '尚未保存过自定义设置'}</span>
        <button className="primary" disabled={save.isPending}><Save />{save.isPending ? '保存中...' : '保存全部设置'}</button>
      </div>
    </form>
  </div>;
}
