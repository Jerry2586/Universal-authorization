<?php

namespace Plugin\AppgogLicenseBridge\Providers;

use Illuminate\Support\ServiceProvider;
use Plugin\AppgogLicenseBridge\Services\BridgeState;

class PluginServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        $this->app->make(\Illuminate\Contracts\Http\Kernel::class)->pushMiddleware(
            \Plugin\AppgogLicenseBridge\Middleware\AdminActivationEntry::class
        );
    }

    public function register(): void
    {
        $this->app->singleton(BridgeState::class, fn () => new BridgeState());
    }
}
