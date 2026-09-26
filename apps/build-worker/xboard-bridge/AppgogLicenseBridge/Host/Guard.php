<?php
namespace Appgog\Host;

/** Persists outside the removable plugin. Only enrolled/new protected themes are gated. */
final class Guard
{
    private static function root(): string { return storage_path('app/private/appgog-host'); }

    public static function manifest(string $theme): ?array
    {
        if (!preg_match('/^[A-Za-z0-9_-]{1,100}$/', $theme)) return null;
        try {
            $path = app(\App\Services\ThemeService::class)->getThemePath($theme);
            if (!$path || !is_file($path . '/appgog-license/build.json')) return null;
            $data = json_decode(file_get_contents($path . '/appgog-license/build.json'), true);
            return is_array($data) && ($data['schema'] ?? 0) === 2 ? $data : null;
        } catch (\Throwable $error) { return null; }
    }

    public static function enrolled(string $theme): bool
    {
        return preg_match('/^[A-Za-z0-9_-]{1,100}$/', $theme)
            && is_file(self::root() . '/themes/' . $theme . '.json');
    }

    public static function enroll(string $theme, array $manifest): void
    {
        if (!preg_match('/^[A-Za-z0-9_-]{1,100}$/', $theme)) throw new \RuntimeException('Invalid protected theme');
        $keys = $manifest['verification_keys'] ?? [];
        $signed = self::payload($manifest['package_manifest_token'] ?? '', $keys['package'] ?? '');
        if (!$signed || ($signed['typ'] ?? '') !== 'package-manifest') throw new \RuntimeException('Invalid package signature');
        foreach (['product', 'build_id', 'package_id', 'domain', 'version'] as $field) {
            if (($signed[$field] ?? null) !== ($manifest[$field] ?? null)) throw new \RuntimeException('Package identity mismatch');
        }
        \Illuminate\Support\Facades\File::ensureDirectoryExists(self::root() . '/themes', 0700, true);
        $path = self::root() . '/themes/' . $theme . '.json';
        $record = ['theme' => $theme, 'product' => $manifest['product'], 'verification_keys' => $keys];
        // Enrollment only runs after authenticated package registration or successful admin upload.
        $temporary = $path . '.' . bin2hex(random_bytes(6)) . '.tmp';
        if (file_put_contents($temporary, json_encode($record), LOCK_EX) === false || !rename($temporary, $path)) {
            @unlink($temporary);
            throw new \RuntimeException('Cannot persist protected theme enrollment');
        }
        @chmod($path, 0600);
    }

    public static function enabled(): bool
    {
        $plugin = \App\Models\Plugin::where('code', 'appgog_license_bridge')->first();
        return $plugin && $plugin->is_enabled && is_file(base_path('plugins/AppgogLicenseBridge/Plugin.php'));
    }

    private static function decode(string $value): string
    {
        $decoded = base64_decode(strtr($value, '-_', '+/'), true);
        if ($decoded === false) throw new \RuntimeException('Invalid signed payload');
        return $decoded;
    }

    public static function payload(string $token, string $pem): ?array
    {
        try {
            $parts = explode('.', $token);
            if (count($parts) !== 3) return null;
            $der = base64_decode(preg_replace('/-----[^-]+-----|\s+/', '', $pem), true);
            if (!$der || strlen($der) !== 44 || bin2hex(substr($der, 0, 12)) !== '302a300506032b6570032100') return null;
            $header = json_decode(self::decode($parts[0]), true);
            if (($header['alg'] ?? '') !== 'EdDSA' || ($header['typ'] ?? '') !== 'APPGOG-ACT' || ($header['v'] ?? 0) !== 1) return null;
            if (!sodium_crypto_sign_verify_detached(self::decode($parts[2]), $parts[0] . '.' . $parts[1], substr($der, -32))) return null;
            $data = json_decode(self::decode($parts[1]), true);
            return is_array($data) ? $data : null;
        } catch (\Throwable $error) { return null; }
    }

    public static function licensed(string $theme, string $host, ?string $capability = null): bool
    {
        try {
            if (!self::enabled()) return false;
            $manifest = self::manifest($theme);
            if (!$manifest || !self::enrolled($theme)) return false;
            $enrollment = json_decode(file_get_contents(self::root() . '/themes/' . $theme . '.json'), true);
            $keys = $enrollment['verification_keys'] ?? [];
            if ($keys !== ($manifest['verification_keys'] ?? null)) return false;
            $signed = self::payload($manifest['package_manifest_token'] ?? '', $keys['package'] ?? '');
            if (!$signed || ($signed['typ'] ?? '') !== 'package-manifest') return false;
            foreach (['product', 'build_id', 'package_id', 'domain', 'version'] as $field) {
                if (($signed[$field] ?? null) !== ($manifest[$field] ?? null)) return false;
            }
            $domain = strtolower(trim($host, '.'));
            if (str_starts_with($domain, 'www.') && str_contains(substr($domain, 4), '.')) $domain = substr($domain, 4);
            if ($domain !== $manifest['domain']) return false;
            $root = storage_path('app/private/appgog-license-bridge');
            $file = $root . '/state/' . hash('sha256', $manifest['package_id']) . '.json.enc';
            if (!is_file($file)) return false;
            $state = json_decode(\Illuminate\Support\Facades\Crypt::decryptString(file_get_contents($file)), true);
            if (!$state || !empty($state['denied']) || empty($state['activation_id'])) return false;
            $activation = self::payload($state['activation_token'] ?? '', $keys['activation'] ?? '');
            if (!$activation || ($activation['typ'] ?? '') !== 'activation'
                || !is_int($activation['exp'] ?? null) || !is_int($activation['offline_until'] ?? null)
                || $activation['offline_until'] <= time() || $activation['offline_until'] < $activation['exp']) return false;
            foreach (['product', 'build_id', 'package_id', 'domain'] as $field) {
                if (($activation[$field] ?? null) !== $manifest[$field]) return false;
            }
            if ($capability && isset($activation['capabilities']) && !in_array($capability, $activation['capabilities'], true)) return false;
            $identity = json_decode(\Illuminate\Support\Facades\Crypt::decryptString(file_get_contents($root . '/identity.json.enc')), true);
            $der = hex2bin('302a300506032b6570032100') . base64_decode($identity['public_key'], true);
            $id = 'ins_' . rtrim(strtr(base64_encode(hash('sha256', $der, true)), '+/', '-_'), '=');
            return ($activation['installation_id'] ?? '') === $id
                && ($activation['backend_origin'] ?? '') === ($state['backend_origin'] ?? '');
        } catch (\Throwable $error) { return false; }
    }

    public function handle($request, \Closure $next)
    {
        $path = trim($request->path(), '/');
        $admin = admin_setting('secure_path', admin_setting('frontend_admin_path', hash('crc32b', config('app.key'))));
        $prefixes = ['api/v2/' . $admin, 'api/v1/' . $admin];
        $theme = null;
        $capability = 'protected:read';
        foreach ($prefixes as $prefix) {
            if ($path === $prefix . '/theme/getThemeConfig') { $theme = $request->input('name'); $capability = 'settings:read'; }
            if ($path === $prefix . '/theme/saveThemeConfig') { $theme = $request->input('name'); $capability = 'settings:write'; }
            if ($path === $prefix . '/config/save') { $theme = $request->input('frontend_theme'); $capability = 'theme:enable'; }
        }
        if ($path === '' && $request->method() === 'GET') $theme = admin_setting('frontend_theme', 'Xboard');
        if (is_string($theme) && (self::enrolled($theme) || isset(self::manifest($theme)['verification_keys']))
            && !self::licensed($theme, $request->getHost(), $capability)) {
            if ($path === '') {
                return response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>暂时无法访问</title><body style="font:16px system-ui;text-align:center;padding:15vh 24px"><h1>站点暂时无法访问</h1><p>请联系站点管理员。</p></body></html>', 423)->header('Cache-Control', 'no-store');
            }
            return response()->json(['message' => 'APPGOG 授权未就绪：请在原生后台修复插件并完成两阶段激活', 'code' => 'APPGOG_LICENSE_REQUIRED'], 423)->header('Cache-Control', 'no-store');
        }
        $response = $next($request);
        if ($response->getStatusCode() >= 200 && $response->getStatusCode() < 300
            && in_array($path, [$prefixes[0] . '/theme/upload', $prefixes[1] . '/theme/upload'], true)) {
            // Publish activation assets without enabling the theme or executing PHP from uploaded ZIPs.
            try {
                $themes = app(\App\Services\ThemeService::class);
                foreach ($themes->getList() as $name => $config) {
                    $manifest = self::manifest($name);
                    if (!isset($manifest['verification_keys'])) continue;
                    self::enroll($name, $manifest);
                    if (!\Illuminate\Support\Facades\File::copyDirectory($themes->getThemePath($name), public_path('theme/' . $name))) {
                        throw new \RuntimeException('Cannot publish activation assets');
                    }
                }
            } catch (\Throwable $error) {
                \Illuminate\Support\Facades\Log::error('APPGOG activation preparation failed', ['exception' => get_class($error)]);
                return response()->json(['message' => '主题已上传，但授权组件准备失败；请检查 Xboard 日志及目录权限。主题尚未启用。'], 503);
            }
        }
        // Recovery remains reachable even after the removable plugin is deleted.
        if ($path === $admin && $request->method() === 'GET' && $response->getStatusCode() === 200
            && str_contains($response->headers->get('Content-Type', ''), 'text/html')) {
            $html = $response->getContent();
            $script = self::root() . '/admin-entry.js';
            if (is_file($script) && !str_contains($html, 'data-appgog-admin-entry')) {
                $response->setContent(str_replace('</body>', '<script data-appgog-admin-entry>' . file_get_contents($script) . '</script></body>', $html));
                $response->headers->remove('Content-Length');
            }
        }
        return $response;
    }
}
