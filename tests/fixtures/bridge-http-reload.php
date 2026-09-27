<?php
namespace App\Http\Controllers {class PluginController {public static $denied=false;protected function beforePluginAction(){return self::$denied?[403,'denied']:null;}}}
namespace Plugin\AppgogLicenseBridge\Services {class HostIntegration {public static $calls=0;public static $fail=false;public static function install(){self::$calls++;if(self::$fail)throw new \Exception('private-path');}}}
namespace Illuminate\Support\Facades {class Log {public static function warning($message,$context=[]){}} class Artisan {public static $available=false;public static $calls=[];public static $status=0;public static function all(){return self::$available?['octane:reload'=>true]:[];}public static function call($command){self::$calls[]=$command;return self::$status;}}}
namespace Illuminate\Contracts\Console {interface Kernel {}}
namespace Laravel\Octane\Commands {class ReloadCommand {}}
namespace {
 class Kernel {public function registerCommand($command){if(!$command instanceof \Laravel\Octane\Commands\ReloadCommand)throw new \Exception('Unexpected command');\Illuminate\Support\Facades\Artisan::$available=true;}}
 function app($class){return $class===\Illuminate\Contracts\Console\Kernel::class?new Kernel:new $class;}
 function response(){return new class {public function json($data,$status=200){return ['data'=>$data,'status'=>$status];}};}
 require $argv[1];
 $controller=new \Plugin\AppgogLicenseBridge\Controllers\RuntimeMaintenanceController;
 $result=$controller->reload();
 if(!$result['data']['ok']||$result['data']['mode']!=='octane'||\Illuminate\Support\Facades\Artisan::$calls!==['octane:reload'])throw new \Exception('HTTP command was not registered and called');
 \Illuminate\Support\Facades\Artisan::$status=1;$result=$controller->reload();if($result['status']!==503)throw new \Exception('Failure must be visible');
 \App\Http\Controllers\PluginController::$denied=true;$count=count(\Illuminate\Support\Facades\Artisan::$calls);$result=$controller->reload();if($result['status']!==403||count(\Illuminate\Support\Facades\Artisan::$calls)!==$count)throw new \Exception('Disabled plugin must not reload');
 \App\Http\Controllers\PluginController::$denied=false;\Illuminate\Support\Facades\Artisan::$status=0;
 $result=$controller->repair();$result=$controller->repair();
 if(!$result['data']['ok']||\Plugin\AppgogLicenseBridge\Services\HostIntegration::$calls!==2)throw new \Exception('Repair not repeatable');
 \Plugin\AppgogLicenseBridge\Services\HostIntegration::$fail=true;$result=$controller->repair();if($result['status']!==503||str_contains(json_encode($result),'private-path'))throw new \Exception('Repair failure not sanitized');
 \App\Http\Controllers\PluginController::$denied=true;$count=\Plugin\AppgogLicenseBridge\Services\HostIntegration::$calls;$result=$controller->repair();if($result['status']!==403||\Plugin\AppgogLicenseBridge\Services\HostIntegration::$calls!==$count)throw new \Exception('Disabled bridge repaired');
 echo "3 HTTP reload cases passed; 3 repair cases passed\n";
}

