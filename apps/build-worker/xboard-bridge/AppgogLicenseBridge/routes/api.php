<?php

use Illuminate\Support\Facades\Route;
use Plugin\AppgogLicenseBridge\Controllers\BridgeController;

Route::prefix('api/v1/appgog-license-bridge')->middleware('throttle:30,1')->group(function (): void {
    Route::get('/health', [BridgeController::class, 'health']);
    Route::post('/state/runtime', [BridgeController::class, 'runtimeState']);
    Route::post('/refresh', [BridgeController::class, 'refreshActivation']);
    Route::post('/deactivate-theme', [BridgeController::class, 'deactivateTheme'])->middleware('admin');
    Route::middleware('admin')->group(function (): void {
        Route::get('/admin-context', [BridgeController::class, 'adminContext']);
        Route::post('/register', [BridgeController::class, 'registerPackage']);
        Route::post('/sign-challenge', [BridgeController::class, 'signChallenge']);
        Route::post('/state/read', [BridgeController::class, 'readState']);
        Route::post('/state/write', [BridgeController::class, 'writeState']);
    });
});
