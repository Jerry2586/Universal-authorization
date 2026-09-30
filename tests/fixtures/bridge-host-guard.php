<?php
namespace Illuminate\Support\Facades {
    class File {
        public static function ensureDirectoryExists($path, $mode=0755, $recursive=true) { if (!is_dir($path)) mkdir($path,$mode,$recursive); }
        public static function copyDirectory($from,$to) { self::ensureDirectoryExists($to); foreach(scandir($from) as $name) { if($name==='.'||$name==='..')continue; if(is_dir($from.'/'.$name))self::copyDirectory($from.'/'.$name,$to.'/'.$name);else copy($from.'/'.$name,$to.'/'.$name); } return true; }
        public static function delete($path) { return !is_file($path) || unlink($path); }
        public static function deleteDirectory($path) { if(!is_dir($path))return true;foreach(scandir($path) as $name){if($name==='.'||$name==='..')continue;$item=$path.'/'.$name;if(is_dir($item)){if(!self::deleteDirectory($item))return false;}elseif(!unlink($item))return false;}return rmdir($path); }
    }
    class Crypt { public static function encryptString($value){return base64_encode($value);} public static function decryptString($value){return base64_decode($value,true);} }
    class Log { public static function error(...$args){} public static function warning(...$args){} public static function info(...$args){} }
    class Artisan { public static $calls=[]; public static function all(){return ['octane:reload'=>true];} public static function call($name){self::$calls[]=$name;return 0;} }
}
namespace Illuminate\Database\Migrations { class Migration {} }
namespace App\Models {
    class Plugin { public static $enabled=true; public static $present=true; public static function where(...$args){return new self;} public function first(){return self::$present ? (object)['is_enabled'=>self::$enabled] : null;} }
}
namespace App\Services\Plugin { abstract class AbstractPlugin {} }
namespace App\Services {
    class ThemeService {
        public function getThemePath($name){return storage_path('theme/'.$name);}
        public function getList(){return ['APPGOG'=>['name'=>'APPGOG'],'Xboard'=>['name'=>'Xboard']];}
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
    class Headers {public function __construct(public $type='text/html'){} public function get($key,$default=''){return $this->type;}public function remove($key){}public function set($key,$value){$this->values[$key]=$value;}public $values=[]; }
    class Response {public $headers; public function __construct(public $body='',public $status=200){$this->headers=new Headers;}public function header(...$args){return $this;}public function json($body,$status=200){return new self(json_encode($body),$status);}public function getStatusCode(){return $this->status;}public function getContent(){return $this->body;}public function setContent($body){$this->body=$body;}}
    function response($body='',$status=200){return new Response($body,$status);}
    class Upload {public function __construct(public $filename){}public function path(){return $this->filename;}}
    class Request {public function __construct(public $route,public $input=[],public $host='demo.example.com',public $verb='POST',public $upload=null){}public function path(){return $this->route;}public function input($name){return $this->input[$name]??null;}public function file($name){return $name==='file'?$this->upload:null;}public function getHost(){return $this->host;}public function method(){return $this->verb;}}
    function check($truth,$message){if(!$truth)throw new \RuntimeException($message);$GLOBALS['cases']++;}
    function write($path,$value){\Illuminate\Support\Facades\File::ensureDirectoryExists(dirname($path));file_put_contents($path,$value);}
    function b64($bytes){return rtrim(strtr(base64_encode($bytes),'+/','-_'),'=');}
    function token($payload,$secret){$text=b64(json_encode(['alg'=>'EdDSA','typ'=>'APPGOG-ACT','v'=>1])).'.'.b64(json_encode($payload));return $text.'.'.b64(sodium_crypto_sign_detached($text,$secret));}
    function pem($raw){return "-----BEGIN PUBLIC KEY-----\n".base64_encode(hex2bin('302a300506032b6570032100').$raw)."\n-----END PUBLIC KEY-----\n";}
    function themeZip($path,$name){$zip=new \ZipArchive;check($zip->open($path,\ZipArchive::CREATE|\ZipArchive::OVERWRITE)===true,'fixture zip unavailable');$zip->addFromString($name.'/config.json',json_encode(['name'=>$name,'version'=>'9.9.9']));$zip->addFromString($name.'/dashboard.blade.php','fixture');$zip->close();return new Upload($path);}
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
    $protectedUpload=themeZip(base_path('protected-theme.zip'),'APPGOG');
    $sourceUpload=themeZip(base_path('source-theme.zip'),'APPGOG');
    $otherUpload=themeZip(base_path('other-theme.zip'),'Other');
    $upload=(new \Appgog\Host\Guard)->handle(new Request('api/v2/secure/theme/upload',[], 'demo.example.com','POST',$protectedUpload),fn()=>response()->json(['status'=>'success','data'=>true,'message'=>'uploaded']));
    check($upload->status===200 && is_file(public_path('theme/APPGOG/appgog-license/build.json')),'activation assets not published');
    $uploadPayload=json_decode($upload->body,true);
    check(($uploadPayload['data']??null)===true && ($uploadPayload['message']??'')==='uploaded','native upload fields lost');
    check(($uploadPayload['appgog_activation']??null)===['schema'=>1,'themes'=>[['name'=>'APPGOG','appgog_activation'=>['schema'=>1]]]],'protected theme metadata missing or unrelated theme tagged');
    check(($upload->headers->values['Cache-Control']??'')==='no-store','upload metadata cached');
    unlink($manifestPath);
    $failure=(new \Appgog\Host\Guard)->handle(new Request('api/v1/secure/theme/upload',[],'demo.example.com','POST',$sourceUpload),fn()=>response()->json(['status'=>'fail','message'=>'invalid zip']));
    check(!isset(json_decode($failure->body,true)['appgog_activation']),'failed upload decorated as installed');
    check(\Appgog\Host\Guard::enrolled('APPGOG'),'failed source replacement cleared enrollment');
    $unrelated=(new \Appgog\Host\Guard)->handle(new Request('api/v2/secure/theme/upload',[],'demo.example.com','POST',$otherUpload),fn()=>response()->json(['status'=>'success','data'=>true]));
    check($unrelated->status===200 && \Appgog\Host\Guard::enrolled('APPGOG'),'unrelated source upload cleared APPGOG enrollment');
    check($request('api/v2/secure/theme/saveThemeConfig',['name'=>'APPGOG'])->status===423,'unrelated source upload bypassed gate');
    $source=(new \Appgog\Host\Guard)->handle(new Request('api/v2/secure/theme/upload',[],'demo.example.com','POST',$sourceUpload),fn()=>response()->json(['status'=>'success','data'=>true]));
    check($source->status===200 && !\Appgog\Host\Guard::enrolled('APPGOG'),'successful source replacement kept stale enrollment');
    check($request('api/v2/secure/theme/saveThemeConfig',['name'=>'APPGOG'])->status===200,'source replacement remained authorization-gated');
    write($manifestPath,json_encode($m));
    $beforeUploadState=file_get_contents($statePath);
    unlink($statePath);
    $first=(new \Appgog\Host\Guard)->handle(new Request('api/v1/secure/theme/upload',[],'demo.example.com','POST',$protectedUpload),fn()=>response()->json(['status'=>'success','data'=>true]));
    check($first->status===200 && isset(json_decode($first->body,true)['appgog_activation']),'first upload requires editor registration');
    check(\Appgog\Host\Guard::enrolled('APPGOG'),'protected reupload did not restore enrollment');
    check(!is_file($statePath),'upload granted activation');
    check($request('api/v2/secure/theme/getThemeConfig',['name'=>'APPGOG'])->status===423,'unactivated upload configuration accessible');
    write($statePath,$beforeUploadState);
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
    $singleEntryMigration=require $argv[1].'/database/migrations/2026_09_27_000009_single_activation_entry.php';
    $singleEntryMigration->up();$singleEntryMigration->up();
    $maintenanceMigration=require $argv[1].'/database/migrations/2026_09_28_000010_bridge_maintenance.php';
    $maintenanceMigration->up();$maintenanceMigration->up();
    $layoutMigration=require $argv[1].'/database/migrations/2026_09_28_000011_activation_layout.php';
    $layoutMigration->up();$layoutMigration->up();
    $uploadMigration=require $argv[1].'/database/migrations/2026_09_28_000012_upload_activation_entry.php';
    $uploadMigration->up();$uploadMigration->up();
    check(file_get_contents(storage_path('app/private/appgog-host/Guard.php'))===file_get_contents($argv[1].'/Host/Guard.php'),'guard upgrade not persisted');
    check(file_get_contents(storage_path('app/private/appgog-host/admin-entry.js'))===file_get_contents($argv[1].'/assets/admin-entry.js'),'admin upgrade not persisted');
    check(file_get_contents($identityPath)===$identityBefore,'upgrade changed identity');
    check(file_get_contents($statePath)===$stateBefore,'upgrade changed activation');
    check(file_get_contents($enrollmentPath)===$enrollmentBefore,'upgrade changed enrollment');
    check(file_get_contents(storage_path('app/private/appgog-host/bootstrap-original.php'))===$original,'upgrade changed recovery backup');
    check(file_get_contents(base_path('bootstrap/app.php'))===$installed,'upgrade changed host registration');
    $contentMigration=require $argv[1].'/database/migrations/2026_09_29_000013_content_signature.php';
    $contentMigration->up();$contentMigration->up();
    check(file_get_contents($identityPath)===$identityBefore && file_get_contents($statePath)===$stateBefore,'content seal migration changed identity or activation');
    $generatedProtectionMigration=require $argv[1].'/database/migrations/2026_09_29_000014_generated_js_protection.php';
    $generatedProtectionMigration->up();$generatedProtectionMigration->up();
    check(file_get_contents($identityPath)===$identityBefore && file_get_contents($statePath)===$stateBefore,'generated protection migration changed identity or activation');
    $sourceReplacementMigration=require $argv[1].'/database/migrations/2026_09_30_000015_source_upload_replacement.php';
    $sourceReplacementMigration->up();$sourceReplacementMigration->up();
    check(file_get_contents(storage_path('app/private/appgog-host/Guard.php'))===file_get_contents($argv[1].'/Host/Guard.php'),'source replacement guard upgrade not persisted');
    check(file_get_contents($identityPath)===$identityBefore && file_get_contents($statePath)===$stateBefore,'source replacement migration changed identity or activation');
    check(file_get_contents($enrollmentPath)===$enrollmentBefore,'source replacement migration changed enrollment');
    $uninstallMigration=require $argv[1].'/database/migrations/2026_09_30_000016_bridge_uninstall_cleanup.php';
    $uninstallMigration->up();$uninstallMigration->up();
    check(file_get_contents(storage_path('app/private/appgog-host/Guard.php'))===file_get_contents($argv[1].'/Host/Guard.php'),'uninstall migration guard upgrade not persisted');
    check(file_get_contents($identityPath)===$identityBefore && file_get_contents($statePath)===$stateBefore,'uninstall migration upgrade changed identity or activation');
    check(file_get_contents($enrollmentPath)===$enrollmentBefore,'uninstall migration upgrade changed enrollment');
    check(count($GLOBALS['reloadCallbacks'])===18,'upgrade did not schedule runtime reload');
    $custom='// SITE_CUSTOMIZATION_PRESERVED';
    write(base_path('bootstrap/app.php'),str_replace('return $app;',$custom."\n".'return $app;',file_get_contents(base_path('bootstrap/app.php'))));
    // Production may have an LF bootstrap written by an older Linux release.
    write(base_path('bootstrap/app.php'),str_replace("\r\n","\n",file_get_contents(base_path('bootstrap/app.php'))));
    $uninstallMigration->down();
    check(file_get_contents(base_path('bootstrap/app.php'))===str_replace('return $app;',$custom."\n".'return $app;',$original),'uninstall did not preserve host bootstrap customization');
    check(!is_dir(storage_path('app/private/appgog-host')),'host guard files survived explicit uninstall');
    check(!is_dir(storage_path('app/private/appgog-license-bridge')),'bridge identity or activation survived explicit uninstall');
    check(count($GLOBALS['reloadCallbacks'])===19,'uninstall did not schedule runtime reload');
    $uninstallMigration->down();
    check(!is_dir(storage_path('app/private/appgog-host')) && !is_dir(storage_path('app/private/appgog-license-bridge')),'uninstall is not idempotent');
    check(count($GLOBALS['reloadCallbacks'])===20,'repeat uninstall did not schedule runtime reload');
    // Same still-loaded middleware must no longer gate or decorate after uninstall.
    check($request('api/v2/secure/theme/getThemeConfig',['name'=>'APPGOG'])->status===200,'resident middleware survived uninstall');
    check(!str_contains($request('secure',[],'demo.example.com','GET')->body,'data-appgog-admin-entry'),'uninstalled admin injection survived');
    // The real host invokes cleanup on disable, then deletes the DB record on uninstall.
    require $argv[1].'/Plugin.php';
    $plugin=new \Plugin\AppgogLicenseBridge\Plugin;
    \Plugin\AppgogLicenseBridge\Services\HostIntegration::install();
    write($identityPath,$identityBefore);write($statePath,$stateBefore);write($enrollmentPath,$enrollmentBefore);
    $GLOBALS['reloadCallbacks']=[];\App\Models\Plugin::$enabled=false;
    $plugin->cleanup();
    foreach($GLOBALS['reloadCallbacks'] as $callback)$callback();
    check(file_get_contents($identityPath)===$identityBefore,'disable erased installation identity');
    check(file_get_contents($statePath)===$stateBefore,'disable erased activation');
    check($request('api/v2/secure/theme/getThemeConfig',['name'=>'APPGOG'])->status===423,'disable bypassed guard');
    \App\Models\Plugin::$enabled=true;
    // CRLF must not turn an otherwise identical registration into an uninstall failure.
    $withCrLf=str_replace("\n","\r\n",str_replace("\r\n","\n",file_get_contents(base_path('bootstrap/app.php'))));
    write(base_path('bootstrap/app.php'),$withCrLf);
    $GLOBALS['reloadCallbacks']=[];$plugin->cleanup();\App\Models\Plugin::$present=false;
    foreach($GLOBALS['reloadCallbacks'] as $callback)$callback();
    check(!is_dir(storage_path('app/private/appgog-host')),'cleanup hook did not finish uninstall without migration rollback');
    check(!is_dir(storage_path('app/private/appgog-license-bridge')),'cleanup hook left private identity');
    check(str_contains(file_get_contents(base_path('bootstrap/app.php')),$custom),'CRLF uninstall lost site customization');
    check(in_array('octane:reload',\Illuminate\Support\Facades\Artisan::$calls,true),'cleanup hook did not request reload');
    // Plugin DB record was already removed by an older uninstall: delete still cleans host artifacts.
    write(base_path('bootstrap/app.php'),$original);
    \Plugin\AppgogLicenseBridge\Services\HostIntegration::install();
    write($enrollmentPath,$enrollmentBefore);write($identityPath,$identityBefore);
    $failed=$guard->handle(new Request('api/v2/secure/plugin/delete',['code'=>'appgog_license_bridge']),fn()=>response()->json(['status'=>'fail'],200));
    check(is_file($enrollmentPath),'failed host deletion erased enrollment');
    $unauthorized=$guard->handle(new Request('api/v2/secure/plugin/delete',['code'=>'appgog_license_bridge']),fn()=>response()->json(['status'=>'fail'],401));
    check(is_file($enrollmentPath),'unauthorized request erased enrollment');
    $other=$guard->handle(new Request('api/v2/secure/plugin/delete',['code'=>'other_plugin']),fn()=>response()->json(['status'=>'success']));
    check(is_file($enrollmentPath),'another plugin deletion erased enrollment');
    $removed=$guard->handle(new Request('api/v2/secure/plugin/delete',['code'=>'appgog_license_bridge']),fn()=>response()->json(['message'=>'插件删除成功']));
    check($removed->status===200 && !is_dir(storage_path('app/private/appgog-host')),'successful delete missed orphaned host cleanup');
    check(!is_dir(storage_path('app/private/appgog-license-bridge')),'successful delete retained identity');
    // Match the native uninstall response too, retaining state while a DB record remains.
    \Plugin\AppgogLicenseBridge\Services\HostIntegration::install();
    write($enrollmentPath,$enrollmentBefore);\App\Models\Plugin::$present=true;
    $guard->handle(new Request('api/v2/secure/plugin/uninstall',['code'=>'appgog_license_bridge']),fn()=>response()->json(['message'=>'插件卸载成功']));
    check(is_file($enrollmentPath),'uninstall erased state while plugin record remained');
    \App\Models\Plugin::$present=false;
    $guard->handle(new Request('api/v2/secure/plugin/uninstall',['code'=>'appgog_license_bridge']),fn()=>response()->json(['message'=>'插件卸载失败']));
    check(is_file($enrollmentPath),'failed message erased state');
    $guard->handle(new Request('api/v2/secure/plugin/uninstall',['code'=>'appgog_license_bridge']),fn()=>response()->json(['message'=>'插件卸载成功']));
    check(!is_dir(storage_path('app/private/appgog-host')),'native uninstall response did not clean integration');
    // Replace the protected theme with its same-name ordinary source after removal.
    unlink($manifestPath);
    write(storage_path('theme/APPGOG/config.json'),json_encode(['name'=>'APPGOG','version'=>'1.19.16']));
    write(storage_path('theme/APPGOG/dashboard.blade.php'),'plain original source');
    foreach(['api/v2/secure/theme/getThemeConfig','api/v2/secure/theme/saveThemeConfig'] as $route)
        check($request($route,['name'=>'APPGOG'])->status===200,'same-name ordinary source still asks for activation');
    check($request('api/v2/secure/config/save',['frontend_theme'=>'APPGOG'])->status===200,'ordinary source enable blocked');
    check($request('',[],'demo.example.com','GET')->status===200,'ordinary source homepage blocked');
    check(!str_contains(file_get_contents(base_path('bootstrap/app.php')),'APPGOG_HOST_GUARD'),'restart would register old guard');
    echo "$cases host guard cases passed\n";
}
