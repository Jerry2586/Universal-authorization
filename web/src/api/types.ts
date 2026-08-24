export interface AdminUser {
  id: string;
  email: string;
  display_name: string;
  tenant: { id: string; code: string | null; name: string | null } | null;
  permissions: string[];
}
export interface AuthPayload { admin: AdminUser; csrf_token: string; expires_at: string }
export interface Product { id:string; code:string; name:string; description:string|null; status:string; minimum_client_version:string|null; recommended_client_version:string|null; force_update_version:string|null; settings:Record<string,unknown>; created_at:string; updated_at:string }
export interface ProductVersion { id:string; product_id:string; version:string; status:string; force_update:boolean; release_notes:string|null; released_at:string|null; created_at:string }
export interface Feature { id:string; product_id:string; code:string; name:string; description:string|null; status:string; created_at:string; updated_at:string }
export interface Policy { id:string; product_id:string|null; code:string; name:string; license_type:string; duration_seconds:number|null; max_devices:number; max_concurrent_sessions:number; offline_grace_seconds:number; allow_self_unbind:boolean; unbind_cooldown_seconds:number; rules:Record<string,unknown>; status:string; created_at:string; updated_at:string }
export interface License { id:string; product_id:string; policy_id:string|null; generation_batch_id:string|null; display_key:string; status:string; license_type:string; starts_at:string|null; expires_at:string|null; duration_seconds:number|null; max_devices:number; max_concurrent_sessions:number; offline_grace_seconds:number; allow_self_unbind:boolean; unbind_cooldown_seconds:number; metadata:Record<string,unknown>; features:Array<{code:string;allowed:boolean;limits:Record<string,unknown>;expires_at:string|null}>; created_at:string; activated_at:string|null; revoked_at:string|null; updated_at:string }
export interface DeviceBinding { [key:string]: unknown; id?:string; device_id?:string; device_name?:string; status?:string; platform?:string; last_seen_at?:string; blocked?:boolean }
export interface AuditItem { id:string; actor_type:string; actor_id:string|null; action:string; resource_type:string; resource_id:string|null; request_id:string|null; source_ip:string|null; result:string; metadata:Record<string,unknown>; occurred_at:string }
export interface LicenseEvent { id:string; product_id:string|null; license_id:string|null; device_id:string|null; event_type:string; result:string; reason_code:string|null; request_id:string|null; ip_address:string|null; metadata:Record<string,unknown>; occurred_at:string }
export interface Page<T> { items:T[]; limit:number; offset:number }
