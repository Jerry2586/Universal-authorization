<?php

namespace Plugin\AppgogLicenseBridge\Providers;

use Illuminate\Support\ServiceProvider;
use Plugin\AppgogLicenseBridge\Services\BridgeState;

class PluginServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        $this->app['events']->listen(\Illuminate\Foundation\Http\Events\RequestHandled::class, static function ($event): void {
            // Plugins boot inside Xboard middleware, after the current pipeline was built.
            // Decorate the response event instead of mutating a future request's middleware stack.
            try {
                // An Octane response listener can outlive disabled/deleted plugin files.
                if (!class_exists(\Plugin\AppgogLicenseBridge\Middleware\AdminActivationEntry::class)) return;
                (new \Plugin\AppgogLicenseBridge\Middleware\AdminActivationEntry())->handle(
                    $event->request, static fn () => $event->response
                );
            } catch (\Throwable $error) {
                try { \Illuminate\Support\Facades\Log::warning('APPGOG admin response extension skipped', ['error_type' => get_class($error)]); }
                catch (\Throwable $loggingError) { /* Preserve the native response. */ }
            }
        });
    }

    public function register(): void
    {
        $this->app->singleton(BridgeState::class, fn () => new BridgeState());
    }
}
