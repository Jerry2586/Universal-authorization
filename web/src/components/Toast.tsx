import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { CheckCircle2, CircleAlert, Info, X } from 'lucide-react';

type Tone='success'|'error'|'info'; interface Toast{ id:number; message:string; tone:Tone }
const ToastContext=createContext<(message:string,tone?:Tone)=>void>(()=>undefined);
export function ToastProvider({children}:{children:ReactNode}){ const [items,setItems]=useState<Toast[]>([]); const push=useCallback((message:string,tone:Tone='success')=>{ const id=Date.now()+Math.random(); setItems(v=>[...v,{id,message,tone}]); setTimeout(()=>setItems(v=>v.filter(x=>x.id!==id)),3600); },[]); const value=useMemo(()=>push,[push]); return <ToastContext.Provider value={value}>{children}<div className="toast-stack">{items.map(t=><div className={`toast ${t.tone}`} key={t.id}>{t.tone==='success'?<CheckCircle2/>:t.tone==='error'?<CircleAlert/>:<Info/>}<span>{t.message}</span><button onClick={()=>setItems(v=>v.filter(x=>x.id!==t.id))}><X/></button></div>)}</div></ToastContext.Provider> }
export const useToast=()=>useContext(ToastContext);
