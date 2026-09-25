<?php

namespace Plugin\AppgogLicenseBridge\Services;

use App\Services\ThemeService;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Validation\ValidationException;
use RuntimeException;

class BridgeState
{
    private const VERSION = '1.0.0';
    private const SPKI_PREFIX_HEX = '302a300506032b6570032100';
    private const PURPOSES = [
        'activation', 'refresh', 'migration_issue', 'migration_accept',
        'migration_prepare', 'migration_commit', 'migration_rollback',
        'recovery', 'offline_issue',
    ];

    private string $root;

    public function __construct()
    {
        $this->root = storage_path('app/private/appgog-license-bridge');
        File::ensureDirectoryExists($this->root, 0700, true);
        File::ensureDirectoryExists($this->root . '/packages', 0700, true);
        File::ensureDirectoryExists($this->root . '/state', 0700, true);
    }

    public function rememberThemeBeforeAppgog(): void
    {
        $path = $this->root . '/installation.json';
        if (File::exists($path)) {
            return;
        }
        $this->atomicJson($path, [
            'version' => self::VERSION,
            'previous_theme' => admin_setting('current_theme') ?: 'Xboard',
            'installed_at' => now()->toIso8601String(),
        ]);
    }

    public function identity(): array
    {
        $path = $this->root . '/identity.json.enc';
        if (File::exists($path)) {
            $identity = json_decode(Crypt::decryptString(File::get($path)), true);
            if (is_array($identity) && isset($identity['secret_key'], $identity['public_key'])) {
                return $identity;
            }
        }
        $keypair = sodium_crypto_sign_keypair();
        $identity = [
            'secret_key' => base64_encode(sodium_crypto_sign_secretkey($keypair)),
            'public_key' => base64_encode(sodium_crypto_sign_publickey($keypair)),
            'created_at' => now()->toIso8601String(),
        ];
        $this->atomicWrite($path, Crypt::encryptString(json_encode($identity, JSON_UNESCAPED_SLASHES)));
        return $identity;
    }

    public function publicIdentity(): array
    {
        $identity = $this->identity();
        $raw = base64_decode($identity['public_key'], true);
        if ($raw === false || strlen($raw) !== SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES) {
            throw new RuntimeException('APPGOG installation public key is invalid');
        }
        $der = hex2bin(self::SPKI_PREFIX_HEX) . $raw;
        $pem = "-----BEGIN PUBLIC KEY-----\n"
            . chunk_split(base64_encode($der), 64, "\n")
            . "-----END PUBLIC KEY-----\n";
        return [
            'installation_id' => 'ins_' . $this->base64Url(hash('sha256', $der, true)),
            'installation_public_key' => $pem,
        ];
    }

    public function registerPackage(array $payload): array
    {
        $domain = strtolower(trim($payload['domain'], ". \t\n\r\0\x0B"));
        $domainParts = parse_url('https://' . $domain);
        if ($domain === '' || !$domainParts || ($domainParts['host'] ?? '') !== $domain
            || isset($domainParts['port']) || isset($domainParts['user']) || isset($domainParts['pass'])
            || ($domainParts['path'] ?? '') !== '') {
            throw ValidationException::withMessages(['domain' => '授权域名无效']);
        }
        $licenseServer = $this->normalizeLicenseServer($payload['license_server']);
        $record = [
            'product' => $payload['product'],
            'build_id' => $payload['build_id'],
            'package_id' => $payload['package_id'],
            'package_proof_hash' => hash('sha256', $payload['package_proof']),
            'domain' => $domain,
            'theme_name' => $payload['theme_name'],
            'license_server' => $licenseServer,
            'registered_at' => now()->toIso8601String(),
        ];
        $path = $this->packagePath($payload['package_id']);
        if (File::exists($path)) {
            $existing = json_decode(File::get($path), true) ?: [];
            foreach (['product', 'build_id', 'package_id', 'domain', 'theme_name', 'license_server'] as $field) {
                if (($existing[$field] ?? null) !== $record[$field]) {
                    throw ValidationException::withMessages(['package_id' => '安装包注册信息与服务器记录不一致']);
                }
            }
            if (!hash_equals((string) ($existing['package_proof_hash'] ?? ''), $record['package_proof_hash'])) {
                throw ValidationException::withMessages(['package_proof' => '安装包身份校验失败']);
            }
            $record = $existing;
        } else {
            $this->atomicJson($path, $record);
        }
        return [
            'registered' => true,
            'bridge_version' => self::VERSION,
            ...$this->publicIdentity(),
        ];
    }

    public function signChallenge(string $packageId, string $packageProof, array $challenge): array
    {
        $this->assertPackage($packageId, $packageProof);
        foreach (['id', 'nonce', 'purpose', 'context_hash', 'installation_id', 'expires_at'] as $field) {
            if (!isset($challenge[$field]) || !is_string($challenge[$field]) || $challenge[$field] === '') {
                throw ValidationException::withMessages(['challenge' => "授权挑战缺少 {$field}"]);
            }
        }
        if (!in_array($challenge['purpose'], self::PURPOSES, true)) {
            throw ValidationException::withMessages(['challenge' => '授权挑战用途不受支持']);
        }
        $public = $this->publicIdentity();
        if (!hash_equals($public['installation_id'], $challenge['installation_id'])) {
            throw ValidationException::withMessages(['challenge' => '授权挑战不属于当前服务器']);
        }
        $expires = strtotime($challenge['expires_at']);
        if ($expires === false || $expires < time() - 30 || $expires > time() + 360) {
            throw ValidationException::withMessages(['challenge' => '授权挑战已过期或有效期异常']);
        }
        $message = $this->stableJson([
            'v' => 1,
            'typ' => 'installation-proof',
            'challenge_id' => $challenge['id'],
            'nonce' => $challenge['nonce'],
            'purpose' => $challenge['purpose'],
            'context_hash' => $challenge['context_hash'],
            'installation_id' => $challenge['installation_id'],
            'expires_at' => $challenge['expires_at'],
        ]);
        $secret = base64_decode($this->identity()['secret_key'], true);
        $signature = sodium_crypto_sign_detached($message, $secret);
        return [
            'installation_id' => $public['installation_id'],
            'installation_public_key' => $public['installation_public_key'],
            'challenge_id' => $challenge['id'],
            'challenge_signature' => $this->base64Url($signature),
        ];
    }

    public function readPackageState(string $packageId, string $packageProof): ?array
    {
        $this->assertPackage($packageId, $packageProof);
        return $this->readEncryptedState($packageId);
    }

    public function writePackageState(string $packageId, string $packageProof, array $state): void
    {
        $this->assertPackage($packageId, $packageProof);
        $allowed = array_intersect_key($state, array_flip([
            'install_window_id', 'install_window_token', 'install_window_expires_at',
            'install_receipt_id', 'install_receipt_secret', 'backend_origin',
            'activation_id', 'activation_token', 'refresh_secret', 'denied',
        ]));
        $existing = $this->readEncryptedState($packageId) ?? [];
        $this->saveEncryptedState($packageId, array_merge($existing, $allowed));
    }

    public function runtimePackageState(string $packageId, string $packageProof): ?array
    {
        $this->assertPackage($packageId, $packageProof);
        $state = $this->readEncryptedState($packageId);
        if (!$state) {
            return null;
        }
        return array_intersect_key($state, array_flip([
            'install_window_id', 'install_window_expires_at',
            'backend_origin', 'activation_id', 'activation_token', 'denied',
        ]));
    }

    public function refreshActivation(string $packageId, string $packageProof): array
    {
        $record = $this->assertPackage($packageId, $packageProof);
        $state = $this->readEncryptedState($packageId) ?? [];
        foreach (['activation_id', 'refresh_secret', 'backend_origin'] as $field) {
            if (!isset($state[$field]) || !is_string($state[$field]) || $state[$field] === '') {
                throw ValidationException::withMessages(['activation' => '服务器缺少可刷新的 APPGOG 激活状态']);
            }
        }
        $identity = $this->publicIdentity();
        $context = [
            'activation_id' => $state['activation_id'],
            'domain' => $record['domain'],
            'backend_origin' => $state['backend_origin'],
        ];
        try {
            $challengeResponse = Http::acceptJson()->timeout(15)->post(
                $record['license_server'] . '/api/v1/installation-challenges',
                [
                    'purpose' => 'refresh',
                    'installation_public_key' => $identity['installation_public_key'],
                    'context' => $context,
                ],
            );
        } catch (\Throwable $error) {
            throw new RuntimeException('APPGOG 授权服务器暂时无法连接', 0, $error);
        }
        if (!$challengeResponse->successful()) {
            if ($challengeResponse->serverError()) {
                throw new RuntimeException('APPGOG 授权服务器暂时不可用');
            }
            $state['denied'] = true;
            $state['activation_token'] = null;
            $this->saveEncryptedState($packageId, $state);
            throw ValidationException::withMessages(['activation' => '授权服务器拒绝创建刷新挑战']);
        }
        $challenge = $challengeResponse->json();
        $proof = $this->signChallenge($packageId, $packageProof, $challenge);
        try {
            $refreshResponse = Http::acceptJson()->timeout(15)->post(
                $record['license_server'] . '/api/v1/activations/refresh',
                [
                    'activation_id' => $state['activation_id'],
                    'refresh_secret' => $state['refresh_secret'],
                    'domain' => $record['domain'],
                    'backend_url' => $state['backend_origin'],
                    'installation_id' => $identity['installation_id'],
                    'installation_public_key' => $identity['installation_public_key'],
                    'challenge_id' => $proof['challenge_id'],
                    'challenge_signature' => $proof['challenge_signature'],
                ],
            );
        } catch (\Throwable $error) {
            throw new RuntimeException('APPGOG 授权服务器暂时无法连接', 0, $error);
        }
        if (!$refreshResponse->successful()) {
            if ($refreshResponse->serverError()) {
                throw new RuntimeException('APPGOG 授权服务器暂时不可用');
            }
            $state['denied'] = true;
            $state['activation_token'] = null;
            $this->saveEncryptedState($packageId, $state);
            throw ValidationException::withMessages(['activation' => '授权服务器拒绝刷新当前激活']);
        }
        $state['activation_token'] = $refreshResponse->json('activation_token');
        $state['denied'] = false;
        $this->saveEncryptedState($packageId, $state);
        return [
            'activation_id' => $state['activation_id'],
            'activation_token' => $state['activation_token'],
            'backend_origin' => $state['backend_origin'],
            'expires_at' => $refreshResponse->json('expires_at'),
        ];
    }

    public function deactivateAndRemoveTheme(
        string $packageId,
        string $packageProof,
    ): array
    {
        $record = $this->assertPackage($packageId, $packageProof);
        $state = $this->readEncryptedState($packageId) ?? [];
        foreach (['install_window_id', 'install_window_token'] as $field) {
            if (!isset($state[$field]) || !is_string($state[$field]) || $state[$field] === '') {
                throw ValidationException::withMessages(['install_window' => '服务器缺少可验证的安装激活窗口']);
            }
        }
        try {
            $confirmation = Http::acceptJson()
                ->timeout(15)
                ->post($record['license_server'] . '/api/v1/install-windows/expire', [
                    'install_window_id' => $state['install_window_id'],
                    'install_window_token' => $state['install_window_token'],
                ]);
        } catch (\Throwable $error) {
            throw new RuntimeException('APPGOG 授权服务器暂时无法连接', 0, $error);
        }
        if ($confirmation->serverError()) {
            throw new RuntimeException('APPGOG 授权服务器暂时不可用');
        }
        if (!$confirmation->successful() || $confirmation->json('cleanup_required') !== true
            || $confirmation->json('cleanup_action') !== 'deactivate_and_remove_theme') {
            throw ValidationException::withMessages([
                'install_window_id' => '授权服务器尚未确认主题可以安全清理',
            ]);
        }
        $theme = $record['theme_name'];
        $install = File::exists($this->root . '/installation.json')
            ? (json_decode(File::get($this->root . '/installation.json'), true) ?: []) : [];
        $fallback = $install['previous_theme'] ?? 'Xboard';
        if ($fallback === $theme) {
            $fallback = 'Xboard';
        }
        $themes = app(ThemeService::class);
        if (!$themes->exists($fallback)) {
            $fallback = 'Xboard';
        }
        $themes->switch($fallback);
        if ($themes->exists($theme)) {
            $themes->delete($theme);
        }
        File::delete($this->packagePath($packageId));
        File::delete($this->statePath($packageId));
        Log::warning('APPGOG theme deactivated after activation window expiry', [
            'package_id' => $packageId,
            'theme' => $theme,
            'fallback_theme' => $fallback,
        ]);
        return ['removed' => true, 'theme' => $theme, 'fallback_theme' => $fallback];
    }

    private function assertPackage(string $packageId, string $packageProof): array
    {
        $path = $this->packagePath($packageId);
        $record = File::exists($path) ? json_decode(File::get($path), true) : null;
        if (!is_array($record) || !isset($record['package_proof_hash'])
            || !hash_equals($record['package_proof_hash'], hash('sha256', $packageProof))) {
            throw ValidationException::withMessages(['package_proof' => '安装包尚未注册或身份校验失败']);
        }
        return $record;
    }

    private function normalizeLicenseServer(string $value): string
    {
        $value = rtrim(trim($value), '/');
        $parts = parse_url($value);
        if (!$parts || !isset($parts['scheme'], $parts['host'])
            || isset($parts['user']) || isset($parts['pass']) || isset($parts['query']) || isset($parts['fragment'])
            || !in_array(strtolower($parts['scheme']), ['http', 'https'], true)
            || !in_array($parts['path'] ?? '', ['', '/'], true)) {
            throw ValidationException::withMessages(['license_server' => '授权服务器地址无效']);
        }
        $host = strtolower($parts['host']);
        $local = in_array($host, ['localhost', '127.0.0.1', '::1'], true);
        if (strtolower($parts['scheme']) !== 'https' && !$local) {
            throw ValidationException::withMessages(['license_server' => '生产授权服务器必须使用 HTTPS']);
        }
        $port = isset($parts['port']) ? ':' . $parts['port'] : '';
        $hostText = str_contains($host, ':') ? '[' . trim($host, '[]') . ']' : $host;
        return strtolower($parts['scheme']) . '://' . $hostText . $port;
    }

    private function packagePath(string $packageId): string
    {
        return $this->root . '/packages/' . hash('sha256', $packageId) . '.json';
    }

    private function statePath(string $packageId): string
    {
        return $this->root . '/state/' . hash('sha256', $packageId) . '.json.enc';
    }

    private function readEncryptedState(string $packageId): ?array
    {
        $path = $this->statePath($packageId);
        if (!File::exists($path)) {
            return null;
        }
        $state = json_decode(Crypt::decryptString(File::get($path)), true);
        return is_array($state) ? $state : null;
    }

    private function saveEncryptedState(string $packageId, array $state): void
    {
        $this->atomicWrite(
            $this->statePath($packageId),
            Crypt::encryptString(json_encode($state, JSON_UNESCAPED_SLASHES)),
        );
    }

    private function stableJson(mixed $value): string
    {
        if (!is_array($value)) {
            return json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        }
        if (array_is_list($value)) {
            return '[' . implode(',', array_map(fn ($item) => $this->stableJson($item), $value)) . ']';
        }
        ksort($value, SORT_STRING);
        $items = [];
        foreach ($value as $key => $item) {
            $items[] = json_encode((string) $key) . ':' . $this->stableJson($item);
        }
        return '{' . implode(',', $items) . '}';
    }

    private function base64Url(string $bytes): string
    {
        return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
    }

    private function atomicJson(string $path, array $value): void
    {
        $this->atomicWrite($path, json_encode($value, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    }

    private function atomicWrite(string $path, string $content): void
    {
        $tmp = $path . '.' . bin2hex(random_bytes(6)) . '.tmp';
        File::put($tmp, $content, true);
        @chmod($tmp, 0600);
        if (!@rename($tmp, $path)) {
            File::delete($tmp);
            throw new RuntimeException('无法保存 APPGOG 授权桥状态');
        }
        @chmod($path, 0600);
    }
}
