<?php

namespace Plugin\AppgogLicenseBridge;

use App\Services\Plugin\AbstractPlugin;
use Plugin\AppgogLicenseBridge\Services\BridgeState;

class Plugin extends AbstractPlugin
{
    public function install(): void
    {
        if (!extension_loaded('sodium')) {
            throw new \RuntimeException('APPGOG License Bridge requires the PHP sodium extension');
        }
        \Plugin\AppgogLicenseBridge\Services\HostIntegration::install();
        $bridge = new BridgeState();
        $bridge->rememberThemeBeforeAppgog();
        $bridge->identity();
    }

    public function cleanup(): void
    {
        // Xboard calls cleanup() on disable too. Only remove persisted integration
        // after the host has actually removed the plugin record.
        \Plugin\AppgogLicenseBridge\Services\HostIntegration::scheduleRemovalIfUninstalled();
    }

    public function schedule(\Illuminate\Console\Scheduling\Schedule $schedule): void
    {
        $schedule->call(fn () => (new BridgeState())->sweepExpiredPackages())
            ->name('appgog-license-bridge-expiry')->everyMinute()->withoutOverlapping(10);
    }

    public function boot(): void
    {
        $this->filter('guest_comm_config', function (array $config): array {
            $config['appgog_license_bridge'] = [
                'installed' => true,
                'version' => '1.1.10',
            ];
            return $config;
        });
    }
}
