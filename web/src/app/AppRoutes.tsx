import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { AppShell } from '../components/AppShell';
import { LoginPage } from '../pages/LoginPage';
import { DashboardPage } from '../pages/DashboardPage';
import { ProductsPage } from '../pages/ProductsPage';
import { PoliciesPage } from '../pages/PoliciesPage';
import { KeysPage } from '../pages/KeysPage';
import { AuditPage } from '../pages/AuditPage';
import { ApiCenterPage } from '../pages/ApiCenterPage';

function Protected(){const {status}=useAuth(); if(status==='loading')return <div className="boot-screen"><div className="brand-mark"><span/></div><p>正在建立安全会话...</p></div>; if(status==='anonymous')return <Navigate to="/login" replace/>; return <AppShell/>}
export function AppRoutes(){return <Routes><Route path="/login" element={<LoginPage/>}/><Route element={<Protected/>}><Route index element={<DashboardPage/>}/><Route path="products" element={<ProductsPage/>}/><Route path="policies" element={<PoliciesPage/>}/><Route path="keys" element={<KeysPage/>}/><Route path="audit" element={<AuditPage/>}/><Route path="api-center" element={<ApiCenterPage/>}/></Route><Route path="*" element={<Navigate to="/" replace/>}/></Routes>}
