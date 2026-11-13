// The AWS Emulator re-signing sidecar (mixed mode, go-to-k/cdkd#6150).
//
// In mixed mode (`--aws-emulator` plus a `"real-aws"` exception in
// `--env-vars`) a workload container holds the developer's REAL AWS identity,
// and every service WITHOUT an exception still goes to AWS Emulator: the
// container's global `AWS_ENDPOINT_URL` points here. Those requests arrive
// signed with real keys,
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
// it: each excepted service has its own `AWS_ENDPOINT_URL_<SERVICE>`, the real
// endpoint, which the SDKs prefer over the global one.
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
// SQS queue URLs (go-to-k/cdk-local#910): AWS Emulator answers `CreateQueue`,
// `GetQueueUrl`, `ListQueues` and `ListDeadLetterSourceQueues` with real-shaped
// URLs (`https://sqs.<region>.amazonaws.com/<account>/<queue>`), and the AWS
// SDK for JavaScript v3 sends an SQS request to its QueueUrl's host, which
// would take it out of the emulator. The sidecar rewrites those URLs (JSON and
// query/XML protocol, the URL fields only, never a message body) to its own
// `https://127.0.0.1:<port>`, so the SDK's next call stays local.
//
// Full emulator mode runs the same server as a PASSTHROUGH (`passthrough` in
// the config), as the workload's SQS endpoint only: the workload already
// signs with the emulator's keys, so the request goes upstream unchanged and
// streams, and only the SQS responses above are rewritten. The config then
// holds no keys.
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
 * Pure helpers: SigV4 signing, `aws-chunked` decoding, request preparation
 * and the SQS queue URL rewrite. No I/O. Defines `prepareResign`,
 * `signRequest`, `decodeAwsChunked`, `canonicalPath`, `canonicalQuery`,
 * `splitQuery`, `parseAuthScope`, `isAwsChunked`, `upstreamHeaders`,
 * `tooLargeByHeaders`, `passthroughHeaders`, `localQueueUrl`, `isSqsRequest`,
 * `sqsResponseMayCarryQueueUrl` and `rewriteSqsQueueUrls`.
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
var PASS_DROP_HEADERS=new Set(['connection','keep-alive','proxy-authorization','proxy-connection','te','trailer','transfer-encoding','upgrade','expect']);
function passthroughHeaders(incoming){
  var out=Object.create(null);
  Object.keys(incoming).forEach(function(k){var lk=k.toLowerCase();if(PASS_DROP_HEADERS.has(lk))return;var v=incoming[k];if(v===undefined)return;out[lk]=v;});
  return out;
}
// Only a real SQS queue URL is rewritten: an AWS SQS host (either form, any
// partition suffix), no port, user info, query or fragment, and a path of a
// 12-digit account and a queue name.
var SQS_QUEUE_URL=/^https?:\/\/(?:sqs\.[a-z0-9-]+|[a-z0-9-]+\.queue)\.amazonaws\.com(?:\.cn)?\/([0-9]{12}\/[A-Za-z0-9_-]{1,80}(?:\.fifo)?)$/;
function localQueueUrl(u,origin){var m=SQS_QUEUE_URL.exec(String(u));return m?origin+'/'+m[1]:u;}
var SQS_QUEUE_URL_OPERATIONS=new Set(['CreateQueue','GetQueueUrl','ListQueues','ListDeadLetterSourceQueues']);
// An unsigned request (an emulator run with --auth off and an SDK that signs
// nothing) has no scope: only the JSON protocol's target names SQS then.
function isSqsRequest(headers,service){return service==='sqs'||String(headers['x-amz-target']||'').indexOf('AmazonSQS.')===0;}
// JSON protocol: the target names the operation. Query protocol: unknown here,
// so every response is a candidate.
function sqsResponseMayCarryQueueUrl(headers){
  var t=String(headers['x-amz-target']||'');
  if(t==='')return true;
  return t.indexOf('AmazonSQS.')===0&&SQS_QUEUE_URL_OPERATIONS.has(t.slice('AmazonSQS.'.length));
}
function rewriteSqsQueueUrls(text,contentType,origin){
  var ct=String(contentType||'').toLowerCase(),changed=false;
  function one(u){if(typeof u!=='string')return u;var n=localQueueUrl(u,origin);if(n!==u)changed=true;return n;}
  if(ct.indexOf('json')>=0){
    var o;
    try{o=JSON.parse(text);}catch(e){return undefined;}
    if(!o||typeof o!=='object'||Array.isArray(o))return undefined;
    if(typeof o.QueueUrl==='string')o.QueueUrl=one(o.QueueUrl);
    ['QueueUrls','queueUrls'].forEach(function(k){if(Array.isArray(o[k]))o[k]=o[k].map(one);});
    return changed?JSON.stringify(o):undefined;
  }
  if(ct.indexOf('xml')>=0){
    // A message body inside XML is escaped, so a literal element is never user data.
    var out=String(text).replace(/<QueueUrl>([^<]*)<\/QueueUrl>/g,function(all,u){var n=one(u.trim());return n===u.trim()?all:'<QueueUrl>'+n+'</QueueUrl>';});
    return changed?out:undefined;
  }
  return undefined;
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
  var fs=require('fs'),https=require('https'),http=require('http'),tls=require('tls'),net=require('net'),zlib=require('zlib');
  var cfg;
  try{cfg=JSON.parse(fs.readFileSync(cfgPath,'utf8'));}catch(e){done({error:'CONFIG_'+(e.code||'ERROR')});return;}
  var passthrough=cfg.passthrough===true;
  if(!passthrough&&!cfg.credentials){done({error:'CONFIG_ERROR'});return;}
  var label=passthrough?'cdk-local --aws-emulator':'cdk-local mixed mode';
  var up=new URL(cfg.upstream),secure=up.protocol==='https:',mod=secure?https:http;
  var upHost=up.hostname.replace(/^\[|\]$/g,'');
  cfg.upstreamHost=up.host;
  var agentOpts={keepAlive:true};
  if(secure&&cfg.upstreamCaPem)agentOpts.ca=tls.rootCertificates.concat([cfg.upstreamCaPem]);
  var agent=new mod.Agent(agentOpts);
  // What a rewritten queue URL points at: this sidecar, the endpoint the workload already uses.
  var origin='https://127.0.0.1:'+cfg.port;
  var REWRITE_CAP=16*1048576;
  // Response bytes held at once across concurrent requests; past it a
  // response streams through unrewritten.
  var heldResp=0,HELD_RESP_CAP=4*REWRITE_CAP;
  var DECODERS={identity:null,gzip:zlib.gunzipSync,'x-gzip':zlib.gunzipSync,deflate:zlib.inflateSync,br:zlib.brotliDecompressSync};
  // Relay an emulator response. An SQS response that may carry a queue URL is
  // held (up to a cap) and its queue URLs point back here; anything else, and
  // a response that needs no change, goes through byte for byte.
  function relay(ur,resp,rewrite){
    var h={};
    Object.keys(ur.headers).forEach(function(k){if(k==='connection'||k==='keep-alive'||k==='transfer-encoding')return;h[k]=ur.headers[k];});
    var status=ur.statusCode||502,enc=String(ur.headers['content-encoding']||'identity').trim().toLowerCase();
    ur.on('error',function(){resp.destroy();});
    if(!rewrite||status<200||status>=300||!Object.prototype.hasOwnProperty.call(DECODERS,enc)||Number(ur.headers['content-length'])>REWRITE_CAP){resp.writeHead(status,h);ur.pipe(resp);return;}
    var chunks=[],n=0,released=false;
    function release(){if(!released){released=true;heldResp-=n;}}
    function onData(c){
      n+=c.length;heldResp+=c.length;chunks.push(c);
      if(n<=REWRITE_CAP&&heldResp<=HELD_RESP_CAP)return;
      ur.removeListener('data',onData);ur.removeListener('end',onEnd);release();
      resp.writeHead(status,h);chunks.forEach(function(x){resp.write(x);});chunks=[];
      ur.pipe(resp);
    }
    function onEnd(){
      release();
      var raw=Buffer.concat(chunks),text,out;chunks=[];
      try{var dec=DECODERS[enc];text=(dec?dec(raw,{maxOutputLength:4*REWRITE_CAP}):raw).toString('utf8');}catch(e){text=undefined;}
      if(text!==undefined)out=rewriteSqsQueueUrls(text,ur.headers['content-type'],origin);
      if(out===undefined){h['content-length']=String(raw.length);resp.writeHead(status,h);resp.end(raw);return;}
      var b=Buffer.from(out,'utf8');
      delete h['content-encoding'];delete h['content-md5'];delete h['x-amz-crc32'];
      h['content-length']=String(b.length);
      resp.writeHead(status,h);resp.end(b);
    }
    ur.on('data',onData);ur.on('end',onEnd);ur.on('close',release);
  }
  function rewritesResponse(req,service){return isSqsRequest(req.headers,service)&&sqsResponseMayCarryQueueUrl(req.headers);}
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
  // Each held byte is charged twice: building the request body briefly keeps
  // two copies alive (the received chunks while they are joined, then the
  // joined body while an aws-chunked body is decoded), so the charged total
  // bounds the real peak by inflightCap.
  var inflight=0,inflightCap=2*rawCap(cfg.capBytes);
  function handle(req,resp){
    // held counts toward inflight until the response is over; seen is the
    // body size for the 413 message.
    var chunks=[],held=0,seen=0,over=false,busy=false,limit=rawCap(cfg.capBytes);
    var drop=function(){inflight-=2*held;held=0;chunks=[];};
    req.on('data',function(c){seen+=c.length;if(over||busy)return;if(seen>limit){over=true;drop();return;}if(inflight+2*c.length>inflightCap){busy=true;drop();return;}held+=c.length;inflight+=2*c.length;chunks.push(c);});
    req.on('error',function(){drop();resp.destroy();});
    resp.on('close',drop);
    req.on('end',function(){
      if(busy){send(resp,503,{code:'SlowDown',message:label+': the AWS Emulator re-signing sidecar is holding too many request bodies at once; retry.'},serviceOf(req));return;}
      if(over){process.stdout.write('CDKL-RESIGN rejected a streamed request body over the cap without holding it\n');send(resp,413,tooLargeError(seen,cfg.capBytes,serviceOf(req)),serviceOf(req));return;}
      var p;
      var joined=Buffer.concat(chunks);chunks=[];
      try{p=prepareResign(req,joined,cfg,new Date());}catch(e){p={error:{status:400,code:'InvalidRequest',message:label+': the request could not be re-signed.'}};}
      joined=null;
      if(p.error){if(p.error.status===413)process.stdout.write('CDKL-RESIGN rejected a request body over the cap\n');send(resp,p.error.status,p.error,serviceOf(req));return;}
      // Re-signed anyway (accept-encoding is not a signed header): ask for an
      // identity body, so an encoding the sidecar cannot decode never carries
      // a real queue URL past it.
      if(rewritesResponse(req,p.service))delete p.headers['accept-encoding'];
      var r=upstreamRequest(req,resp,p.path,p.headers,p.service,{});
      if(r)r.end(p.body);
    });
  }
  // One upstream request; the response is relayed back. Undefined when the
  // headers cannot be sent (the client got a 400).
  function upstreamRequest(req,resp,path,headers,service,extra){
    var r,opts={host:upHost,port:up.port||(secure?443:80),method:req.method,path:path,headers:headers,agent:agent};
    Object.keys(extra).forEach(function(k){opts[k]=extra[k];});
    try{r=mod.request(opts,function(ur){relay(ur,resp,rewritesResponse(req,service));});}
    catch(e){send(resp,400,{code:'InvalidRequest',message:label+': the request has a header the AWS Emulator sidecar cannot forward.'},service);return undefined;}
    // A client that hangs up (an aborted GetObject) frees the upstream socket too.
    resp.on('close',function(){if(!resp.writableFinished)r.destroy();});
    r.setTimeout(300000,function(){r.destroy(Object.assign(new Error('upstream timeout'),{code:'ETIMEDOUT'}));});
    r.on('error',function(e){process.stdout.write('CDKL-RESIGN upstream error '+(e.code||'ERROR')+'\n');send(resp,502,{code:'BadGateway',message:label+': the AWS Emulator at '+cfg.upstream+' did not answer ('+(e.code||'ERROR')+').'},service);});
    return r;
  }
  // Full emulator mode: the workload already signs with the emulator's keys,
  // so the request goes upstream unchanged (its Host header too, which the
  // signature covers) and streams; only hop-by-hop headers are dropped. TLS
  // to the emulator is verified against the emulator's host name.
  function handlePassthrough(req,resp){
    var service=serviceOf(req);
    // The incoming Host names the sidecar, not the emulator: SNI (and with it
    // the certificate check) uses the emulator's own host name instead.
    var extra=secure?{servername:net.isIP(upHost)?'':upHost}:{};
    var r=upstreamRequest(req,resp,String(req.url||'/'),passthroughHeaders(req.headers),service,extra);
    if(!r){req.resume();return;}
    req.on('error',function(){r.destroy();resp.destroy();});
    req.pipe(r);
  }
  var srv=https.createServer({key:cfg.keyPem,cert:cfg.certPem},passthrough?handlePassthrough:handle);
  srv.on('checkContinue',function(req,resp){
    if(passthrough){resp.writeContinue();handlePassthrough(req,resp);return;}
    var n=tooLargeByHeaders(req.headers,cfg.capBytes);
    if(n>0){process.stdout.write('CDKL-RESIGN rejected a request body over the cap\n');send(resp,413,tooLargeError(n,cfg.capBytes,serviceOf(req)),serviceOf(req));req.resume();return;}
    resp.writeContinue();
    handle(req,resp);
  });
  srv.once('error',function(e){done({error:e.code||'ERROR',port:cfg.port});});
  // Loopback only: in mixed mode it signs with the emulator's keys for whoever connects.
  srv.listen(cfg.port,'127.0.0.1',function(){done({port:cfg.port,address:srv.address().address});});
});}
`;

/** The full sidecar code, prepended to the forwarder script when a workload needs it. */
export const RESIGN_SIDECAR_SCRIPT = RESIGN_SIDECAR_CORE + RESIGN_SIDECAR_SERVER;

/**
 * What the host writes (JSON, mode 0600) for the sidecar to read: its TLS key
 * pair, the emulator's keys (mixed mode), the upstream URL and CA, the port
 * and the cap. Holds secrets; mounted read-only, removed with the wiring.
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
  /**
   * The emulator's keys: every forwarded request is signed with these (mixed
   * mode). Absent with {@link passthrough}.
   */
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  /**
   * Full emulator mode: forward each request unchanged (no re-signing, no
   * body cap) and only rewrite SQS queue URLs in the responses.
   */
  passthrough?: boolean;
  /** Fallback region for a SigV4a request with no single region (the host's `AWS_REGION`, else `us-east-1`). */
  region?: string;
  /** {@link MIXED_MODE_RESIGN_BODY_CAP_BYTES} unless a test lowers it. */
  capBytes: number;
}
