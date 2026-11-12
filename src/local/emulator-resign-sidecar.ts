// The AWS Emulator re-signing sidecar (mixed mode, go-to-k/cdkd#6150).
//
// In mixed mode a workload container holds the developer's REAL AWS identity,
// and only the services its `--env-vars` file routes with the `aws-emulator`
// sentinel go to AWS Emulator. Those requests arrive signed with real keys,
// which the emulator never issued. This sidecar receives them instead,
// throws the signature away, and signs each request again with the
// emulator's own keys before forwarding it, so the emulator keeps its
// signature checking and never sees a real-key signature.
//
// It runs inside the loopback forwarder's container (same image, same
// namespaces; `loopback-forwarder.ts`), as extra code in front of the
// forwarder's `node -e` script, and only when a workload needs it:
//
//   workload --TLS--> 127.0.0.1:<resign port> (this sidecar, per-run CA)
//            --TLS--> 127.0.0.1:<emulator port> (the TCP forwarder) --> host
//
// The upstream TLS is verified against the emulator's CA only (plus the
// public roots for a non-loopback emulator). Real-AWS traffic never reaches
// it: only the sentinel-substituted `AWS_ENDPOINT_URL_<SERVICE>` points here.
//
// What it does to a request:
//   - SigV4 (`AWS4-HMAC-SHA256`, header or presigned query) and SigV4a
//     (`AWS4-ECDSA-P256-SHA256`): the service and region come from the
//     original credential scope (SigV4a: `X-Amz-Region-Set`, else the
//     the host region, else `us-east-1`). Every signing header and presign parameter is
//     dropped, including the real `X-Amz-Security-Token`, and the request is
//     signed again with header auth.
//   - S3 `aws-chunked` bodies (`STREAMING-AWS4-HMAC-SHA256-PAYLOAD`, its
//     `-TRAILER` form, `STREAMING-UNSIGNED-PAYLOAD-TRAILER` and the ECDSA
//     variants) are decoded into a plain body; trailing checksums become
//     ordinary signed headers. The body is buffered to compute its hash, up to
//     a cap: past it the sidecar answers 413 with a message that names the
//     cap and multipart upload.
//   - A request with no signature at all is forwarded unsigned.
//
// It never logs a header, a body, a key or a signature.
//
// The script is plain CommonJS for the container's Node.js (no TypeScript, no
// template literals, so the `${` of this module's own template never
// appears in it). Unit tests load {@link RESIGN_SIDECAR_CORE} as-is through
// `new Function`, so the tested code is the shipped code.

/**
 * The largest request body the sidecar re-signs: 100 MiB.
 *
 * Re-signing needs the whole body (SigV4 signs its SHA-256), so the sidecar
 * holds it in memory. 100 MiB is where AWS itself recommends multipart
 * upload for S3, and every AWS SDK's managed uploader (boto3 `upload_file`,
 * `@aws-sdk/lib-storage`, the Java transfer manager) switches to multipart
 * well below it (5-8 MiB parts by default), so a request over it only comes
 * from a single `PutObject` of a large blob. Every other service's request
 * bodies are far smaller. The cap bounds the sidecar's memory per request.
 */
export const MIXED_MODE_RESIGN_BODY_CAP_BYTES = 100 * 1024 * 1024;

/**
 * Pure helpers: SigV4 signing, `aws-chunked` decoding and request
 * preparation. No I/O. Defines `prepareResign`, `signRequest`,
 * `decodeAwsChunked`, `canonicalPath`, `canonicalQuery`, `splitQuery`,
 * `parseAuthScope`, `isAwsChunked`, `upstreamHeaders` and `tooLargeByHeaders`.
 */
export const RESIGN_SIDECAR_CORE = String.raw`
var crypto=require('crypto');
function sha256hex(b){return crypto.createHash('sha256').update(b).digest('hex');}
function hmac(k,s){return crypto.createHmac('sha256',k).update(s,'utf8').digest();}
function uriEncode(s){return encodeURIComponent(s).replace(/[!'()*]/g,function(c){return '%'+c.charCodeAt(0).toString(16).toUpperCase();});}
function safeDecode(s){try{return decodeURIComponent(s);}catch(e){return s;}}
function canonicalPath(rawPath,service){
  var p=rawPath||'/';
  if(service==='s3')return p;
  var segs=[];
  p.split('/').forEach(function(s){if(s===''||s==='.')return;if(s==='..')segs.pop();else segs.push(s);});
  var n=(p.charAt(0)==='/'?'/':'')+segs.join('/')+(segs.length>0&&p.charAt(p.length-1)==='/'?'/':'');
  return uriEncode(n).replace(/%2F/g,'/');
}
function splitQuery(q){
  if(!q)return [];
  return q.split('&').filter(function(x){return x!=='';}).map(function(part){
    var i=part.indexOf('=');
    return {raw:part,k:safeDecode(i<0?part:part.slice(0,i)),v:i<0?'':safeDecode(part.slice(i+1))};
  });
}
function canonicalQuery(pairs){
  return pairs.map(function(p){return [uriEncode(p.k),uriEncode(p.v)];})
    .sort(function(a,b){return a[0]<b[0]?-1:a[0]>b[0]?1:a[1]<b[1]?-1:a[1]>b[1]?1:0;})
    .map(function(e){return e[0]+'='+e[1];}).join('&');
}
var PRESIGN_PARAMS=new Set(['x-amz-algorithm','x-amz-credential','x-amz-date','x-amz-expires','x-amz-signedheaders','x-amz-signature','x-amz-security-token']);
function parseCredentialScope(algo,credential){
  var parts=String(credential).split('/');
  if(algo==='AWS4-HMAC-SHA256'&&parts.length>=5)return {region:parts[parts.length-3],service:parts[parts.length-2]};
  if(algo==='AWS4-ECDSA-P256-SHA256'&&parts.length>=4)return {service:parts[parts.length-2]};
  return undefined;
}
function parseAuthScope(authorization){
  var m=/^\s*(AWS4-HMAC-SHA256|AWS4-ECDSA-P256-SHA256)\s+(.*)$/.exec(String(authorization));
  if(!m)return undefined;
  var c=/Credential=([^,\s]+)/.exec(m[2]);
  return c?parseCredentialScope(m[1],c[1]):undefined;
}
var DROP_HEADERS=new Set(['authorization','host','connection','keep-alive','proxy-authorization','proxy-connection','te','trailer','transfer-encoding','upgrade','expect','content-length','x-amz-date','x-amz-security-token','x-amz-content-sha256','x-amz-decoded-content-length','x-amz-trailer']);
function upstreamHeaders(incoming){
  var out=Object.create(null);
  Object.keys(incoming).forEach(function(k){var lk=k.toLowerCase();if(DROP_HEADERS.has(lk))return;var v=incoming[k];if(v===undefined)return;out[lk]=Array.isArray(v)?v.join(', '):String(v);});
  return out;
}
function isAwsChunked(headers){
  var sha=String(headers['x-amz-content-sha256']||'');
  return sha.indexOf('STREAMING-')===0||/(^|,)\s*aws-chunked\s*(,|$)/i.test(String(headers['content-encoding']||''));
}
function stripAwsChunked(ce){
  if(!ce)return undefined;
  var rest=String(ce).split(',').map(function(s){return s.trim();}).filter(function(s){return s!==''&&s.toLowerCase()!=='aws-chunked';});
  return rest.length?rest.join(', '):undefined;
}
function decodeAwsChunked(buf){
  var pos=0,parts=[],trailers=Object.create(null);
  for(;;){
    var eol=buf.indexOf('\r\n',pos);
    if(eol<0)throw new Error('aws-chunked body: missing chunk header');
    var size=parseInt(buf.toString('latin1',pos,eol).split(';')[0].trim(),16);
    if(!(size>=0))throw new Error('aws-chunked body: bad chunk size');
    pos=eol+2;
    if(size===0)break;
    if(pos+size+2>buf.length)throw new Error('aws-chunked body: truncated chunk');
    parts.push(buf.subarray(pos,pos+size));
    pos+=size;
    if(buf[pos]!==13||buf[pos+1]!==10)throw new Error('aws-chunked body: missing chunk terminator');
    pos+=2;
  }
  while(pos<buf.length){
    var e=buf.indexOf('\r\n',pos),end=e<0?buf.length:e;
    var line=buf.toString('latin1',pos,end);
    pos=end+2;
    if(line==='')break;
    var c=line.indexOf(':');
    if(c<=0)continue;
    var k=line.slice(0,c).trim().toLowerCase();
    if(k==='x-amz-trailer-signature')continue;
    var v=line.slice(c+1).trim();
    if(!/^[!#$%&'*+.^_|~0-9a-z-]+$/.test(k)||/[^	 -~]/.test(v))throw new Error('aws-chunked body: invalid trailer');
    trailers[k]=v;
  }
  return {body:Buffer.concat(parts),trailers:trailers};
}
function tooLargeByHeaders(headers,cap){
  var decoded=Number(headers['x-amz-decoded-content-length']);
  if(decoded>cap)return decoded;
  var raw=Number(headers['content-length']);
  if(raw>rawCap(cap))return raw;
  return 0;
}
function rawCap(cap){return cap+Math.max(1048576,Math.floor(cap/100));}
function signRequest(o){
  var amzDate=o.now.toISOString().replace(/[:-]|\.\d{3}/g,''),date=amzDate.slice(0,8),h=o.headers;
  h['x-amz-date']=amzDate;
  h['x-amz-content-sha256']=sha256hex(o.body);
  if(o.creds.sessionToken)h['x-amz-security-token']=o.creds.sessionToken;
  var names=Object.keys(h).filter(function(n){return n==='host'||n==='content-type'||n==='content-md5'||n.indexOf('x-amz-')===0;}).sort();
  var canonHeaders=names.map(function(n){return n+':'+String(h[n]).trim().replace(/\s+/g,' ')+'\n';}).join('');
  var signed=names.join(';');
  var creq=[o.method,canonicalPath(o.path,o.service),canonicalQuery(splitQuery(o.query)),canonHeaders,signed,h['x-amz-content-sha256']].join('\n');
  var scope=date+'/'+o.region+'/'+o.service+'/aws4_request';
  var sts=['AWS4-HMAC-SHA256',amzDate,scope,sha256hex(creq)].join('\n');
  var k=hmac(hmac(hmac(hmac('AWS4'+o.creds.secretAccessKey,date),o.region),o.service),'aws4_request');
  var sig=crypto.createHmac('sha256',k).update(sts,'utf8').digest('hex');
  h['authorization']='AWS4-HMAC-SHA256 Credential='+o.creds.accessKeyId+'/'+scope+', SignedHeaders='+signed+', Signature='+sig;
  return h;
}
function prepareResign(req,body,cfg,now){
  var url=String(req.url||'/'),qi=url.indexOf('?');
  var path=qi<0?url:url.slice(0,qi),query=qi<0?'':url.slice(qi+1);
  var incoming=req.headers,scope,signedRequest=false;
  var pairs=splitQuery(query),cred,algo;
  pairs.forEach(function(p){var lk=p.k.toLowerCase();if(lk==='x-amz-credential')cred=p.v;if(lk==='x-amz-algorithm')algo=p.v;});
  // Presign parameters (a real token or signature among them) never go upstream,
  // whether or not the request ALSO carries a header signature.
  query=pairs.filter(function(p){return !PRESIGN_PARAMS.has(p.k.toLowerCase());}).map(function(p){return p.raw;}).join('&');
  if(incoming['authorization']!==undefined){
    signedRequest=true;
    scope=parseAuthScope(incoming['authorization']);
  }else if(cred!==undefined){
    signedRequest=true;
    scope=parseCredentialScope(algo||'AWS4-HMAC-SHA256',cred);
  }
  if(signedRequest&&!scope)return {error:{status:400,code:'IncompleteSignature',message:'cdk-local mixed mode: the request signature has no credential scope the AWS Emulator re-signing sidecar can read.'}};
  var service=scope?scope.service:undefined;
  var headers=upstreamHeaders(incoming);
  if(isAwsChunked(incoming)){
    var decoded;
    try{decoded=decodeAwsChunked(body);}catch(e){return {error:{status:400,code:'IncompleteBody',message:'cdk-local mixed mode: '+e.message+'.'}};}
    body=decoded.body;
    Object.keys(decoded.trailers).forEach(function(k){if(!DROP_HEADERS.has(k))headers[k]=decoded.trailers[k];});
    var ce=stripAwsChunked(headers['content-encoding']);
    if(ce===undefined)delete headers['content-encoding'];else headers['content-encoding']=ce;
  }
  if(body.length>cfg.capBytes)return {error:tooLargeError(body.length,cfg.capBytes,service)};
  headers['host']=cfg.upstreamHost;
  headers['content-length']=String(body.length);
  if(signedRequest){
    var regionSet=incoming['x-amz-region-set'];
    pairs.forEach(function(p){if(p.k.toLowerCase()==='x-amz-region-set'&&regionSet===undefined)regionSet=p.v;});
    var region=scope.region||String(regionSet||'').split(',')[0].trim()||cfg.region||'us-east-1';
    if(region==='*')region=cfg.region||'us-east-1';
    signRequest({method:String(req.method||'GET'),path:path,query:query,headers:headers,body:body,region:region,service:service,creds:cfg.credentials,now:now});
  }
  return {path:query?path+'?'+query:path,headers:headers,body:body,service:service};
}
function tooLargeError(size,cap,service){
  return {status:413,code:service==='s3'?'EntityTooLarge':'RequestEntityTooLargeException',message:'cdk-local mixed mode: the request body ('+size+' bytes) is over the '+cap+'-byte cap of the AWS Emulator re-signing sidecar, which holds a body in memory to sign it. Upload a large S3 object with multipart upload (each part under the cap), e.g. boto3 upload_file or @aws-sdk/lib-storage.'};
}
function errorBody(err,service){
  if(service==='s3'||service===undefined)return {type:'application/xml',text:'<?xml version="1.0" encoding="UTF-8"?><Error><Code>'+err.code+'</Code><Message>'+err.message.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</Message></Error>'};
  return {type:'application/x-amz-json-1.0',text:JSON.stringify({__type:err.code,message:err.message})};
}
`;

/**
 * The server half: `startResigner(configPath)` reads the 0600 config file
 * the host mounted, listens with TLS on `127.0.0.1:<port>`, and forwards each
 * prepared request to the emulator over verified TLS. Resolves
 * `{ port }` once listening, else `{ error }`.
 */
export const RESIGN_SIDECAR_SERVER = String.raw`
function startResigner(cfgPath){return new Promise(function(done){
  var fs=require('fs'),https=require('https'),http=require('http'),tls=require('tls');
  var cfg;
  try{cfg=JSON.parse(fs.readFileSync(cfgPath,'utf8'));}catch(e){done({error:'CONFIG_'+(e.code||'ERROR')});return;}
  var up=new URL(cfg.upstream),secure=up.protocol==='https:',mod=secure?https:http;
  cfg.upstreamHost=up.host;
  var agentOpts={keepAlive:true};
  if(secure&&cfg.upstreamCaPem)agentOpts.ca=tls.rootCertificates.concat([cfg.upstreamCaPem]);
  var agent=new mod.Agent(agentOpts);
  function send(resp,status,err,service){
    if(resp.headersSent){resp.destroy();return;}
    var b=errorBody(err,service);
    resp.writeHead(status,{'content-type':b.type,'content-length':Buffer.byteLength(b.text),'connection':'close'});
    resp.end(b.text);
  }
  function serviceOf(req){
    var s=parseAuthScope(req.headers['authorization']||'');
    if(!s){var m=/[?&]X-Amz-Credential=([^&]*)/i.exec(String(req.url||''));if(m)s=parseCredentialScope('AWS4-HMAC-SHA256',safeDecode(m[1]));}
    return s?s.service:undefined;
  }
  // Bodies held at once, across concurrent requests: twice the per-request cap.
  var inflight=0,inflightCap=2*rawCap(cfg.capBytes);
  function handle(req,resp){
    // held counts toward inflight until the response is over; seen is the
    // body size for the 413 message.
    var chunks=[],held=0,seen=0,over=false,busy=false,limit=rawCap(cfg.capBytes);
    var drop=function(){inflight-=held;held=0;chunks=[];};
    req.on('data',function(c){seen+=c.length;if(over||busy)return;if(inflight+c.length>inflightCap){busy=true;drop();return;}held+=c.length;inflight+=c.length;if(seen>limit){over=true;drop();return;}chunks.push(c);});
    req.on('error',function(){drop();resp.destroy();});
    resp.on('close',drop);
    req.on('end',function(){
      if(busy){send(resp,503,{code:'SlowDown',message:'cdk-local mixed mode: the AWS Emulator re-signing sidecar is holding too many request bodies at once; retry.'},serviceOf(req));return;}
      if(over){process.stdout.write('CDKL-RESIGN rejected a streamed request body over the cap without holding it\n');send(resp,413,tooLargeError(seen,cfg.capBytes,serviceOf(req)),serviceOf(req));return;}
      var p;
      try{p=prepareResign(req,Buffer.concat(chunks),cfg,new Date());}catch(e){p={error:{status:400,code:'InvalidRequest',message:'cdk-local mixed mode: the request could not be re-signed.'}};}
      if(p.error){if(p.error.status===413)process.stdout.write('CDKL-RESIGN rejected a request body over the cap\n');send(resp,p.error.status,p.error,serviceOf(req));return;}
      var r;
      try{r=mod.request({host:up.hostname.replace(/^\[|\]$/g,''),port:up.port||(secure?443:80),method:req.method,path:p.path,headers:p.headers,agent:agent},function(ur){
        var h={};
        Object.keys(ur.headers).forEach(function(k){if(k==='connection'||k==='keep-alive'||k==='transfer-encoding')return;h[k]=ur.headers[k];});
        resp.writeHead(ur.statusCode||502,h);
        ur.pipe(resp);
        ur.on('error',function(){resp.destroy();});
      });}catch(e){send(resp,400,{code:'InvalidRequest',message:'cdk-local mixed mode: the request has a header the AWS Emulator re-signing sidecar cannot forward.'},p.service);return;}
      // A client that hangs up (an aborted GetObject) frees the upstream socket too.
      resp.on('close',function(){if(!resp.writableFinished)r.destroy();});
      r.setTimeout(300000,function(){r.destroy(Object.assign(new Error('upstream timeout'),{code:'ETIMEDOUT'}));});
      r.on('error',function(e){process.stdout.write('CDKL-RESIGN upstream error '+(e.code||'ERROR')+'\n');send(resp,502,{code:'BadGateway',message:'cdk-local mixed mode: the AWS Emulator at '+cfg.upstream+' did not answer ('+(e.code||'ERROR')+').'},p.service);});
      r.end(p.body);
    });
  }
  var srv=https.createServer({key:cfg.keyPem,cert:cfg.certPem},handle);
  srv.on('checkContinue',function(req,resp){
    var n=tooLargeByHeaders(req.headers,cfg.capBytes);
    if(n>0){process.stdout.write('CDKL-RESIGN rejected a request body over the cap\n');send(resp,413,tooLargeError(n,cfg.capBytes,serviceOf(req)),serviceOf(req));req.resume();return;}
    resp.writeContinue();
    handle(req,resp);
  });
  srv.once('error',function(e){done({error:e.code||'ERROR',port:cfg.port});});
  srv.listen(cfg.port,'127.0.0.1',function(){done({port:cfg.port});});
});}
`;

/** The full sidecar code, prepended to the forwarder script when a workload needs it. */
export const RESIGN_SIDECAR_SCRIPT = RESIGN_SIDECAR_CORE + RESIGN_SIDECAR_SERVER;

/**
 * What the host writes (JSON, mode 0600) for the sidecar to read: its TLS key
 * pair, the emulator's keys, the upstream URL and CA, the port and the cap.
 * Holds secrets; mounted read-only, removed with the wiring.
 */
export interface ResignSidecarConfig {
  /** The port the sidecar listens on, inside the workload's namespace. */
  port: number;
  /** The emulator URL the sidecar forwards to (`https://127.0.0.1:9297`). */
  upstream: string;
  /** The emulator's CA (PEM), trusted for the upstream TLS. */
  upstreamCaPem?: string;
  /** The sidecar's server certificate and key (PEM). */
  certPem: string;
  keyPem: string;
  /** The emulator's keys: every forwarded request is signed with these. */
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  /** Fallback region for a SigV4a request with no single region (the host's `AWS_REGION`, else `us-east-1`). */
  region?: string;
  /** {@link MIXED_MODE_RESIGN_BODY_CAP_BYTES} unless a test lowers it. */
  capBytes: number;
}
