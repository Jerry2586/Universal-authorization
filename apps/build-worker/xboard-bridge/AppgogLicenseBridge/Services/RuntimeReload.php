<?php

namespace Plugin\AppgogLicenseBridge\Services;

use App\Models\Plugin;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Log;

/** Reload code only after Xboard has committed and enabled this plugin upgrade. */
final class RuntimeReload
{
    public static function schedule(string $expectedVersion): void
    {
        app()->terminating(static function () use ($expectedVersion): void {
            try {
                $plugin = Plugin::where('code', 'appgog_license_bridge')->first();
                if (!$plugin || !$plugin->is_enabled || version_compare($plugin->version, $expectedVersion, '<')) {
                    Log::warning('APPGOG bridge reload deferred: plugin upgrade is incomplete');
                    return;
                }
                self::reloadRuntime('upgrade');
            } catch (\Throwable $error) {
                // Reload is a post-upgrade side effect, not a reason to roll back business data.
                Log::warning('APPGOG bridge worker reload failed; restart the Xboard application service and verify bridge health', [
                    'error_type' => get_class($error),
                ]);
            }
        });
    }

    public static function scheduleRemoval(): void
    {
        app()->terminating(static function (): void {
            try {
                self::reloadRuntime('removal');
            } catch (\Throwable $error) {
                Log::warning('APPGOG bridge removal reload failed; restart the Xboard application service', [
                    'error_type' => get_class($error),
                ]);
            }
        });
    }

    private static function reloadRuntime(string $context): void
    {
        // Never clear global OPcache. During removal the plugin directory may disappear
        // before this terminating callback runs, so a missing root is expected.
        $root = realpath(dirname(__DIR__));
        if ($root !== false && function_exists('opcache_invalidate')) {
            $files = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS));
            foreach ($files as $file) {
                if (!$file->isLink() && $file->isFile() && $file->getExtension() === 'php') {
                    $path = $file->getRealPath();
                    if ($path !== false && str_starts_with($path, $root . DIRECTORY_SEPARATOR)) opcache_invalidate($path, true);
                }
            }
        }
        if (!array_key_exists('octane:reload', Artisan::all()) && class_exists(\Laravel\Octane\Commands\ReloadCommand::class)) {
            app(\Illuminate\Contracts\Console\Kernel::class)->registerCommand(app(\Laravel\Octane\Commands\ReloadCommand::class));
        }
        if (!array_key_exists('octane:reload', Artisan::all())) {
            Log::info('APPGOG bridge PHP cache refreshed; no Octane command installed');
            return;
        }
        $status = Artisan::call('octane:reload');
        if ($status !== 0) {
            Log::warning($context === 'removal'
                ? 'APPGOG bridge removal reload unavailable; restart the Xboard application service'
                : 'APPGOG bridge worker reload unavailable; restart the Xboard application service and verify bridge health');
            return;
        }
        Log::info($context === 'removal'
            ? 'APPGOG bridge removal reload requested'
            : 'APPGOG bridge worker reload requested; runtime health must confirm the new version');
    }
}
