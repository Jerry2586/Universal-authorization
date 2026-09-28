<?php
namespace Illuminate\Support\Facades {
    class File { public static function ensureDirectoryExists($path, $mode = 0755, $recursive = true) { if (!is_dir($path)) mkdir($path, $mode, $recursive); } }
}
namespace App\Services {
    class ThemeService { public function getThemePath($theme) { return $GLOBALS['themeRoot']; } }
}
namespace {
    $themeRoot = $argv[2]; $privateRoot = $argv[3];
    function storage_path($path = '') { return $GLOBALS['privateRoot'] . '/' . $path; }
    function public_path($path = '') { return $GLOBALS['privateRoot'] . '/public/' . $path; }
    function app($class) { return new $class; }
    require $argv[1];
    $manifest = json_decode(file_get_contents($themeRoot . '/appgog-license/build.json'), true);
    $key = file_get_contents($argv[4]);
    $identity = \Appgog\Host\Guard::payload($manifest['package_manifest_token'], $key);
    $valid = $identity && \Appgog\Host\Guard::contentValid('APPGOG', $manifest, $identity, $key, true);
    $enrolled = false;
    try { \Appgog\Host\Guard::enroll('APPGOG', $manifest); $enrolled = true; } catch (\Throwable $e) {}
    $result = ['content_valid' => (bool)$valid, 'enrolled' => $enrolled];
    if (($argv[5] ?? '') === 'benchmark') {
        $samples = [];
        for ($i = 0; $i < 5; $i++) {
            clearstatcache(true); $started = microtime(true);
            if (!\Appgog\Host\Guard::contentValid('APPGOG', $manifest, $identity, $key, true)) throw new \RuntimeException('Benchmark verification failed');
            $samples[] = round((microtime(true) - $started) * 1000, 2);
        }
        $result['dual_tree_ms'] = $samples;
    }
    echo json_encode($result);
}
