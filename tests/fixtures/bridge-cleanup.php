<?php
// Execute the production BridgeState against deterministic filesystem/HTTP/theme adapters.
namespace Illuminate\Support\Facades {
    class File {
        public static function ensureDirectoryExists($p, ...$args) { if (!is_dir($p)) mkdir($p, 0700, true); }
        public static function exists($p) { return file_exists($p); }
        public static function get($p) { return file_get_contents($p); }
        public static function put($p, $v, ...$args) { return file_put_contents($p, $v); }
        public static function delete($p) { return !file_exists($p) || unlink($p); }
        public static function files($p) { return array_map(fn($f) => new \SplFileInfo($f), glob($p . '/*')); }
    }
    class Crypt { public static function encryptString($s) { return base64_encode($s); } public static function decryptString($s) { return base64_decode($s); } }
    class Log { public static function warning(...$args) {} }
    class Http {
        public static int $status = 200;
        public static bool $cleanup = true;
        public static int $calls = 0;
        public static function acceptJson() { return new self; }
        public function timeout($v) { return $this; }
        public function post($url, $body) { self::$calls++; return $this; }
        public function successful() { return self::$status === 200; }
        public function serverError() { return self::$status >= 500; }
        public function json($key) { return $key === 'cleanup_required' ? self::$cleanup : 'deactivate_and_remove_theme'; }
    }
}
namespace Illuminate\Validation { class ValidationException extends \RuntimeException { public static function withMessages($v) { return new self('validation'); } } }
namespace App\Services {
    class ThemeService {
        public array $paths = [];
        public array $deleted = [];
        public array $switched = [];
        public function getThemePath($n) { return $this->paths[$n] ?? null; }
        public function exists($n) { return isset($this->paths[$n]); }
        public function switch($n) { $this->switched[]=$n; $GLOBALS['current']=$n; return true; }
        public function delete($n) { if ($GLOBALS['current']===$n) throw new \RuntimeException('active'); $this->deleted[]=$n; unset($this->paths[$n]); return true; }
    }
}
namespace {
    use Plugin\AppgogLicenseBridge\Services\BridgeState;
    use Illuminate\Support\Facades\Http;
    function storage_path($p) { return $GLOBALS['test_root'].'/'.$p; }
    function admin_setting($p) { return $GLOBALS['current']; }
    function app($class) { return $GLOBALS['themes']; }
    function check($condition, $message) { if (!$condition) throw new \RuntimeException($message); }
    require $argv[1];
    $GLOBALS['test_root'] = $argv[2];
    function fixture($case, $manifestPackage='pkg-old', $active='APPGOG', $activated=false, $future=false) {
        $GLOBALS['test_root']=$GLOBALS['base'].'/'.$case;
        $GLOBALS['current']=$active;
        $themes=$GLOBALS['themes']=new \App\Services\ThemeService;
        $bridge=new BridgeState;
        $root=storage_path('app/private/appgog-license-bridge');
        $record=['package_id'=>'pkg-old','build_id'=>'build-old','product'=>'appgog','domain'=>'example.com','theme_name'=>'APPGOG','license_server'=>'https://license.example.com','package_proof_hash'=>hash('sha256','proof')];
        $hash=hash('sha256','pkg-old');
        file_put_contents($root.'/packages/'.$hash.'.json',json_encode($record));
        $state=['install_window_id'=>'window','install_window_token'=>'secret','install_window_expires_at'=>gmdate('c',time()+($future?3600:-3600))];
        if ($activated) $state['activation_id']='activation';
        file_put_contents($root.'/state/'.$hash.'.json.enc',base64_encode(json_encode($state)));
        $dir=$GLOBALS['test_root'].'/theme'; mkdir($dir.'/appgog-license',0700,true);
        file_put_contents($dir.'/appgog-license/build.json',json_encode(array_merge($record,['package_id'=>$manifestPackage])));
        $themes->paths=['APPGOG'=>$dir,'Xboard'=>'system','Other'=>'other'];
        Http::$status=200; Http::$cleanup=true; Http::$calls=0;
        return [$bridge,$themes,$root];
    }
    $GLOBALS['base']=$GLOBALS['test_root'];
    [$b,$t,$r]=fixture('expired'); $out=$b->sweepExpiredPackages();
    check($out['removed']===1 && $t->deleted===['APPGOG'] && $t->switched===['Xboard'],'expired package cleanup');
    check($b->sweepExpiredPackages()['checked']===0,'cleanup must be idempotent');
    [$b,$t]=fixture('replaced','pkg-new'); $b->sweepExpiredPackages();
    check($t->deleted===[] && Http::$calls===0,'old scheduled task must preserve replacement');
    $out=$b->deactivateAndRemoveTheme('pkg-old','proof'); check(!$out['removed'] && $t->deleted===[],'manual cleanup preserves replacement');
    [$b,$t]=fixture('other-active','pkg-old','Other'); $b->sweepExpiredPackages();
    check($t->deleted===['APPGOG'] && $t->switched===[],'do not switch unrelated active theme');
    [$b,$t]=fixture('outage'); Http::$status=503; $out=$b->sweepExpiredPackages();
    check($out['failed']===1 && $t->deleted===[] && $t->switched===[],'outage must preserve theme');
    [$b,$t]=fixture('refused'); Http::$cleanup=false; $b->sweepExpiredPackages();
    check($t->deleted===[],'cleanup requires server confirmation');
    [$b,$t]=fixture('activated','pkg-old','APPGOG',true); $b->sweepExpiredPackages();
    check($t->deleted===[] && Http::$calls===0,'activated theme must survive install-window expiry');
    [$b,$t]=fixture('future','pkg-old','APPGOG',false,true); $b->sweepExpiredPackages();
    check($t->deleted===[] && Http::$calls===0,'unexpired theme must survive');
    [$b,$t]=fixture('no-fallback'); unset($t->paths['Xboard']); $b->sweepExpiredPackages();
    check($t->deleted===[] && $t->switched===[],'no fallback must preserve active theme');
    echo "9 bridge cleanup cases passed
";
}
