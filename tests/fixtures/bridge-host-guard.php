<?php
namespace Illuminate\Support\Facades {
    class File {
        public static function ensureDirectoryExists($path, $mode=0755, $recursive=true) { if (!is_dir($path)) mkdir($path,$mode,$recursive); }
        public static function copyDirectory($from,$to) { self::ensureDirectoryExists($to); foreach(scandir($from) as $name) { if($name==='.'||$name==='..')continue; if(is_dir($from.'/'.$name))self::copyDirectory($from.'/'.$name,$to.'/'.$name);else copy($from.'/'.$name,$to.'/'.$name); } return true; }
    }
    class Crypt { public static function encryptString($value){return base64_encode($value);} public static function decryptString($value){return base64_decode($value,true);} }
    class Log { public static function error(...$args){} }
}
namespace Illuminate\Database\Migrations { class Migration {} }
namespace App\Models {
    class Plugin { public static $enabled=true; public static function where(...$args){return new self;} public function first(){return (object)['is_enabled'=>self::$enabled];} }
}
namespace App\Services {
    class ThemeService {
        public function getThemePath($name){return storage_path('theme/'.$name);}
        public function getList(){return ['APPGOG'=>['name'=>'APPGOG']];}
    }
}
namespace {
    $root=$argv[2];
    function storage_path($path=''){global $root;return $root.'/storage/'.$path;}
    function base_path($path=''){global $root;return $root.'/'.$path;}
    function public_path($path=''){return base_path('public/'.$path);}
    function app($class=null){if($class)return new $class;return new class {public function terminating($callback){$GLOBALS['reloadCallbacks'][]=$callback;}};}
    function admin_setting($key,$default=null){return ['secure_path'=>'secure','frontend_theme'=>'APPGOG'][$key]??$default;}
    function config($key){return 'fixture-only';}
    class Headers {public function __construct(public $type='text/html'){} public function get($key,$default=''){return $this->type;}public function remove($key){} }
    class Response {public $headers; public function __construct(public $body='',public $status=200){$this->headers=new Headers;}public function header(...$args){return $this;}public function json($body,$status=200){return new self(json_encode($body),$status);}public function getStatusCode(){return $this->status;}public function getContent(){return $this->body;}public function setContent($body){$this->body=$body;}}
    function response($body='',$status=200){return new Response($body,$status);}
    class Request {public function __construct(public $route,public $input=[],public $host='demo.example.com',public $verb='POST'){}public function path(){return $this->route;}public function input($name){return $this->input[$name]??null;}public function getHost(){return $this->host;}public function method(){return $this->verb;}}
    function check($truth,$message){if(!$truth)throw new \RuntimeException($message);$GLOBALS['cases']++;}
    function write($path,$value){\Illuminate\Support\Facades\File::ensureDirectoryExists(dirname($path));file_put_contents($path,$value);}
    function b64($bytes){return rtrim(strtr(base64_encode($bytes),'+/','-_'),'=');}
    function token($payload,$secret){$text=b64(json_encode(['alg'=>'EdDSA','typ'=>'APPGOG-ACT','v'=>1])).'.'.b64(json_encode($payload));return $text.'.'.b64(sodium_crypto_sign_detached($text,$secret));}
    function pem($raw){return "-----BEGIN PUBLIC KEY-----\n".base64_encode(hex2bin('302a300506032b6570032100').$raw)."\n-----END PUBLIC KEY-----\n";}
    $cases=0;
    write(base_path('bootstrap/app.php'), '<?php $app = new stdClass; return $app;');
    $original=file_get_contents(base_path('bootstrap/app.php'));
    require $argv[1].'/Services/HostIntegration.php';
    \Plugin\AppgogLicenseBridge\Services\HostIntegration::install();
    $installed=file_get_contents(base_path('bootstrap/app.php'));
    check(substr_count($installed,'APPGOG_HOST_GUARD')===1,'bootstrap registration missing');
    check(file_get_contents(storage_path('app/private/appgog-host/bootstrap-original.php'))===$original,'bootstrap backup altered');
    \Plugin\AppgogLicenseBridge\Services\HostIntegration::install();
    check(file_get_contents(base_path('bootstrap/app.php'))===$installed,'non-idempotent install');
    check(file_get_contents(storage_path('app/private/appgog-host/bootstrap-original.php'))===$original,'original backup overwritten');
    write(base_path('bootstrap/app.php'),'<?php return new stdClass;');
    try {\Plugin\AppgogLicenseBridge\Services\HostIntegration::install();throw new \RuntimeException('unsupported accepted');}catch(\RuntimeException $e){check(str_contains($e->getMessage(),'unsupported'),'unsupported bootstrap not rejected');}
    check(file_get_contents(base_path('bootstrap/app.php'))==='<?php return new stdClass;','unsupported bootstrap changed');
    write(base_path('bootstrap/app.php'),$installed);
    require storage_path('app/private/appgog-host/Guard.php');
    $pair=sodium_crypto_sign_keypair();$secret=sodium_crypto_sign_secretkey($pair);$public=sodium_crypto_sign_publickey($pair);
    $identity=sodium_crypto_sign_keypair();$ipublic=sodium_crypto_sign_publickey($identity);
    $iid='ins_'.b64(hash('sha256',hex2bin('302a300506032b6570032100').$ipublic,true));
    $m=['schema'=>2,'product'=>'appgog','build_id'=>'build-fixture','package_id'=>'package-fixture','domain'=>'demo.example.com','version'=>'1.2.3','verification_keys'=>['activation'=>pem($public),'package'=>pem($public)]];
    $m['package_manifest_token']=token(['typ'=>'package-manifest']+$m,$secret);
    $manifestPath=storage_path('theme/APPGOG/appgog-license/build.json');write($manifestPath,json_encode($m));
    \Appgog\Host\Guard::enroll('APPGOG',$m);
    write(base_path('plugins/AppgogLicenseBridge/Plugin.php'),'<?php /* fixture */');
    $statePath=storage_path('app/private/appgog-license-bridge/state/'.hash('sha256',$m['package_id']).'.json.enc');
    write(storage_path('app/private/appgog-license-bridge/identity.json.enc'),base64_encode(json_encode(['public_key'=>base64_encode($ipublic)])));
    $claims=['typ'=>'activation','product'=>'appgog','build_id'=>$m['build_id'],'package_id'=>$m['package_id'],'domain'=>$m['domain'],'installation_id'=>$iid,'backend_origin'=>'https://demo.example.com','exp'=>time()+60,'offline_until'=>time()+120];
    $state=['activation_id'=>'act-fixture','activation_token'=>token($claims,$secret),'backend_origin'=>'https://demo.example.com'];
    $save=function($s)use($statePath){write($statePath,base64_encode(json_encode($s)));};$save($state);
    check(\Appgog\Host\Guard::licensed('APPGOG','demo.example.com'),'valid signed activation rejected');
    check(\Appgog\Host\Guard::licensed('APPGOG','www.demo.example.com'),'domain normalization rejected');
    $guard=new \Appgog\Host\Guard;
    $request=function($path,$body=[],$host='demo.example.com',$verb='POST')use($guard){return $guard->handle(new Request($path,$body,$host,$verb),fn()=>new Response('<body>native admin</body>'));};
    check($request('api/v2/secure/theme/saveThemeConfig',['name'=>'APPGOG'])->status===200,'valid editor save blocked');
    foreach(['missing-plugin','disabled','denied','tampered','expired','wrong-installation'] as $case){
        $bad=$state;
        if($case==='missing-plugin')unlink(base_path('plugins/AppgogLicenseBridge/Plugin.php'));
        if($case==='disabled')\App\Models\Plugin::$enabled=false;
        if($case==='denied')$bad['denied']=true;
        if($case==='tampered')$bad['activation_token'].='x';
        if($case==='expired')$bad['activation_token']=token(array_replace($claims,['exp'=>time()-120,'offline_until'=>time()-1]),$secret);
        if($case==='wrong-installation')$bad['activation_token']=token(array_replace($claims,['installation_id'=>'copied-server']),$secret);
        $save($bad);
        check($request('api/v2/secure/theme/saveThemeConfig',['name'=>'APPGOG'])->status===423,$case.' save permitted');
        check($request('api/v2/secure/config/save',['frontend_theme'=>'APPGOG'])->status===423,$case.' enable permitted');
        check($request('',[], 'demo.example.com','GET')->status===423,$case.' visitor permitted');
        check($request('secure',[], 'demo.example.com','GET')->status===200,$case.' native recovery blocked');
        $save($state);\App\Models\Plugin::$enabled=true;write(base_path('plugins/AppgogLicenseBridge/Plugin.php'),'<?php');
    }
    check($request('api/v2/secure/theme/getThemeConfig',['name'=>'APPGOG'],'other.example.com')->status===423,'domain copied');
    $save(array_replace($state,['activation_token'=>token(array_replace($claims,['capabilities'=>['settings:read']]),$secret)]));
    check($request('api/v2/secure/theme/getThemeConfig',['name'=>'APPGOG'])->status===200,'read capability lost');
    check($request('api/v2/secure/theme/saveThemeConfig',['name'=>'APPGOG'])->status===423,'write capability bypass');$save($state);
    unlink($manifestPath);
    check($request('api/v2/secure/theme/saveThemeConfig',['name'=>'APPGOG'])->status===423,'removed manifest bypass');
    write(storage_path('theme/Legacy/appgog-license/build.json'),json_encode(['schema'=>2]));
    check($request('api/v2/secure/theme/saveThemeConfig',['name'=>'Legacy'])->status===200,'legacy upgrade unexpectedly locked');
    check($request('api/v2/secure/theme/saveThemeConfig',['name'=>'Xboard'])->status===200,'unrelated theme blocked');
    $native=$request('secure',[],'demo.example.com','GET');
    check(substr_count($native->body,'data-appgog-admin-entry')===1,'recovery script absent');
    write($manifestPath,json_encode($m));
    $upload=$request('api/v2/secure/theme/upload');
    check($upload->status===200 && is_file(public_path('theme/APPGOG/appgog-license/build.json')),'activation assets not published');
    // A replayed public token must not change the persisted identity or customer settings.
    check(json_decode(base64_decode(file_get_contents(storage_path('app/private/appgog-license-bridge/identity.json.enc'))),true)['public_key']===base64_encode($ipublic),'identity changed');
    // Replay an installed 1.1.0 host layout: migration must refresh both persisted files,
    // preserve the original bootstrap and identity, and schedule a post-commit reload.
    $identityPath=storage_path('app/private/appgog-license-bridge/identity.json.enc');
    $identityBefore=file_get_contents($identityPath);
    $stateBefore=file_get_contents($statePath);
    $enrollmentPath=storage_path('app/private/appgog-host/themes/APPGOG.json');
    $enrollmentBefore=file_get_contents($enrollmentPath);
    write(storage_path('app/private/appgog-host/Guard.php'),'<?php /* old guard */');
    write(storage_path('app/private/appgog-host/admin-entry.js'),'/* old admin */');
    $migration=require $argv[1].'/database/migrations/2026_09_27_000008_admin_recovery.php';
    $migration->up();$migration->up();
    check(file_get_contents(storage_path('app/private/appgog-host/Guard.php'))===file_get_contents($argv[1].'/Host/Guard.php'),'guard upgrade not persisted');
    check(file_get_contents(storage_path('app/private/appgog-host/admin-entry.js'))===file_get_contents($argv[1].'/assets/admin-entry.js'),'admin upgrade not persisted');
    check(file_get_contents($identityPath)===$identityBefore,'upgrade changed identity');
    check(file_get_contents($statePath)===$stateBefore,'upgrade changed activation');
    check(file_get_contents($enrollmentPath)===$enrollmentBefore,'upgrade changed enrollment');
    check(file_get_contents(storage_path('app/private/appgog-host/bootstrap-original.php'))===$original,'upgrade changed recovery backup');
    check(file_get_contents(base_path('bootstrap/app.php'))===$installed,'upgrade changed host registration');
    check(count($GLOBALS['reloadCallbacks'])===2,'upgrade did not schedule runtime reload');
    echo "$cases host guard cases passed\n";
}
