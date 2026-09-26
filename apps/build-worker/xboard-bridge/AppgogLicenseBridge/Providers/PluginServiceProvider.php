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
            (new \Plugin\AppgogLicenseBridge\Middleware\AdminActivationEntry())->handle(
                $event->request, static fn () => $event->response
            );
        });
    }

    public function register(): void
    {
        $this->app->singleton(BridgeState::class, fn () => new BridgeState());
    }
}
