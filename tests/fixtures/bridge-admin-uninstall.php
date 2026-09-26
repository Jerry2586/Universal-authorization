<?php
namespace Illuminate\Http {
    class Request {
        public function __construct(public $route='secure') {}
        public function method(){return 'GET';}
        public function path(){return $this->route;}
    }
}
namespace Illuminate\Support\Facades {
    class Log { public static $errors=[]; public static function warning($message,$context=[]){self::$errors[]=$message;} }
}
namespace {
    // Match Laravel: filesystem warnings become exceptions, including response event handlers.
    set_error_handler(static function($level,$message,$file,$line){if(error_reporting()&$level)throw new \ErrorException($message,0,$level,$file,$line);return false;});
    function admin_setting($key,$default=null){return $key==='secure_path'?'secure':$default;}
    function config($key){return 'fixture';}
    class Headers {public function get($key,$default=''){return 'text/html';}public function remove($key){}}
    class Response {public $headers; public function __construct(public $html){$this->headers=new Headers;}public function getStatusCode(){return 200;}public function getContent(){return $this->html;}public function setContent($html){$this->html=$html;}}
    require $argv[1].'/Middleware/AdminActivationEntry.php';
    $middleware=new \Plugin\AppgogLicenseBridge\Middleware\AdminActivationEntry;
    $original='<html><body>Native recovery login</body></html>';
    $response=$middleware->handle(new \Illuminate\Http\Request,fn()=>new Response($original));
    if(!str_contains($response->html,'data-appgog-admin-entry'))throw new \RuntimeException('normal injection absent');
    // Long-running PHP worker retains the handler, but plugin files disappear mid-upgrade/uninstall.
    unlink($argv[1].'/assets/admin-entry.js');
    $response=$middleware->handle(new \Illuminate\Http\Request,fn()=>new Response($original));
    if($response->html!==$original)throw new \RuntimeException('native admin response lost');
    try{$middleware->handle(new \Illuminate\Http\Request,fn()=>throw new \RuntimeException('host-route-error'));throw new \RuntimeException('host exception swallowed');}
    catch(\RuntimeException $e){if($e->getMessage()!=='host-route-error')throw $e;}
    echo "native admin survives removed plugin asset; host failures preserved\n";
}
