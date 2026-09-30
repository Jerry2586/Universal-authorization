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

    private static function forgetEnrollment(string $theme): void
    {
        if (!preg_match('/^[A-Za-z0-9_-]{1,100}$/D', $theme)) return;
        \Illuminate\Support\Facades\File::delete(self::root() . '/themes/' . $theme . '.json');
    }

    private static function uploadedTheme($request): ?string
    {
        try {
            if (!method_exists($request, 'file')) return null;
            $upload = $request->file('file');
            if (!is_object($upload) || !class_exists(\ZipArchive::class)) return null;
            $path = null;
            foreach (['getRealPath', 'path', 'getPathname'] as $method) {
                if (!method_exists($upload, $method)) continue;
                $candidate = $upload->{$method}();
                if (is_string($candidate) && $candidate !== '' && is_file($candidate)) { $path = $candidate; break; }
            }
            if ($path === null) return null;
            $zip = new \ZipArchive;
            if ($zip->open($path) !== true) return null;
            try {
                for ($index = 0; $index < $zip->numFiles; $index++) {
                    $entry = $zip->getNameIndex($index);
                    if (!is_string($entry) || basename(str_replace('\\', '/', $entry)) !== 'config.json') continue;
                    $stat = $zip->statIndex($index);
                    if (!is_array($stat) || ($stat['size'] ?? 0) < 1 || ($stat['size'] ?? 0) > 262144) return null;
                    $raw = $zip->getFromIndex($index);
                    $config = is_string($raw) ? json_decode($raw, true) : null;
                    $theme = is_array($config) ? ($config['name'] ?? null) : null;
                    return is_string($theme) && preg_match('/^[A-Za-z0-9_-]{1,100}$/D', $theme) ? $theme : null;
                }
            } finally { $zip->close(); }
        } catch (\Throwable $error) { return null; }
        return null;
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
        if (is_file($path)) {
            $existing = json_decode(file_get_contents($path), true);
            if (($existing['verification_keys'] ?? null) !== $keys || ($existing['product'] ?? null) !== $manifest['product']) {
                throw new \RuntimeException('Publisher identity changed; explicit trusted recovery is required');
            }
        }
        if (!self::contentValid($theme, $manifest, $signed, $keys['package'] ?? '')) throw new \RuntimeException('Package content signature invalid');
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

    private static function canonical($value): string
    {
        if (is_object($value)) {
            $fields = get_object_vars($value); ksort($fields, SORT_STRING);
            $parts = [];
            foreach ($fields as $key => $item) $parts[] = json_encode((string)$key, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_LINE_TERMINATORS | JSON_THROW_ON_ERROR) . ':' . self::canonical($item);
            return '{' . implode(',', $parts) . '}';
        }
        if (is_array($value)) return '[' . implode(',', array_map([self::class, 'canonical'], $value)) . ']';
        return json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_LINE_TERMINATORS | JSON_THROW_ON_ERROR);
    }

    public static function contentValid(string $theme, array $manifest, array $identity, string $publicKey, bool $checkPublished = false): bool
    {
        if (($identity['content_signature_required'] ?? false) !== true && !isset($manifest['content_signature'])) return true;
        try {
            $seal = self::payload($manifest['content_signature'] ?? '', $publicKey);
            if (!$seal || ($seal['typ'] ?? '') !== 'package-content-v1' || ($seal['iss'] ?? null) !== ($identity['iss'] ?? null)
                || ($seal['build_id'] ?? '') !== ($manifest['build_id'] ?? null) || ($seal['package_id'] ?? '') !== ($manifest['package_id'] ?? null)) return false;
            $root = realpath(app(\App\Services\ThemeService::class)->getThemePath($theme));
            if (!$root) return false;
            $raw = json_decode(file_get_contents($root . '/appgog-license/build.json'), false, 512, JSON_THROW_ON_ERROR);
            if (!is_object($raw)) return false;
            unset($raw->content_signature);
            if (!hash_equals($seal['content_sha256'] ?? '', hash('sha256', self::canonical($raw)))) return false;
            $bridgePath = $manifest['protection']['bridge_package_path'] ?? '';
            $suffix = 'appgog-license/appgog-license-bridge.zip';
            if (!str_ends_with($bridgePath, $suffix)) return false;
            $prefix = substr($bridgePath, 0, -strlen($suffix));
            $files = $manifest['integrity']['files'] ?? null;
            if (!is_array($files) || count($files) < 2) return false;
            $roots = [$root];
            if ($checkPublished) {
                $published = realpath(public_path('theme/' . $theme));
                if (!$published || !is_file($published . '/appgog-license/build.json')) return false;
                if (hash_file('sha256', $published . '/appgog-license/build.json') !== hash_file('sha256', $root . '/appgog-license/build.json')) return false;
                if ($published !== $root) $roots[] = $published;
            }
            foreach ($roots as $root) {
            $seen = [];
            foreach ($files as $file) {
                $path = $file['path'] ?? '';
                if (!is_string($path) || !str_starts_with($path, $prefix)) return false;
                $relative = substr($path, strlen($prefix));
                if ($relative === '' || in_array('..', explode('/', $relative), true) || str_contains($relative, '\\') || str_starts_with($relative, '/') || isset($seen[$relative])) return false;
                $absolute = realpath($root . '/' . $relative);
                if (!$absolute || !str_starts_with($absolute, $root . DIRECTORY_SEPARATOR) || !is_file($absolute)) return false;
                if (filesize($absolute) !== ($file['bytes'] ?? null) || !hash_equals($file['sha256'] ?? '', hash_file('sha256', $absolute))) return false;
                $seen[$relative] = true;
            }
            // Refuse newly injected executable pages/scripts outside the signed inventory.
            $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS));
            foreach ($iterator as $entry) {
                $relative = str_replace(DIRECTORY_SEPARATOR, '/', substr($entry->getPathname(), strlen($root) + 1));
                if (preg_match('/\.(?:html?|js|php)$/i', $relative) && !isset($seen[$relative])) return false;
            }
            }
            return true;
        } catch (\Throwable $error) { return false; }
    }

    public static function packageIntegrityValid(string $theme): bool
    {
        try {
            $manifest = self::manifest($theme);
            if (!$manifest || !self::enrolled($theme)) return false;
            $enrollment = json_decode(file_get_contents(self::root() . '/themes/' . $theme . '.json'), true);
            $keys = $enrollment['verification_keys'] ?? [];
            if ($keys !== ($manifest['verification_keys'] ?? null)) return false;
            $identity = self::payload($manifest['package_manifest_token'] ?? '', $keys['package'] ?? '');
            if (!$identity || ($identity['typ'] ?? '') !== 'package-manifest') return false;
            foreach (['product','build_id','package_id','domain','version'] as $field) {
                if (($identity[$field] ?? null) !== ($manifest[$field] ?? null)) return false;
            }
            return self::contentValid($theme, $manifest, $identity, $keys['package'] ?? '', true);
        } catch (\Throwable $error) { return false; }
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
            if (!self::contentValid($theme, $manifest, $signed, $keys['package'] ?? '', true)) return false;
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
        $isThemeUpload = in_array($path, [$prefixes[0] . '/theme/upload', $prefixes[1] . '/theme/upload'], true);
        $uploadedTheme = $isThemeUpload ? self::uploadedTheme($request) : null;
        $response = $next($request);
        if ($response->getStatusCode() >= 200 && $response->getStatusCode() < 300 && $isThemeUpload) {
            // Publish activation assets without enabling the theme or executing PHP from uploaded ZIPs.
            try {
                $payload = json_decode($response->getContent(), true);
                if (is_array($payload) && in_array($payload['status'] ?? null, [false, 'fail', 'error'], true)) return $response;
                // Only a successful authenticated replacement of this exact theme may
                // retire its old protected enrollment. Manual manifest deletion still
                // leaves the enrollment in place and therefore remains fail-closed.
                if ($uploadedTheme !== null && self::manifest($uploadedTheme) === null) self::forgetEnrollment($uploadedTheme);
                $prepared = [];
                $themes = app(\App\Services\ThemeService::class);
                foreach ($themes->getList() as $name => $config) {
                    $manifest = self::manifest($name);
                    if (!isset($manifest['verification_keys'])) continue;
                    self::enroll($name, $manifest);
                    if (!\Illuminate\Support\Facades\File::copyDirectory($themes->getThemePath($name), public_path('theme/' . $name))) {
                        throw new \RuntimeException('Cannot publish activation assets');
                    }
                    if (!self::packageIntegrityValid($name)) throw new \RuntimeException('Published theme content verification failed');
                    $prepared[] = ['name' => $name, 'appgog_activation' => ['schema' => 1]];
                }
                // The authenticated upload response reaches the extension before
                // React paints the new card; it must not depend on opening editor.
                if (is_array($payload)) {
                    $payload['appgog_activation'] = ['schema' => 1, 'themes' => $prepared];
                    $response->setContent(json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
                    $response->headers->remove('Content-Length');
                    $response->headers->set('Cache-Control', 'no-store');
                }
            } catch (\Throwable $error) {
                \Illuminate\Support\Facades\Log::error('APPGOG activation preparation failed', ['exception' => get_class($error)]);
                return response()->json(['message' => '主题已上传，但授权组件准备失败；请检查 Xboard 日志及目录权限。主题尚未启用。'], 503);
            }
        }
        // Recovery remains reachable even after the removable plugin is deleted.
        if ($path === $admin && $request->method() === 'GET' && $response->getStatusCode() === 200
            && str_contains($response->headers->get('Content-Type', ''), 'text/html')) {
            try {
                $html = $response->getContent();
                $script = self::root() . '/admin-entry.js';
                if (is_string($html) && is_file($script) && is_readable($script) && !str_contains($html, 'data-appgog-admin-entry')) {
                    $source = file_get_contents($script);
                    if (is_string($source)) {
                        $response->setContent(str_replace('</body>', '<script data-appgog-admin-entry>' . $source . '</script></body>', $html));
                        $response->headers->remove('Content-Length');
                    }
                }
            } catch (\Throwable $error) {
                // Presentation is optional; authorization checks above remain fail-closed.
                try { \Illuminate\Support\Facades\Log::warning('APPGOG recovery page decoration skipped', ['error_type' => get_class($error)]); }
                catch (\Throwable $loggingError) { /* Preserve the host recovery response. */ }
            }
        }
        return $response;
    }
}
