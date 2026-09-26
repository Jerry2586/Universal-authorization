<?php

use Illuminate\Database\Migrations\Migration;

return new class extends Migration
{
    public function up(): void
    {
        // A new migration is loaded even when Xboard cached the old Plugin class.
        require_once dirname(__DIR__, 2) . '/Services/RuntimeReload.php';
        \Plugin\AppgogLicenseBridge\Services\RuntimeReload::schedule('1.0.5');
    }

    public function down(): void
    {
        // No database or authorization data is changed by this migration.
    }
};
