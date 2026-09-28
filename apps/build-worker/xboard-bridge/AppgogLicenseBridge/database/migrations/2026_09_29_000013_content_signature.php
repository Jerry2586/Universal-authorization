<?php
use Illuminate\Database\Migrations\Migration;
return new class extends Migration {
    public function up(): void {
        require_once dirname(__DIR__,2).'/Services/HostIntegration.php';
        \Plugin\AppgogLicenseBridge\Services\HostIntegration::install();
        require_once dirname(__DIR__,2).'/Services/RuntimeReload.php';
        \Plugin\AppgogLicenseBridge\Services\RuntimeReload::schedule('1.1.6');
    }
    public function down(): void { /* Preserve installation identity, activation and host recovery. */ }
};
