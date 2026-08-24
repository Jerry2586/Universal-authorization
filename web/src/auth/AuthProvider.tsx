import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setCsrfToken, setUnauthorizedHandler } from '../api/client';
import type { AdminUser, AuthPayload } from '../api/types';

type Status = 'loading' | 'authenticated' | 'anonymous';
interface AuthContextValue { status:Status; admin:AdminUser|null; expiresAt:string|null; login(input:{email:string;password:string;tenant_code?:string}):Promise<void>; logout():Promise<void>; has(permission:string):boolean }
const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [admin, setAdmin] = useState<AdminUser|null>(null);
  const [expiresAt, setExpiresAt] = useState<string|null>(null);
  const clear = useCallback(() => { setCsrfToken(''); setAdmin(null); setExpiresAt(null); setStatus('anonymous'); }, []);
  const apply = useCallback((payload:AuthPayload) => { setCsrfToken(payload.csrf_token); setAdmin(payload.admin); setExpiresAt(payload.expires_at); setStatus('authenticated'); }, []);
  useEffect(() => { setUnauthorizedHandler(clear); void api<AuthPayload>('/admin/auth/me').then(apply).catch(clear); return () => setUnauthorizedHandler(() => undefined); }, [apply, clear]);
  const login = useCallback(async (input:{email:string;password:string;tenant_code?:string}) => { const payload=await api<AuthPayload>('/admin/auth/login',{method:'POST',body:JSON.stringify(input)}); apply(payload); }, [apply]);
  const logout = useCallback(async () => { try { await api('/admin/auth/logout',{method:'POST'}); } finally { clear(); } }, [clear]);
  const value=useMemo<AuthContextValue>(()=>({status,admin,expiresAt,login,logout,has:(permission)=>admin?.permissions.includes(permission)??false}),[status,admin,expiresAt,login,logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export function useAuth():AuthContextValue { const value=useContext(AuthContext); if(!value) throw new Error('AuthProvider missing'); return value; }
