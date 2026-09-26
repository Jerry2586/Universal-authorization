<?php

use Illuminate\Support\Facades\Route;
use Plugin\AppgogLicenseBridge\Controllers\BridgeController;

// Read-only liveness is independent of authenticated setup mutations. Previews
// and normal visitor refreshes must not exhaust the administrator setup bucket.
Route::prefix('api/v1/appgog-license-bridge')->group(function (): void {
    Route::get('/health', [BridgeController::class, 'health'])->middleware('throttle:240,1,appgog-read-');
    Route::post('/state/runtime', [BridgeController::class, 'runtimeState'])->middleware('throttle:240,1,appgog-read-');
    Route::post('/refresh', [BridgeController::class, 'refreshActivation'])->middleware('throttle:60,1,appgog-action-');
    Route::post('/deactivate-theme', [BridgeController::class, 'deactivateTheme'])->middleware(['admin','throttle:10,1,appgog-cleanup-']);
    Route::middleware('admin')->middleware('throttle:60,1,appgog-admin-')->group(function (): void {
        Route::post('/runtime/reload', [\Plugin\AppgogLicenseBridge\Controllers\RuntimeMaintenanceController::class, 'reload'])->middleware('throttle:2,1,appgog-reload-');
        Route::get('/admin-context', [BridgeController::class, 'adminContext']);
        Route::post('/register', [BridgeController::class, 'registerPackage']);
        Route::post('/sign-challenge', [BridgeController::class, 'signChallenge']);
        Route::post('/state/read', [BridgeController::class, 'readState']);
        Route::post('/state/write', [BridgeController::class, 'writeState']);
    });
});
