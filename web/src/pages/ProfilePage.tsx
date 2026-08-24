import type { FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { KeyRound, Mail, ShieldCheck, UserRound } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { formatDate } from '../components/AdminForms';
import { useToast } from '../components/Toast';

export function ProfilePage() {
  const { admin, refresh, forget } = useAuth();
  const toast = useToast();
  const profile = useMutation({
    mutationFn: (displayName: string) => api('/admin/v1/profile', {
      method: 'PATCH',
      body: JSON.stringify({ display_name: displayName }),
    }),
    onSuccess: async () => {
      await refresh();
      toast('个人资料已更新');
    },
    onError: (error: Error) => toast(error.message, 'error'),
  });
  const password = useMutation({
    mutationFn: (body: unknown) => api('/admin/v1/profile/change-password', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    onSuccess: () => {
      toast('密码修改成功，请使用新密码重新登录');
      forget();
    },
    onError: (error: Error) => toast(error.message, 'error'),
  });

  function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    profile.mutate(String(new FormData(event.currentTarget).get('display_name')));
  }

  function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const nextPassword = String(form.get('new_password'));
    if (nextPassword !== String(form.get('confirm_password'))) {
      toast('两次输入的新密码不一致', 'error');
      return;
    }
    password.mutate({
      current_password: form.get('current_password'),
      new_password: nextPassword,
    });
  }

  return <div className="settings-layout">
    <section className="panel profile-summary">
      <div className="profile-orb">{admin?.display_name.slice(0, 1).toUpperCase()}</div>
      <h2>{admin?.display_name}</h2>
      <span>{admin?.email}</span>
      <div className="profile-meta">
        <div><UserRound /><span>角色</span><strong>{admin?.roles.map((role) => role.name).join(' · ') || '未分配'}</strong></div>
        <div><ShieldCheck /><span>状态</span><strong>{admin?.status === 'ACTIVE' ? '启用' : '不可用'}</strong></div>
        <div><Mail /><span>最近登录</span><strong>{formatDate(admin?.last_login_at)}</strong></div>
      </div>
    </section>

    <div className="settings-stack">
      <section className="panel settings-card">
        <header><UserRound /><div><h3>个人资料</h3><p>这里修改的名称会立即显示在后台顶部。</p></div></header>
        <form className="form-grid" onSubmit={saveProfile}>
          <label>登录邮箱<input value={admin?.email ?? ''} disabled /></label>
          <label>工作区<input value={admin?.tenant?.name ?? '平台管理'} disabled /></label>
          <label className="full">显示名称<input name="display_name" required minLength={2} defaultValue={admin?.display_name} /></label>
          <div className="form-actions full"><button className="primary" disabled={profile.isPending}>{profile.isPending ? '保存中...' : '保存个人资料'}</button></div>
        </form>
      </section>

      <section className="panel settings-card danger-card">
        <header><KeyRound /><div><h3>修改登录密码</h3><p>修改成功后当前会话立即退出，其他旧会话也会失效。</p></div></header>
        <form className="form-grid" onSubmit={changePassword}>
          <label className="full">当前密码<input name="current_password" type="password" required /></label>
          <label>新密码<input name="new_password" type="password" required minLength={12} /></label>
          <label>确认新密码<input name="confirm_password" type="password" required minLength={12} /></label>
          <small className="field-help full">至少 12 位，并包含大写字母、小写字母和数字。</small>
          <div className="form-actions full"><button className="danger" disabled={password.isPending}>{password.isPending ? '正在修改...' : '修改密码并退出'}</button></div>
        </form>
      </section>
    </div>
  </div>;
}
