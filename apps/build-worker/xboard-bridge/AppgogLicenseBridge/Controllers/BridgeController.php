<?php

namespace Plugin\AppgogLicenseBridge\Controllers;

use App\Http\Controllers\PluginController;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Plugin\AppgogLicenseBridge\Services\BridgeState;

class BridgeController extends PluginController
{
    public function __construct(private readonly BridgeState $bridge)
    {
    }

    public function health(): JsonResponse
    {
        if ($error = $this->beforePluginAction()) {
            return response()->json(['message' => $error[1]], $error[0]);
        }
        return response()->json([
            'ok' => true,
            'code' => 'appgog_license_bridge',
            'version' => '1.0.0',
            'identity' => $this->bridge->publicIdentity(),
        ]);
    }

    public function registerPackage(Request $request): JsonResponse
    {
        if ($error = $this->beforePluginAction()) {
            return response()->json(['message' => $error[1]], $error[0]);
        }
        $payload = $request->validate([
            'product' => ['required', 'string', 'max:100'],
            'build_id' => ['required', 'string', 'max:160'],
            'package_id' => ['required', 'string', 'max:160'],
            'package_proof' => ['required', 'string', 'min:32', 'max:4096'],
            'domain' => ['required', 'string', 'max:253'],
            'theme_name' => ['required', 'string', 'regex:/^[A-Za-z0-9_-]{1,100}$/'],
            'license_server' => ['required', 'url', 'max:2048'],
        ]);
        return response()->json($this->bridge->registerPackage($payload), 201);
    }

    public function signChallenge(Request $request): JsonResponse
    {
        if ($error = $this->beforePluginAction()) {
            return response()->json(['message' => $error[1]], $error[0]);
        }
        $payload = $request->validate([
            'package_id' => ['required', 'string', 'max:160'],
            'package_proof' => ['required', 'string', 'max:4096'],
            'challenge' => ['required', 'array'],
        ]);
        return response()->json($this->bridge->signChallenge(
            $payload['package_id'], $payload['package_proof'], $payload['challenge'],
        ));
    }

    public function readState(Request $request): JsonResponse
    {
        if ($error = $this->beforePluginAction()) {
            return response()->json(['message' => $error[1]], $error[0]);
        }
        $payload = $request->validate([
            'package_id' => ['required', 'string', 'max:160'],
            'package_proof' => ['required', 'string', 'max:4096'],
        ]);
        return response()->json([
            'state' => $this->bridge->readPackageState($payload['package_id'], $payload['package_proof']),
        ]);
    }

    public function runtimeState(Request $request): JsonResponse
    {
        if ($error = $this->beforePluginAction()) {
            return response()->json(['message' => $error[1]], $error[0]);
        }
        $payload = $request->validate([
            'package_id' => ['required', 'string', 'max:160'],
            'package_proof' => ['required', 'string', 'max:4096'],
        ]);
        return response()->json([
            'state' => $this->bridge->runtimePackageState($payload['package_id'], $payload['package_proof']),
        ]);
    }

    public function refreshActivation(Request $request): JsonResponse
    {
        if ($error = $this->beforePluginAction()) {
            return response()->json(['message' => $error[1]], $error[0]);
        }
        $payload = $request->validate([
            'package_id' => ['required', 'string', 'max:160'],
            'package_proof' => ['required', 'string', 'max:4096'],
        ]);
        return response()->json($this->bridge->refreshActivation(
            $payload['package_id'], $payload['package_proof'],
        ));
    }

    public function writeState(Request $request): JsonResponse
    {
        if ($error = $this->beforePluginAction()) {
            return response()->json(['message' => $error[1]], $error[0]);
        }
        $payload = $request->validate([
            'package_id' => ['required', 'string', 'max:160'],
            'package_proof' => ['required', 'string', 'max:4096'],
            'state' => ['required', 'array'],
        ]);
        $this->bridge->writePackageState($payload['package_id'], $payload['package_proof'], $payload['state']);
        return response()->json(['saved' => true]);
    }

    public function deactivateTheme(Request $request): JsonResponse
    {
        if ($error = $this->beforePluginAction()) {
            return response()->json(['message' => $error[1]], $error[0]);
        }
        $payload = $request->validate([
            'package_id' => ['required', 'string', 'max:160'],
            'package_proof' => ['required', 'string', 'max:4096'],
        ]);
        return response()->json($this->bridge->deactivateAndRemoveTheme(
            $payload['package_id'], $payload['package_proof'],
        ));
    }
}
