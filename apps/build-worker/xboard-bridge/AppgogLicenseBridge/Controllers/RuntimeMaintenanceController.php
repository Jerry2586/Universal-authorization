<?php

namespace Plugin\AppgogLicenseBridge\Controllers;

use App\Http\Controllers\PluginController;
use Illuminate\Support\Facades\Artisan;

final class RuntimeMaintenanceController extends PluginController
{
    /** Restore host registration/scripts from this installed version, preserving private state. */
    public function repair()
    {
        if ($error = $this->beforePluginAction()) return response()->json(['message' => $error[1]], $error[0]);
        try {
            \Plugin\AppgogLicenseBridge\Services\HostIntegration::install();
        } catch (\Throwable $error) {
            \Illuminate\Support\Facades\Log::warning('APPGOG bridge host repair failed', ['error_type' => get_class($error)]);
            return response()->json(['ok' => false, 'message' => '宿主注册修复失败，请检查 Xboard 日志及文件权限'], 503);
        }
        return $this->reload();
    }

    public function reload()
    {
        if ($error = $this->beforePluginAction()) return response()->json(['message' => $error[1]], $error[0]);
        $root = realpath(dirname(__DIR__));
        if ($root !== false && function_exists('opcache_invalidate')) {
            foreach (new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS)) as $file) {
                if (!$file->isLink() && $file->isFile() && $file->getExtension() === 'php') opcache_invalidate($file->getRealPath(), true);
            }
        }
        if (!array_key_exists('octane:reload', Artisan::all()) && class_exists(\Laravel\Octane\Commands\ReloadCommand::class)) {
                    // Octane registers console commands only in CLI mode. Resolve the fixed
                    // official command explicitly for this authenticated HTTP maintenance action.
                    app(\Illuminate\Contracts\Console\Kernel::class)->registerCommand(app(\Laravel\Octane\Commands\ReloadCommand::class));
                }
                if (!array_key_exists('octane:reload', Artisan::all())) return response()->json(['ok' => true, 'mode' => 'php-cache']);
        $status = Artisan::call('octane:reload');
        return response()->json(['ok' => $status === 0, 'mode' => 'octane', 'message' => $status === 0 ? '应用进程重载已请求，请等待健康检查' : '重载失败，请重启 Xboard 应用服务'], $status === 0 ? 200 : 503);
    }
}
