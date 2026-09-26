<?php
namespace Illuminate\Http {
 class Request { public function __construct(public $verb='GET',public $route='secure') {} public function method(){return $this->verb;} public function path(){return $this->route;} }
}
namespace {
 function admin_setting($key,$default=null){return $key==='secure_path'?'secure':$default;}
 function config($key){return 'fixture-only';}
 class Headers {public function __construct(public $type='text/html'){} public function get($key,$default=''){return $this->type;} public function remove($key){} }
 class Response {public $headers;public function __construct(public $html,public $status=200,$type='text/html'){$this->headers=new Headers($type);} public function getStatusCode(){return $this->status;}public function getContent(){return $this->html;}public function setContent($html){$this->html=$html;} }
 require $argv[1];
 $middleware=new \Plugin\AppgogLicenseBridge\Middleware\AdminActivationEntry;
 foreach ([['GET','secure',200,'text/html',true],['POST','secure',200,'text/html',false],['GET','/',200,'text/html',false],['GET','secure',401,'text/html',false],['GET','secure',200,'application/json',false]] as [$verb,$path,$status,$type,$inject]) {
   $r=$middleware->handle(new \Illuminate\Http\Request($verb,$path),fn()=>new Response('<body>fixture</body>',$status,$type));
   if(str_contains($r->html,'data-appgog-admin-entry')!==$inject)throw new \RuntimeException('Incorrect injection boundary');
   if($inject){$twice=$middleware->handle(new \Illuminate\Http\Request,fn()=>$r);if(substr_count($twice->html,'data-appgog-admin-entry')!==1)throw new \RuntimeException('Duplicate entry');}
 }
 echo "6 admin entry cases passed\n";
}
