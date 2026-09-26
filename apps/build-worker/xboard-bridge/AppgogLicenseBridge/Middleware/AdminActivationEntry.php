<?php

namespace Plugin\AppgogLicenseBridge\Middleware;

use Closure;
use Illuminate\Http\Request;

/** Optional admin presentation must never take down the host recovery page. */
final class AdminActivationEntry
{
    public function handle(Request $request, Closure $next)
    {
        // Host failures are not swallowed by the optional APPGOG decorator.
        $response = $next($request);
        try {
            $path = admin_setting('secure_path', admin_setting('frontend_admin_path', hash('crc32b', config('app.key'))));
            if ($request->method() !== 'GET' || trim($request->path(), '/') !== trim($path, '/')
                || $response->getStatusCode() !== 200 || !str_contains($response->headers->get('Content-Type', ''), 'text/html')) return $response;
            $html = $response->getContent();
            if (!is_string($html) || str_contains($html, 'data-appgog-admin-entry')) return $response;
            $asset = dirname(__DIR__) . '/assets/admin-entry.js';
            if (!is_file($asset) || !is_readable($asset)) return $response;
            $script = file_get_contents($asset);
            if ($script === false) return $response;
            $response->setContent(str_replace('</body>', '<script data-appgog-admin-entry>' . $script . '</script></body>', $html));
            $response->headers->remove('Content-Length');
        } catch (\Throwable $error) {
            // A retained Octane listener may outlive files removed by an upload/uninstall.
            // Authorization enforcement belongs to Host Guard, not this UI decoration.
            try { \Illuminate\Support\Facades\Log::warning('APPGOG admin presentation unavailable', ['error_type' => get_class($error)]); }
            catch (\Throwable $loggingError) { /* Recovery must survive an unavailable logger too. */ }
        }
        return $response;
    }
}
