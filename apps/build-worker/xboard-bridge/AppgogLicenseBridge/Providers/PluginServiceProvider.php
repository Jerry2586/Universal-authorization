<?php

namespace Plugin\AppgogLicenseBridge\Providers;

use Illuminate\Support\ServiceProvider;
use Plugin\AppgogLicenseBridge\Services\BridgeState;

class PluginServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(BridgeState::class, fn () => new BridgeState());
    }
}
