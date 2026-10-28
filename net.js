/* Verbinding van de app met de eigen server:
   inloggen, gegevens delen, live updates en de berichten voor bellen. */
(function () {
  const K = 'gp_session';
  let sess = null;
  try { sess = JSON.parse(localStorage.getItem(K)); } catch (e) {}

  const NET = {
    token: (sess && sess.token) || null,
    user: (sess && sess.user) || null,
    cid: null, rev: 0, online: false, ice: null, peers: [],
    onstate: null, onlogout: null, onstatus: null,
    _sig: [], _pl: [], _run: false, _ac: null,
  };

  NET.api = async function (path, body, method) {
    const h = { 'Content-Type': 'application/json' };
    if (NET.token) h.Authorization = 'Bearer ' + NET.token;
    if (NET.cid) h['X-Client'] = NET.cid;
    let r;
    try {
      r = await fetch('/api' + path, { method: method || (body ? 'POST' : 'GET'), headers: h, body: body ? JSON.stringify(body) : undefined });
    } catch (e) { throw new Error('Geen verbinding met de server.'); }
    let d = {};
    try { d = await r.json(); } catch (e) {}
    if (r.status === 401 && NET.token && !/^\/(login|family|join)$/.test(path)) { NET.logout(); if (NET.onlogout) NET.onlogout(); }
    if (!r.ok) throw Object.assign(new Error(d.error || 'Er ging iets mis.'), { status: r.status });
    return d;
  };

  NET.setSession = function (d) {
    NET.token = d.token; NET.user = d.user;
    try { localStorage.setItem(K, JSON.stringify({ token: d.token, user: d.user })); } catch (e) {}
  };
  NET.logout = function () {
    NET.token = null; NET.user = null; NET.cid = null; NET.rev = 0; NET.peers = [];
    try { localStorage.removeItem(K); } catch (e) {}
    if (NET._ac) NET._ac.abort();
  };

  NET.getState = async function () {
    const d = await NET.api('/state');
    NET.rev = d.rev;
    try { NET.ice = (await NET.api('/ice')).iceServers; } catch (e) {}
    return d;
  };
  NET.pull = async function () {
    const d = await NET.api('/state');
    NET.rev = d.rev;
    if (NET.onstate) NET.onstate(d.state);
  };
  /* wijzigingen opsturen; als de server iets heeft teruggedraaid (rol), krijg je de echte stand terug */
  NET.put = async function (state) {
    const d = await NET.api('/state', { state }, 'PUT');
    NET.rev = d.rev;
    if (d.changed && NET.onstate) { NET.onstate(d.state, true); }
    return d;
  };

  function dispatch(ev, data) {
    if (ev === 'hello') {
      NET.cid = data.cid;
      if (data.rev > NET.rev) NET.pull().catch(() => {}); // iets gemist tijdens een onderbreking
    } else if (ev === 'state') {
      if (data.rev > NET.rev) NET.pull().catch(() => {});
    } else if (ev === 'peers') {
      NET.peers = data;
      NET._pl.forEach((f) => { try { f(); } catch (e) {} });
    } else if (ev === 'sig') {
      NET._sig.forEach((f) => { try { f({ data: data.data, peer: data.from, sameTab: false }); } catch (e) {} });
    }
  }
  function parse(block) {
    let ev = 'message', data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) ev = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) return;
    try { dispatch(ev, JSON.parse(data)); } catch (e) {}
  }

  /* blijft verbonden, en probeert het opnieuw als de verbinding wegvalt */
  NET.connect = async function () {
    if (NET._run || !NET.token) return;
    NET._run = true;
    let wait = 1000;
    while (NET.token) {
      const ac = new AbortController(); NET._ac = ac;
      try {
        const r = await fetch('/api/events', { headers: { Authorization: 'Bearer ' + NET.token }, signal: ac.signal });
        if (r.status === 401) { NET.logout(); if (NET.onlogout) NET.onlogout(); break; }
        if (!r.ok) throw new Error('x');
        NET.online = true; wait = 1000; if (NET.onstatus) NET.onstatus(true);
        const rd = r.body.getReader(), dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await rd.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) { parse(buf.slice(0, i)); buf = buf.slice(i + 2); }
        }
      } catch (e) { /* opnieuw proberen */ }
      NET.online = false; NET.cid = null; NET.peers = [];
      if (NET.onstatus) NET.onstatus(false);
      if (!NET.token) break;
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 15000);
    }
    NET._run = false;
  };

  /* zelfde vorm als de oude 'room', zodat de belcode ongewijzigd blijft werken */
  NET.room = {
    peers: () => NET.peers.map((p) => ({ peer: p.peer, sameTab: p.peer === NET.cid, isMe: p.peer === NET.cid, kind: 'viewer', presence: { mid: p.mid } })),
    on: (t, f) => { NET._sig.push(f); },
    onPeers: (f) => { NET._pl.push(f); },
    presence: () => {},
    emit: (t, data) => NET.api('/signal', { to: data.to, data }),
  };

  window.NET = NET;
})();
