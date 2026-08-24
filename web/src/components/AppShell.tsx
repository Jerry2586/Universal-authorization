import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  Boxes,
  ChevronDown,
  CircleHelp,
  FileKey2,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  ScrollText,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';

const nav = [
  ['/', '控制台', LayoutDashboard],
  ['/products', '产品管理', Boxes],
  ['/policies', '授权策略', ShieldCheck],
  ['/keys', 'Key 管理', KeyRound],
  ['/audit', '审计与事件', ScrollText],
  ['/api-center', 'API 中心', FileKey2],
] as const;

const titles: Record<string, [string, string]> = {
  '/': ['控制台', '授权业务实时概览'],
  '/products': ['产品管理', '管理产品、版本与功能能力'],
  '/policies': ['授权策略', '编排时长、设备和离线规则'],
  '/keys': ['Key 管理', '生成、交付与管理授权 Key'],
  '/audit': ['审计与事件', '追踪管理操作与授权生命周期'],
  '/api-center': ['API 中心', '查看客户端接入协议与服务状态'],
};

export function AppShell() {
  const [mobile, setMobile] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const { admin, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const info = titles[location.pathname] ?? ['管理后台', 'Universal Authorization'];

  function openApiCenter() {
    setMobile(false);
    void navigate('/api-center');
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobile ? 'mobile-open' : ''}`}>
        <div className="logo">
          <div className="logo-glyph">
            <span />
          </div>
          <div>
            <strong>Universal</strong>
            <small>AUTHORIZATION</small>
          </div>
          <button
            type="button"
            className="sidebar-close"
            aria-label="关闭菜单"
            onClick={() => setMobile(false)}
          >
            <X />
          </button>
        </div>

        <div className="workspace">
          <span className="workspace-icon">
            <Sparkles />
          </span>
          <div>
            <small>当前工作区</small>
            <strong>{admin?.tenant?.name ?? '平台管理'}</strong>
          </div>
          <ChevronDown />
        </div>

        <nav>
          {nav.map(([to, label, Icon]) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              onClick={() => setMobile(false)}
            >
              <Icon />
              <span>{label}</span>
              <i />
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="security-pulse">
            <span />
            <div>
              <strong>安全连接正常</strong>
              <small>Cookie 会话 · CSRF 防护</small>
            </div>
          </div>
          <button type="button" onClick={openApiCenter}>
            <CircleHelp />部署帮助
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button
            type="button"
            className="menu-button"
            aria-label="打开菜单"
            onClick={() => setMobile(true)}
          >
            <Menu />
          </button>
          <div className="page-heading">
            <span>{info[1]}</span>
            <h1>{info[0]}</h1>
          </div>
          <div className="top-actions">
            <div className="live">
              <i />服务在线
            </div>
            <button
              type="button"
              className="user-menu"
              aria-expanded={userOpen}
              onClick={() => setUserOpen((value) => !value)}
            >
              <span>{admin?.display_name.slice(0, 1).toUpperCase()}</span>
              <div>
                <strong>{admin?.display_name}</strong>
                <small>{admin?.email}</small>
              </div>
              <ChevronDown />
            </button>
            {userOpen && (
              <div className="user-popover">
                <div>
                  <small>登录工作区</small>
                  <strong>{admin?.tenant?.code ?? 'platform'}</strong>
                </div>
                <button type="button" onClick={() => void logout()}>
                  <LogOut />退出登录
                </button>
              </div>
            )}
          </div>
        </header>

        <main className="content">
          <Outlet />
        </main>
        <footer>
          <span>Universal Authorization Console</span>
          <span>
            <Activity /> 管理 API 已连接
          </span>
        </footer>
      </div>

      {mobile && (
        <button
          type="button"
          className="mobile-shade"
          aria-label="关闭菜单"
          onClick={() => setMobile(false)}
        />
      )}
    </div>
  );
}
