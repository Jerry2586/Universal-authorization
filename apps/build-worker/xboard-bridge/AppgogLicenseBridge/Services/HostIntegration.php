<?php
namespace Plugin\AppgogLicenseBridge\Services;

/** Backed-up Laravel bootstrap registration. All templates are fixed trusted plugin files. */
final class HostIntegration
{
    public static function install(): void
    {
        $root = storage_path('app/private/appgog-host');
        \Illuminate\Support\Facades\File::ensureDirectoryExists($root, 0700, true);
        $lock = fopen($root . '/install.lock', 'c');
        if (!$lock || !flock($lock, LOCK_EX)) throw new \RuntimeException('Cannot lock authorization guard installation');
        try {
            $bootstrap = base_path('bootstrap/app.php');
            $source = file_get_contents($bootstrap);
            if (!is_string($source) || substr_count($source, 'return $app;') !== 1) {
                throw new \RuntimeException('Xboard bootstrap structure unsupported; cannot install authorization guard');
            }
            $guard = file_get_contents(dirname(__DIR__) . '/Host/Guard.php');
            token_get_all($guard, TOKEN_PARSE);
            self::write($root . '/Guard.php', $guard);
            self::write($root . '/admin-entry.js', file_get_contents(dirname(__DIR__) . '/assets/admin-entry.js'));
            if (!str_contains($source, 'APPGOG_HOST_GUARD')) {
                $block = <<<'PHP'
// APPGOG_HOST_GUARD: independent of removable plugin files; native admin remains accessible.
require_once $app->storagePath('app/private/appgog-host/Guard.php');
$app->afterResolving(\Illuminate\Contracts\Http\Kernel::class, static function ($kernel) {
    $kernel->prependMiddleware(\Appgog\Host\Guard::class);
});

PHP;
                $next = str_replace('return $app;', $block . 'return $app;', $source);
                token_get_all($next, TOKEN_PARSE);
                if (!is_file($root . '/bootstrap-original.php')) self::write($root . '/bootstrap-original.php', $source);
                self::write($bootstrap, $next);
            }
            if (function_exists('opcache_invalidate')) {
                opcache_invalidate($bootstrap, true);
                opcache_invalidate($root . '/Guard.php', true);
            }
        } finally { flock($lock, LOCK_UN); fclose($lock); }
    }

    private static function write(string $path, string $content): void
    {
        $temporary = $path . '.appgog-' . bin2hex(random_bytes(5));
        $mode = is_file($path) ? fileperms($path) & 0777 : 0600;
        if (file_put_contents($temporary, $content, LOCK_EX) !== strlen($content)) {
            @unlink($temporary);
            throw new \RuntimeException('Authorization guard installation failed; check file permissions');
        }
        @chmod($temporary, $mode);
        if (!rename($temporary, $path)) {
            @unlink($temporary);
            throw new \RuntimeException('Authorization guard installation failed; check file permissions');
        }
    }
}
