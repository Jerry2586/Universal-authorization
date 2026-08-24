import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { PermissionNotice } from '../components/AdminForms';
import { AppShell } from '../components/AppShell';
import { LoginPage } from '../pages/LoginPage';
import { DashboardPage } from '../pages/DashboardPage';
import { ProductsPage } from '../pages/ProductsPage';
import { PoliciesPage } from '../pages/PoliciesPage';
import { KeysPage } from '../pages/KeysPage';
import { AuditPage } from '../pages/AuditPage';
import { ApiCenterPage } from '../pages/ApiCenterPage';

function Protected() {
  const { status } = useAuth();
  if (status === 'loading') return <div className="boot-screen"><div className="brand-mark"><span /></div><p>正在建立安全会话...</p></div>;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  return <AppShell />;
}

function PermissionGate({ permission, children }: { permission: string; children: React.ReactNode }) {
  const { has } = useAuth();
  return has(permission) ? children : <PermissionNotice>当前账号没有 {permission} 权限，此页面不会发起越权 API 请求。</PermissionNotice>;
}

export function AppRoutes() {
  return <Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route element={<Protected />}>
      <Route index element={<DashboardPage />} />
      <Route path="products" element={<PermissionGate permission="products.read"><ProductsPage /></PermissionGate>} />
      <Route path="policies" element={<PermissionGate permission="licenses.read"><PoliciesPage /></PermissionGate>} />
      <Route path="keys" element={<PermissionGate permission="licenses.read"><KeysPage /></PermissionGate>} />
      <Route path="audit" element={<PermissionGate permission="audit.read"><AuditPage /></PermissionGate>} />
      <Route path="api-center" element={<ApiCenterPage />} />
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>;
}
