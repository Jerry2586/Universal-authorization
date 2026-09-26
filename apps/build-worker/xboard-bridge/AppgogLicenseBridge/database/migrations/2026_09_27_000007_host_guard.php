<?php
use Illuminate\Database\Migrations\Migration;
return new class extends Migration {
    public function up(): void {
        require_once dirname(__DIR__,2).'/Services/HostIntegration.php';
        \Plugin\AppgogLicenseBridge\Services\HostIntegration::install();
        require_once dirname(__DIR__,2).'/Services/RuntimeReload.php';
        \Plugin\AppgogLicenseBridge\Services\RuntimeReload::schedule('1.1.0');
    }
    public function down(): void { /* Keep host protection and all customer data on plugin removal. */ }
};
