<?php
namespace App\Http\Controllers {class PluginController {public static $denied=false;protected function beforePluginAction(){return self::$denied?[403,'denied']:null;}}}
namespace Illuminate\Support\Facades {class Artisan {public static $available=false;public static $calls=[];public static $status=0;public static function all(){return self::$available?['octane:reload'=>true]:[];}public static function call($command){self::$calls[]=$command;return self::$status;}}}
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
 echo "3 HTTP reload cases passed\n";
}

