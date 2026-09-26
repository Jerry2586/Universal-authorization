<?php

namespace Plugin\AppgogLicenseBridge\Middleware;

use Closure;
use Illuminate\Http\Request;

/** Extend the Xboard admin response without editing core assets or theme settings. */
final class AdminActivationEntry
{
    public function handle(Request $request, Closure $next)
    {
        $response = $next($request);
        $path = admin_setting('secure_path', admin_setting('frontend_admin_path', hash('crc32b', config('app.key'))));
        if ($request->method() !== 'GET' || trim($request->path(), '/') !== trim($path, '/')
            || $response->getStatusCode() !== 200 || !str_contains($response->headers->get('Content-Type', ''), 'text/html')) return $response;
        $html = $response->getContent();
        if (!is_string($html) || str_contains($html, 'data-appgog-admin-entry')) return $response;
        $script = file_get_contents(dirname(__DIR__) . '/assets/admin-entry.js');
        if ($script === false) return $response;
        $html = str_replace('</body>', '<script data-appgog-admin-entry>' . $script . '</script></body>', $html);
        $response->setContent($html);
        $response->headers->remove('Content-Length');
        return $response;
    }
}
