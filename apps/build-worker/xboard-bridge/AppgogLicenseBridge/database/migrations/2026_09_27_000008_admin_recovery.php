<?php
use Illuminate\Database\Migrations\Migration;
return new class extends Migration {
    public function up(): void {
        // Refresh the persisted host copy as well as the removable plugin files.
        require_once dirname(__DIR__,2).'/Services/HostIntegration.php';
        \Plugin\AppgogLicenseBridge\Services\HostIntegration::install();
        require_once dirname(__DIR__,2).'/Services/RuntimeReload.php';
        \Plugin\AppgogLicenseBridge\Services\RuntimeReload::schedule('1.1.1');
    }
    public function down(): void { /* Preserve enrollment, installation identity and recovery protection. */ }
};
