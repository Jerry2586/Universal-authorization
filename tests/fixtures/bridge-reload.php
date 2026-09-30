<?php
namespace Illuminate\Database\Migrations { class Migration {} }
namespace App\Models {
    class Plugin {
        public static $record;
        public static function where($key, $value) { if ($key !== 'code' || $value !== 'appgog_license_bridge') throw new \Exception('Unexpected plugin'); return new self; }
        public function first() { return self::$record; }
    }
}
namespace Illuminate\Support\Facades {
    class Artisan {
        public static $available = true; public static $status = 0; public static $calls = []; public static $fail = false;
        public static function all() { return self::$available ? ['octane:reload' => true] : []; }
        public static function call($command) { self::$calls[] = $command; if (self::$fail) throw new \RuntimeException('sensitive exception text'); return self::$status; }
    }
    class Log {
        public static $messages = [];
        public static function warning($message, $context = []) { self::$messages[] = [$message, $context]; }
        public static function info($message) { self::$messages[] = [$message, []]; }
    }
}
namespace {
    class Application { public $callbacks = []; public function terminating($callback) { $this->callbacks[] = $callback; } }
    $application = new Application;
    function app() { global $application; return $application; }
    function check($ok, $message) { if (!$ok) throw new \RuntimeException($message); }
    $migration = require $argv[1];
    $cases = [
        [null, true, 0, false, 0],
        [(object)['version'=>'1.0.1','is_enabled'=>true], true, 0, false, 0],
        [(object)['version'=>'1.0.2','is_enabled'=>false], true, 0, false, 0],
        [(object)['version'=>'1.0.2','is_enabled'=>true], false, 0, false, 0],
        [(object)['version'=>'1.0.2','is_enabled'=>true], true, 0, false, 1],
        [(object)['version'=>'1.0.2','is_enabled'=>true], true, 1, false, 1],
        [(object)['version'=>'1.0.2','is_enabled'=>true], true, 0, true, 1],
    ];
    foreach ($cases as [$record,$available,$status,$fail,$calls]) {
        $application->callbacks=[]; \App\Models\Plugin::$record=$record;
        \Illuminate\Support\Facades\Artisan::$available=$available;
        \Illuminate\Support\Facades\Artisan::$status=$status;
        \Illuminate\Support\Facades\Artisan::$fail=$fail;
        \Illuminate\Support\Facades\Artisan::$calls=[];
        \Illuminate\Support\Facades\Log::$messages=[];
        $before=serialize($record);
        $migration->up();
        check(count(\Illuminate\Support\Facades\Artisan::$calls)===0,'Reload must not happen inside upgrade');
        check(count($application->callbacks)===1,'One deferred callback');
        ($application->callbacks[0])();
        check(count(\Illuminate\Support\Facades\Artisan::$calls)===$calls,'Unexpected reload count');
        check(serialize(\App\Models\Plugin::$record)===$before,'Plugin record must not change');
        check(!str_contains(json_encode(\Illuminate\Support\Facades\Log::$messages),'sensitive exception text'),'Do not leak exception messages');
        foreach(\Illuminate\Support\Facades\Artisan::$calls as $call) check($call==='octane:reload','Only fixed official command allowed');
        if($status===1) check(str_contains(json_encode(\Illuminate\Support\Facades\Log::$messages),'unavailable'),'Nonzero reload is visible');
    }
    $application->callbacks=[]; \App\Models\Plugin::$record=null;
    \Illuminate\Support\Facades\Artisan::$available=true;
    \Illuminate\Support\Facades\Artisan::$status=0;
    \Illuminate\Support\Facades\Artisan::$fail=false;
    \Illuminate\Support\Facades\Artisan::$calls=[];
    \Plugin\AppgogLicenseBridge\Services\RuntimeReload::scheduleRemoval();
    check(count($application->callbacks)===1,'Removal reload must be deferred');
    ($application->callbacks[0])();
    check(\Illuminate\Support\Facades\Artisan::$calls===['octane:reload'],'Removal reload must not require an installed plugin record');
    echo "8 bridge reload cases passed\n";
}
