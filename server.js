// Gezinsplanner server: serveert de app en bewaart de gedeelde gegevens.
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 3000;
const KEY = process.env.FAMILIEKEY || '';           // geheim woord (aanbevolen)
const FILE = path.join(__dirname, 'data.json');
const OLD = 'https://claude.ai/artifact/GVrogPmJksDQQyHcY9zMEA';

let state = { s: '', rev: 0 };
try { state = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {}
const raw = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// Zorgt dat de app (die voor claude.ai is gemaakt) met deze server praat.
const SHIM = '<script>(function(){'
+ 'var K=new URLSearchParams(location.search).get("k")||"";'
+ 'try{if(K)localStorage.setItem("gp_key",K);else K=localStorage.getItem("gp_key")||""}catch(e){}'
+ 'var H={"Content-Type":"application/json","x-key":K};'
+ 'function warn(){if(document.getElementById("gpw"))return;var d=document.createElement("div");d.id="gpw";d.textContent="Geen toegang tot de gezinsserver. Open de planner met de link die eindigt op ?k=jouwgeheimewoord (tik om te sluiten).";d.style.cssText="position:fixed;left:8px;right:8px;top:8px;z-index:99;background:#B3261E;color:#fff;padding:10px 12px;border-radius:10px;font:600 14px system-ui";d.onclick=function(){d.remove()};(document.body||document.documentElement).appendChild(d)}'
+ 'function get(){return fetch("/api/state",{headers:H,cache:"no-store"}).then(function(r){if(!r.ok){if(r.status===401)warn();throw 0}return r.json()})}'
+ 'var doc={'
+ 'get:function(){return get().then(function(j){return{exists:!!j.s,data:function(){return j}}})},'
+ 'set:function(v){return fetch("/api/state",{method:"PUT",headers:H,body:JSON.stringify(v)}).then(function(r){if(!r.ok)throw 0})},'
+ 'onSnapshot:function(cb){function poll(){get().then(function(j){'
+ 'if(j.s){cb({exists:true,data:function(){return j}})}'
+ 'else if(typeof S!=="undefined"&&S){doc.set({s:JSON.stringify(S),rev:Date.now()}).catch(function(){})}'
+ '}).catch(function(){})}setInterval(poll,5000);poll();return function(){}}};'
+ 'window.claude={use:function(n){return Promise.resolve(n==="db"?{doc:function(){return doc}}:null)}};'
+ '})();</script>';

function page(host) {
  const app = 'https://' + host + '/' + (KEY ? '?k=' + encodeURIComponent(KEY) : '');
  return raw.split(OLD).join(app)
    .replace('Bellen werkt alleen als je bent ingelogd op claude.ai en de planner met jouw eigen account opent, niet via een openbare link.',
             'Bellen in de planner werkt hier niet. Gebruik de knop Open Wibel hierboven.')
    .replace('<script>', SHIM + '<script>');
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
  if (u.pathname === '/api/state') {
    if (KEY && req.headers['x-key'] !== KEY) { res.writeHead(401); return res.end(); }
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(state));
    }
    if (req.method === 'PUT') {
      let b = '';
      req.on('data', c => { b += c; if (b.length > 2e6) req.destroy(); });
      req.on('end', () => {
        try {
          const v = JSON.parse(b);
          if (typeof v.s === 'string' && typeof v.rev === 'number' && v.rev >= state.rev) {
            state = { s: v.s, rev: v.rev };
            fs.writeFile(FILE, JSON.stringify(state), () => {});
          }
          res.writeHead(200); res.end('ok');
        } catch (e) { res.writeHead(400); res.end(); }
      });
      return;
    }
  }
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(page(req.headers.host));
  }
  res.writeHead(404); res.end('Niet gevonden');
}).listen(PORT, () => console.log('Gezinsplanner draait op poort ' + PORT));
