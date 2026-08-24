import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity, Boxes, ChevronDown, CircleHelp, FileKey2, KeyRound, LayoutDashboard, LogOut, Menu, ScrollText, Settings2, ShieldCheck, Sparkles, UserCog, UserRound, X,
  type LucideIcon,
} from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';

interface NavItem { to: string; label: string; icon: LucideIcon; permission?: string; permissionAny?: string[] }

const nav: readonly NavItem[] = [
  { to: '/', label: '控制台', icon: LayoutDashboard },
  { to: '/products', label: '产品管理', icon: Boxes, permission: 'products.read' },
  { to: '/policies', label: '授权策略', icon: ShieldCheck, permission: 'licenses.read' },
  { to: '/keys', label: 'Key 管理', icon: KeyRound, permission: 'licenses.read' },
  { to: '/audit', label: '审计与事件', icon: ScrollText, permission: 'audit.read' },
  { to: '/admin-users', label: '管理员与角色', icon: UserCog, permissionAny: ['admin.users.manage', 'admin.roles.manage'] },
  { to: '/settings', label: '系统设置', icon: Settings2, permission: 'tenant.settings.manage' },
  { to: '/api-center', label: 'API 中心', icon: FileKey2 },
];

const titles: Record<string, [string, string]> = {
  '/': ['控制台', '授权业务实时概览'],
  '/products': ['产品管理', '管理产品、版本与功能能力'],
  '/policies': ['授权策略', '编排时长、设备和离线规则'],
  '/keys': ['Key 管理', '生成、交付与管理授权 Key'],
  '/audit': ['审计与事件', '追踪管理操作与授权生命周期'],
  '/admin-users': ['管理员与角色', '管理账号、角色和权限边界'],
  '/profile': ['个人中心', '维护个人资料与登录密码'],
  '/settings': ['系统设置', '配置工作区和授权默认参数'],
  '/api-center': ['API 中心', '查看全部接口与服务实时状态'],
};

export function AppShell() {
  const [mobile, setMobile] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const { admin, logout, has } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const info = titles[location.pathname] ?? ['管理后台', 'Universal Authorization'];
  const health = useQuery({ queryKey: ['health', 'global'], queryFn: () => api<{ status: string }>('/health'), refetchInterval: 15_000, retry: false });
  const ready = useQuery({ queryKey: ['ready', 'global'], queryFn: () => api<{ status: string }>('/ready'), refetchInterval: 15_000, retry: false });
  const online = health.isSuccess && ready.isSuccess;
  const checking = health.isLoading || ready.isLoading;

  function openApiCenter() {
    setMobile(false);
    void navigate('/api-center');
  }

  return <div className="app-shell">
    <aside className={`sidebar ${mobile ? 'mobile-open' : ''}`}>
      <div className="logo"><div className="logo-glyph"><span /></div><div><strong>Universal</strong><small>AUTHORIZATION</small></div><button type="button" className="sidebar-close" aria-label="关闭菜单" onClick={() => setMobile(false)}><X /></button></div>
      <div className="workspace"><span className="workspace-icon"><Sparkles /></span><div><small>当前工作区</small><strong>{admin?.tenant?.name ?? '平台管理'}</strong></div><ChevronDown /></div>
      <nav>{nav.filter((item) => (item.permission === undefined || has(item.permission)) && (item.permissionAny === undefined || item.permissionAny.some(has))).map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === '/'} onClick={() => setMobile(false)}><Icon /><span>{label}</span><i /></NavLink>)}</nav>
      <div className="sidebar-foot">
        <div className={`security-pulse ${online ? '' : 'offline'}`}><span /><div><strong>{checking ? '正在检查服务' : online ? '安全连接正常' : '服务连接异常'}</strong><small>{online ? 'Cookie 会话 · CSRF 防护' : '请打开 API 中心查看状态'}</small></div></div>
        <button type="button" onClick={openApiCenter}><CircleHelp />部署与接口帮助</button>
      </div>
    </aside>

    <div className="main">
      <header className="topbar">
        <button type="button" className="menu-button" aria-label="打开菜单" onClick={() => setMobile(true)}><Menu /></button>
        <div className="page-heading"><span>{info[1]}</span><h1>{info[0]}</h1></div>
        <div className="top-actions">
          <div className={`live ${online ? '' : 'offline'}`} title={online ? '健康检查和就绪检查均通过' : '健康检查或就绪检查未通过'}><i />{checking ? '检测中' : online ? '服务在线' : '服务异常'}</div>
          <button type="button" className="user-menu" aria-expanded={userOpen} onClick={() => setUserOpen((value) => !value)}><span>{admin?.display_name.slice(0, 1).toUpperCase()}</span><div><strong>{admin?.display_name}</strong><small>{admin?.email}</small></div><ChevronDown /></button>
          {userOpen && <div className="user-popover"><div><small>登录工作区</small><strong>{admin?.tenant?.code ?? 'platform'}</strong></div><button type="button" onClick={() => { setUserOpen(false); void navigate('/profile'); }}><UserRound />个人中心</button><button type="button" onClick={() => void logout()}><LogOut />退出登录</button></div>}
        </div>
      </header>
      <main className="content"><Outlet /></main>
      <footer><span>Universal Authorization Console</span><span><Activity /> {online ? '管理 API 已连接' : '管理 API 状态异常'}</span></footer>
    </div>
    {mobile && <button type="button" className="mobile-shade" aria-label="关闭菜单" onClick={() => setMobile(false)} />}
  </div>;
}
