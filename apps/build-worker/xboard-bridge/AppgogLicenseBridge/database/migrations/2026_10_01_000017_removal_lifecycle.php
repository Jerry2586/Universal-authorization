<?php
use Illuminate\Database\Migrations\Migration;
return new class extends Migration {
    public function up(): void {
        require_once dirname(__DIR__,2).'/Services/HostIntegration.php';
        \Plugin\AppgogLicenseBridge\Services\HostIntegration::install();
        require_once dirname(__DIR__,2).'/Services/RuntimeReload.php';
        \Plugin\AppgogLicenseBridge\Services\RuntimeReload::schedule('1.1.10');
    }
    public function down(): void {
        require_once dirname(__DIR__,2).'/Services/HostIntegration.php';
        \Plugin\AppgogLicenseBridge\Services\HostIntegration::uninstall();
        require_once dirname(__DIR__,2).'/Services/RuntimeReload.php';
        \Plugin\AppgogLicenseBridge\Services\RuntimeReload::scheduleRemoval();
    }
};
