<?php
namespace Illuminate\Support { class ServiceProvider { public $app; } }
namespace Illuminate\Support\Facades { class Log { public static function warning(...$args){} } }
namespace {
    class Events {public $handler;public function listen($event,$handler){$this->handler=$handler;}}
    require $argv[1];
    $events=new Events;
    $provider=new \Plugin\AppgogLicenseBridge\Providers\PluginServiceProvider;
    $provider->app=['events'=>$events];$provider->boot();
    $response=(object)['content'=>'native admin'];
    $event=(object)['request'=>(object)[],'response'=>$response];
    ($events->handler)($event);
    if($event->response!==$response)throw new \RuntimeException('native response replaced');
    spl_autoload_register(static function($class){throw new \Error('plugin autoloader has been removed');});
    ($events->handler)($event);
    if($event->response!==$response)throw new \RuntimeException('autoload failure replaced native response');
    echo "stale provider survives absent middleware and failed autoload\n";
}
