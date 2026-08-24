import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthProvider';
import { ToastProvider } from '../components/Toast';
import { AppRoutes } from './AppRoutes';
const queryClient=new QueryClient({defaultOptions:{queries:{retry:1,staleTime:15000,refetchOnWindowFocus:false},mutations:{retry:false}}});
export function App(){return <QueryClientProvider client={queryClient}><BrowserRouter basename="/admin"><AuthProvider><ToastProvider><AppRoutes/></ToastProvider></AuthProvider></BrowserRouter></QueryClientProvider>}
