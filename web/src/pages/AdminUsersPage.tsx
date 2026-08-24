import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Edit3, KeyRound, Plus, Search, ShieldCheck, UserCog, Users } from 'lucide-react';
import { api, queryString } from '../api/client';
import type { AdminPermission, AdminRole, ManagedAdmin, Page } from '../api/types';
import { formatDate, Pagination } from '../components/AdminForms';
import { useToast } from '../components/Toast';
import { Empty, Modal, SkeletonRows } from '../components/Ui';
import { useAuth } from '../auth/AuthProvider';

const LIMIT = 20;
type AdminModalMode = 'create' | 'edit' | 'reset' | null;
type RoleModalMode = 'create' | 'edit' | null;

export function AdminUsersPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { admin: currentAdmin, has } = useAuth();
  const canUsers = has('admin.users.manage');
  const canRoles = has('admin.roles.manage');
  const [tab, setTab] = useState<'users' | 'roles'>(canUsers ? 'users' : 'roles');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [adminModal, setAdminModal] = useState<AdminModalMode>(null);
  const [selected, setSelected] = useState<ManagedAdmin>();
  const [roleModal, setRoleModal] = useState<RoleModalMode>(null);
  const [selectedRole, setSelectedRole] = useState<AdminRole>();

  const admins = useQuery({
    queryKey: ['admin-users', search, status, offset],
    queryFn: () => api<Page<ManagedAdmin>>(
      `/admin/v1/admin-users${queryString({ search, status: status || undefined, limit: LIMIT, offset })}`,
    ),
    enabled: canUsers,
  });
  const roles = useQuery({
    queryKey: ['admin-roles'],
    queryFn: () => api<{ items: AdminRole[] }>('/admin/v1/admin-roles'),
    enabled: canUsers || canRoles,
  });
  const permissions = useQuery({
    queryKey: ['admin-permissions'],
    queryFn: () => api<{ items: AdminPermission[] }>('/admin/v1/admin-permissions'),
    enabled: canRoles,
  });

  const saveAdmin = useMutation({
    mutationFn: ({ path, method, body }: { path: string; method: string; body: unknown }) =>
      api<ManagedAdmin>(path, { method, body: JSON.stringify(body) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setAdminModal(null);
      toast('管理员资料已保存');
    },
    onError: (error: Error) => toast(error.message, 'error'),
  });
  const resetPassword = useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) =>
      api(`/admin/v1/admin-users/${id}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ new_password: password }),
      }),
    onSuccess: () => {
      setAdminModal(null);
      toast('密码已重置，旧会话已失效');
    },
    onError: (error: Error) => toast(error.message, 'error'),
  });
  const saveRole = useMutation({
    mutationFn: ({ path, method, body }: { path: string; method: string; body: unknown }) =>
      api<AdminRole>(path, { method, body: JSON.stringify(body) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-roles'] });
      setRoleModal(null);
      toast('角色权限已保存');
    },
    onError: (error: Error) => toast(error.message, 'error'),
  });

  const roleItems = roles.data?.items ?? [];
  const permissionItems = permissions.data?.items ?? [];
  const adminTotal = admins.data?.total ?? admins.data?.items.length ?? 0;
  const roleEditingUnavailable = roles.isLoading || roles.isError || roleItems.length === 0;

  return <div className="admin-foundation-page">
    <section className="foundation-hero">
      <div>
        <span className="eyebrow"><ShieldCheck />访问控制中心</span>
        <h2>管理员与角色权限</h2>
        <p>所有账号、状态和权限调整均连接真实 API，并写入审计日志。</p>
      </div>
      {canUsers && <div className="hero-stat"><strong>{adminTotal}</strong><span>管理员总数</span></div>}
      <div className="hero-stat"><strong>{roleItems.length}</strong><span>工作区角色</span></div>
    </section>

    <div className="segmented">
      {canUsers && <button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}><Users />管理员账号</button>}
      {canRoles && <button className={tab === 'roles' ? 'active' : ''} onClick={() => setTab('roles')}><ShieldCheck />角色权限</button>}
    </div>

    {tab === 'users' && canUsers ? <>
      <section className="panel foundation-toolbar">
        <label><Search /><input value={search} onChange={(event) => { setSearch(event.target.value); setOffset(0); }} placeholder="搜索姓名或邮箱" /></label>
        <select value={status} onChange={(event) => { setStatus(event.target.value); setOffset(0); }} aria-label="管理员状态"><option value="">全部状态</option><option value="ACTIVE">启用</option><option value="SUSPENDED">暂停</option><option value="DISABLED">禁用</option></select>
        <button className="primary" disabled={roles.isLoading || roles.isError || roleItems.length === 0} onClick={() => { setSelected(undefined); setAdminModal('create'); }}><Plus />新增管理员</button>
      </section>
      {roles.isError && <section className="panel error-text">角色列表读取失败，暂时不能新增或调整管理员角色：{roles.error.message}</section>}
      {admins.isError ? <section className="panel error-text">管理员列表读取失败：{admins.error.message}</section> :
        <section className="panel account-list">
          {admins.isLoading ? <SkeletonRows /> : (admins.data?.items.length ?? 0) === 0 ?
            <Empty icon={<Users />} title="暂无管理员" text="没有符合条件的管理员账号。" /> :
            admins.data!.items.map((item) => {
              const isSelf = item.id === currentAdmin?.id;
              return <article key={item.id}>
                <div className="account-avatar">{item.display_name.slice(0, 1).toUpperCase()}</div>
                <div className="account-main">
                  <div><strong>{item.display_name}</strong>{isSelf && <span className="badge active">当前账号</span>}<span className={`badge ${item.status.toLowerCase()}`}>{statusText(item.status)}</span></div>
                  <span>{item.email}</span>
                  <small>{item.roles.map((role) => role.name).join(' · ') || '未分配角色'} · 最近登录 {formatDate(item.last_login_at)}</small>
                </div>
                <button
                  className="ghost compact"
                  disabled={!isSelf && roleEditingUnavailable}
                  title={!isSelf && roleEditingUnavailable ? '角色数据不可用，暂时不能修改该管理员' : undefined}
                  onClick={() => { setSelected(item); setAdminModal('edit'); }}
                ><Edit3 />管理</button>
                {!isSelf && <button className="ghost compact" onClick={() => { setSelected(item); setAdminModal('reset'); }}><KeyRound />重置密码</button>}
              </article>;
            })}
        </section>}
      <Pagination offset={offset} limit={LIMIT} itemCount={admins.data?.items.length ?? 0} total={admins.data?.total} onChange={setOffset} busy={admins.isFetching} />
    </> : <>
      {roles.isError ? <section className="panel error-text">角色列表读取失败：{roles.error.message}</section> : <>
        {canRoles && permissions.isError && <section className="panel error-text">权限目录读取失败，角色编辑已停用：{permissions.error.message}</section>}
        <section className="role-grid">
          {canRoles && <button className="role-add" disabled={permissions.isLoading || permissions.isError} onClick={() => { setSelectedRole(undefined); setRoleModal('create'); }}><Plus /><strong>创建自定义角色</strong><span>按最小权限原则分配能力</span></button>}
          {roles.isLoading ? <section className="panel"><SkeletonRows /></section> : roleItems.map((role) => <article className="panel role-card" key={role.id}>
            <div><span className="role-icon"><UserCog /></span><span className="badge">{role.is_system ? '系统角色' : '自定义'}</span></div>
            <h3>{role.name}</h3>
            <code>{role.code}</code>
            <p>{role.description || '暂无角色说明'}</p>
            <div className="permission-chips">{role.permissions.slice(0, 6).map((permission) => <span key={permission}>{permission}</span>)}{role.permissions.length > 6 && <span>+{role.permissions.length - 6}</span>}</div>
            <footer><span>{role.user_count} 名管理员 · {role.permissions.length} 项权限</span>{canRoles && !role.is_system && <button className="ghost compact" disabled={permissions.isLoading || permissions.isError} onClick={() => { setSelectedRole(role); setRoleModal('edit'); }}><Edit3 />编辑</button>}</footer>
          </article>)}
        </section></>}
    </>}

    {canUsers && <AdminModal
      mode={adminModal}
      admin={selected}
      roles={roleItems}
      isSelf={selected?.id === currentAdmin?.id}
      busy={saveAdmin.isPending || resetPassword.isPending}
      onClose={() => setAdminModal(null)}
      onSave={(body) => {
        if (adminModal === 'reset' && selected) {
          resetPassword.mutate({ id: selected.id, password: String(body.password) });
          return;
        }
        saveAdmin.mutate({
          path: adminModal === 'create' ? '/admin/v1/admin-users' : `/admin/v1/admin-users/${selected!.id}`,
          method: adminModal === 'create' ? 'POST' : 'PATCH',
          body,
        });
      }}
    />}
    {canRoles && <RoleModal
      mode={roleModal}
      role={selectedRole}
      permissions={permissionItems}
      busy={saveRole.isPending}
      onClose={() => setRoleModal(null)}
      onSave={(body) => saveRole.mutate({
        path: roleModal === 'create' ? '/admin/v1/admin-roles' : `/admin/v1/admin-roles/${selectedRole!.id}`,
        method: roleModal === 'create' ? 'POST' : 'PATCH',
        body,
      })}
    />}
  </div>;
}

function AdminModal({ mode, admin, roles, isSelf, busy, onClose, onSave }: {
  mode: AdminModalMode;
  admin?: ManagedAdmin;
  roles: AdminRole[];
  isSelf: boolean;
  busy: boolean;
  onClose(): void;
  onSave(body: Record<string, unknown>): void;
}) {
  const [roleError, setRoleError] = useState('');
  useEffect(() => { setRoleError(''); }, [mode, admin?.id]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (mode === 'reset') {
      onSave({ password: form.get('password') });
      return;
    }
    const roleIds = form.getAll('roles');
    if (!isSelf && roleIds.length === 0) {
      setRoleError('至少选择一个角色');
      return;
    }
    setRoleError('');
    onSave({
      email: form.get('email'),
      display_name: form.get('display_name'),
      ...(mode === 'create' ? { password: form.get('password'), role_ids: roleIds } : {}),
      ...(mode === 'edit' && !isSelf ? { status: form.get('status'), role_ids: roleIds } : {}),
    });
  }

  return <Modal open={mode !== null} onClose={onClose} title={mode === 'create' ? '新增管理员' : mode === 'reset' ? '重置管理员密码' : '编辑管理员'} subtitle={mode === 'reset' ? '重置后该账号所有旧会话立即失效' : isSelf ? '当前账号只能修改姓名和邮箱，角色与状态需由其他所有者操作' : '账号和角色变更会记录审计日志'}>
    <form className="form-grid" onSubmit={submit}>
      {mode !== 'reset' ? <>
        <label>显示名称<input name="display_name" required minLength={2} defaultValue={admin?.display_name} /></label>
        <label>登录邮箱<input name="email" type="email" required defaultValue={admin?.email} /></label>
        {mode === 'create' ? <label className="full">初始密码<input name="password" type="password" required minLength={12} /><small className="field-help">至少 12 位，包含大小写字母和数字</small></label> : !isSelf && <label>账号状态<select name="status" defaultValue={admin?.status}><option value="ACTIVE">启用</option><option value="SUSPENDED">暂停</option><option value="DISABLED">禁用</option></select></label>}
        {!isSelf && <fieldset className="full permission-picker"><legend>分配角色</legend>{roles.map((role) => <label key={role.id}><input type="checkbox" name="roles" value={role.id} defaultChecked={admin?.roles.some((item) => item.id === role.id) ?? false} onChange={() => setRoleError('')} /><span><strong>{role.name}</strong><small>{role.code}</small></span></label>)}{roleError && <small className="field-error">{roleError}</small>}</fieldset>}
      </> : <label className="full">新密码<input name="password" type="password" required minLength={12} /><small className="field-help">至少 12 位，包含大小写字母和数字</small></label>}
      <div className="form-actions full"><button type="button" className="ghost" onClick={onClose}>取消</button><button className="primary" disabled={busy}>{busy ? '正在保存...' : '确认保存'}</button></div>
    </form>
  </Modal>;
}

function RoleModal({ mode, role, permissions, busy, onClose, onSave }: {
  mode: RoleModalMode;
  role?: AdminRole;
  permissions: AdminPermission[];
  busy: boolean;
  onClose(): void;
  onSave(body: Record<string, unknown>): void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSave({
      ...(mode === 'create' ? { code: form.get('code') } : {}),
      name: form.get('name'),
      description: form.get('description'),
      permissions: form.getAll('permissions'),
    });
  }
  const groups = useMemo(() => permissions.reduce<Record<string, AdminPermission[]>>((all, permission) => {
    const group = permission.code.split('.')[0] ?? 'other';
    (all[group] ??= []).push(permission);
    return all;
  }, {}), [permissions]);

  return <Modal open={mode !== null} onClose={onClose} title={mode === 'create' ? '创建角色' : '编辑角色权限'} subtitle="权限保存后立即影响该角色下管理员" wide>
    <form className="form-grid" onSubmit={submit}>
      <label>角色名称<input name="name" required defaultValue={role?.name} /></label>
      <label>角色代码<input name="code" required disabled={mode === 'edit'} defaultValue={role?.code} /></label>
      <label className="full">角色说明<textarea name="description" defaultValue={role?.description ?? ''} /></label>
      <div className="full permission-matrix">{Object.entries(groups).map(([group, items]) => <section key={group}><h4>{group}</h4>{items.map((permission) => <label key={permission.code}><input type="checkbox" name="permissions" value={permission.code} defaultChecked={role?.permissions.includes(permission.code)} /><span><strong>{permission.name}</strong><small>{permission.code} · {permission.description}</small></span></label>)}</section>)}</div>
      <div className="form-actions full"><button type="button" className="ghost" onClick={onClose}>取消</button><button className="primary" disabled={busy}>{busy ? '保存中...' : '保存角色'}</button></div>
    </form>
  </Modal>;
}

function statusText(status: string) {
  return status === 'ACTIVE' ? '启用' : status === 'SUSPENDED' ? '暂停' : '禁用';
}
