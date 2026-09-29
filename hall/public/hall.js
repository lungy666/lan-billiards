/*
 * hall/public/hall.js —— 大厅前端
 *
 * 职责:登录、房间列表、创建/加入房间、加载并驱动具体游戏的客户端模块。
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const H = {
    ws: null,
    me: null,
    games: [],
    rooms: [],
    room: null,
    entry: null,
    gameMod: null,
    gameKey: null,
    reconnecting: false,
    everJoined: false,
    rejoin: null,
  };

  const gameApi = {
    me: null,
    room: null,
    snapshot: null,
    send(m) { send({ t: 'g', m }); },
    toast(text) { toast(text); },
  };

  /* ---------------- 连接 ---------------- */
  function send(obj) {
    if (H.ws && H.ws.readyState === 1) H.ws.send(JSON.stringify(obj));
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws;
    try { ws = new WebSocket(proto + '://' + location.host + '/ws'); }
    catch (e) { setTimeout(connect, 1500); return; }
    H.ws = ws;
    ws.onopen = () => {
      H.reconnecting = false;
      if (H.everJoined) send({ t: 'hello', name: H.me ? H.me.name : '', adminPass: H.pendingPass || undefined });
    };
    ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m && typeof m === 'object') handle(m);
    };
    ws.onclose = () => {
      if (H.reconnecting) return;
      H.reconnecting = true;
      H.rejoin = H.room ? H.room.id : null;
      toast('连接断开,正在重连…', 'warn');
      setTimeout(connect, 1500);
    };
    ws.onerror = () => {};
  }

  /* ---------------- 消息处理 ---------------- */
  function handle(m) {
    switch (m.t) {
      case 'welcome': {
        H.me = m.you;
        H.everJoined = true;
        H.games = m.games || [];
        H.rooms = m.rooms || [];
        $('whoami').innerHTML = '';
        const b = document.createElement('b');
        b.textContent = H.me.name;
        $('whoami').appendChild(document.createTextNode('你好,'));
        $('whoami').appendChild(b);
        if (H.me.admin) $('whoami').appendChild(document.createTextNode(' 👑'));
        $('adminBtn').style.display = H.me.admin ? '' : 'none';
        hideOverlay();
        renderLobby();
        if (H.rejoin) {
          const rid = H.rejoin;
          H.rejoin = null;
          if (H.rooms.some(r => r.id === rid)) send({ t: 'enter', roomId: rid });
          else onLeft();
        }
        break;
      }
      case 'games': H.games = m.games || []; renderLobby(); break;
      case 'rooms': H.rooms = m.rooms || []; renderRooms(); break;
      case 'entered': onEntered(m); break;
      case 'room': onRoom(m.room); break;
      case 'g': if (H.gameMod && H.gameMod.onMessage) H.gameMod.onMessage(m.m); break;
      case 'chat': toast(`${m.from}: ${m.text}`); break;
      case 'msg': toast(m.text); break;
      case 'err':
        toast(m.text, 'warn');
        if (H.rejoin) { H.rejoin = null; onLeft(); }
        break;
      case 'left': onLeft(); break;
    }
  }

  function onEntered(m) {
    H.room = m.room;
    H.entry = m.entry;
    gameApi.me = m.you;
    gameApi.room = m.room;
    gameApi.snapshot = m.snapshot || null;
    $('lobbyView').style.display = 'none';
    $('roomView').style.display = 'flex';
    document.body.classList.add('in-room');
    applyGameTheme(H.room);
    updateRoomHeader();
    mountGame();
  }

  function onRoom(room) {
    H.room = room;
    gameApi.room = room;
    applyGameTheme(room);
    if ($('roomView').style.display !== 'none') updateRoomHeader();
    if (H.gameMod && H.gameMod.onRoom) H.gameMod.onRoom(room, gameApi.me);
    // 外部游戏进程就绪后,再挂载 iframe
    if (room.entry) H.entry = room.entry;
    if (H.entry && H.entry.mode === 'iframe' && H.entry.ready && !$('gameMount').querySelector('iframe')) {
      mountIframe();
    }
    renderRoomsInLobbyIfVisible();
  }

  function onLeft() {
    H.room = null;
    H.entry = null;
    gameApi.me = null;
    gameApi.room = null;
    gameApi.snapshot = null;
    if (H.gameMod && H.gameMod.unmount) { try { H.gameMod.unmount(); } catch (e) {} }
    H.gameMod = null;
    H.gameKey = null;
    $('gameMount').innerHTML = '';
    $('roomView').style.display = 'none';
    $('lobbyView').style.display = 'block';
    document.body.classList.remove('in-room');
    renderRooms();
  }

  /* ---------------- 游戏挂载 ---------------- */
  // 按房间所属游戏应用氛围主题(配置在 games.config.js 的 theme 字段)
  function applyGameTheme(room) {
    const el = $('roomView');
    const t = room && room.gameTheme;
    if (t && t.bg) el.style.setProperty('--game-bg', t.bg); else el.style.removeProperty('--game-bg');
    if (t && t.accent) el.style.setProperty('--game-accent', t.accent); else el.style.removeProperty('--game-accent');
    document.body.classList.toggle('in-themed-room', !!(t && t.bg));
  }

  function mountGame() {
    const mountEl = $('gameMount');
    mountEl.innerHTML = '';
    if (H.gameMod && H.gameMod.unmount) { try { H.gameMod.unmount(); } catch (e) {} }
    H.gameMod = null;
    H.gameKey = null;

    const entry = H.entry;
    if (!entry) { mountEl.innerHTML = '<div class="loading">该游戏未提供接入信息</div>'; return; }

    if (entry.mode === 'iframe') {
      if (entry.ready) mountIframe();
      else mountEl.innerHTML = '<div class="loading"><span class="spin"></span>正在启动游戏进程…</div>';
      return;
    }

    // 进程内游戏:加载前端脚本
    mountEl.innerHTML = '<div class="loading"><span class="spin"></span>正在加载游戏…</div>';
    const key = entry.key;
    loadGameClient(key, entry.script).then(mod => {
      if (!mod || !H.room) return;
      H.gameMod = mod;
      H.gameKey = key;
      mountEl.innerHTML = '';
      mod.mount(mountEl, gameApi);
      if (gameApi.snapshot && mod.onSnapshot) mod.onSnapshot(gameApi.snapshot);
    }).catch(err => {
      mountEl.innerHTML = '<div class="loading">游戏前端加载失败:' + String(err.message || err) + '</div>';
    });
  }

  function mountIframe() {
    const mountEl = $('gameMount');
    const port = H.entry.port;
    const url = 'http://' + location.hostname + ':' + port + (H.entry.path || '/');
    mountEl.innerHTML = '';
    const iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.allow = 'autoplay; fullscreen';
    mountEl.appendChild(iframe);
  }

  function loadGameClient(key, script) {
    return new Promise((resolve, reject) => {
      if (window.HallGames && window.HallGames[key]) return resolve(window.HallGames[key]);
      const s = document.createElement('script');
      s.src = script;
      s.onload = () => {
        if (window.HallGames && window.HallGames[key]) resolve(window.HallGames[key]);
        else reject(new Error('模块未注册:' + key));
      };
      s.onerror = () => reject(new Error('脚本加载失败:' + script));
      document.head.appendChild(s);
    });
  }

  /* ---------------- 渲染:大厅 ---------------- */
  function renderLobby() { renderGames(); renderRooms(); }

  function renderGames() {
    const box = $('gameList');
    box.innerHTML = '';
    if (!H.games.length) { box.innerHTML = '<div class="empty">暂无可用游戏</div>'; return; }
    for (const g of H.games) {
      const card = document.createElement('div');
      card.className = 'game-card';

      const h = document.createElement('h3');
      h.textContent = g.name;
      const tag = document.createElement('span');
      tag.className = 'g-tag';
      tag.textContent = (g.mode === 'external' ? '独立进程' : '内置') + ` · ${g.minPlayers}-${g.maxPlayers} 人`;
      h.appendChild(tag);

      const desc = document.createElement('div');
      desc.className = 'g-desc';
      desc.textContent = g.desc || '';

      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = '创建房间';
      btn.onclick = () => { send({ t: 'create', gameId: g.id }); btn.disabled = true; setTimeout(() => { btn.disabled = false; }, 800); };

      card.appendChild(h); card.appendChild(desc); card.appendChild(btn);
      box.appendChild(card);
    }
  }

  function renderRooms() {
    if (!H.room) renderRoomsInLobbyIfVisible();
    else renderRoomMetaInline();
  }

  function renderRoomsInLobbyIfVisible() {
    if ($('lobbyView').style.display === 'none') return;
    const box = $('roomList');
    box.innerHTML = '';
    if (!H.rooms.length) { box.innerHTML = '<div class="empty">还没有房间,创建一个吧 ~</div>'; return; }
    for (const r of H.rooms) {
      const row = document.createElement('div');
      row.className = 'room-row';

      const g = document.createElement('div');
      g.className = 'r-game';
      g.textContent = r.gameName;

      const p = document.createElement('div');
      p.className = 'r-players';
      const names = r.seats.filter(Boolean).map(s => s.name).join('、') || '空位';
      p.innerHTML = `<b>${escapeHtml(names)}</b> · ${r.playerCount}/${r.maxPlayers} 人` + (r.specCount ? ` · 👁 ${r.specCount}` : '');

      const badge = document.createElement('span');
      badge.className = 'r-badge ' + (r.phase === 'playing' ? 'playing' : r.phase === 'finished' ? 'finished' : 'waiting');
      badge.textContent = r.phase === 'playing' ? '对局中' : r.phase === 'finished' ? '已结束' : '等待中';

      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = '加入';
      btn.style.padding = '7px 16px';
      btn.onclick = () => send({ t: 'enter', roomId: r.id });

      row.appendChild(g); row.appendChild(p); row.appendChild(badge); row.appendChild(btn);
      box.appendChild(row);
    }
  }

  function updateRoomHeader() {
    const r = H.room;
    if (!r) return;
    $('roomTitle').textContent = r.gameName;
    $('roomId').textContent = '#' + r.id;
    const me = gameApi.me || {};
    const roleTxt = me.spectator ? '观战' : (me.seat !== null && me.seat !== undefined ? `${me.seat + 1} 号位` : '');
    const seats = r.seats.map((s, i) => (s ? s.name : '空位')).join(' / ');
    const meta = $('roomMeta');
    meta.innerHTML = '';
    meta.appendChild(document.createTextNode(`座位:${seats}`));
    if (r.specCount) meta.appendChild(document.createTextNode(` · 👁 ${r.specCount}`));
    if (roleTxt) {
      meta.appendChild(document.createTextNode(' · 你:'));
      const b = document.createElement('b');
      b.textContent = roleTxt + (H.me && H.me.admin ? ' 👑' : '');
      meta.appendChild(b);
    }
    const badge = document.createTextNode(' · ' + (r.phase === 'playing' ? '对局中' : r.phase === 'finished' ? '已结束' : '等待中') + (r.ready ? '' : ' · 启动中'));
    meta.appendChild(badge);
  }

  function renderRoomMetaInline() {
    // 房间视图下,若大厅列表隐藏则无需渲染;保留占位
  }

  /* ---------------- 登录 / 遮罩 ---------------- */
  let pendingPass = '';
  function showLogin() {
    const overlay = $('overlay');
    overlay.classList.add('show');
    const inp = $('nameInput');
    inp.value = localStorage.getItem('hall_name') || '';
    $('adminLink').onclick = () => {
      const p = $('adminPass');
      const show = p.style.display === 'none';
      p.style.display = show ? 'block' : 'none';
      $('adminLink').textContent = show ? '收起管理员登录' : '管理员登录';
      if (show) p.focus();
    };
    const go = () => {
      const name = inp.value.trim().slice(0, 12) || '玩家';
      localStorage.setItem('hall_name', name);
      H.me = { name };
      const ap = $('adminPass');
      H.pendingPass = ap && ap.style.display !== 'none' ? ap.value.trim() : '';
      send({ t: 'hello', name, adminPass: H.pendingPass || undefined });
      $('joinBtn').disabled = true;
      $('joinBtn').textContent = '进入中…';
    };
    $('joinBtn').onclick = go;
    inp.onkeydown = e => { if (e.key === 'Enter') go(); };
    setTimeout(() => inp.focus(), 50);
  }

  function hideOverlay() { $('overlay').classList.remove('show'); }

  /* ---------------- toast ---------------- */
  function toast(text, cls) {
    const box = $('toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (cls ? ' ' + cls : '');
    el.textContent = text;
    box.appendChild(el);
    while (box.children.length > 4) box.removeChild(box.firstChild);
    setTimeout(() => el.classList.add('fade'), 2400);
    setTimeout(() => el.remove(), 3000);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------------- 事件 ---------------- */
  $('refreshBtn').onclick = () => send({ t: 'list' });
  $('mkRefresh').onclick = () => send({ t: 'list' });
  $('leaveBtn').onclick = () => send({ t: 'leave' });
  $('adminBtn').onclick = () => {
    if (H.room) {
      if (confirm('关闭当前房间?所有成员都会被移出。')) send({ t: 'admin', cmd: 'closeRoom', roomId: H.room.id });
    } else {
      if (confirm('关闭所有房间?')) send({ t: 'admin', cmd: 'closeAll' });
    }
  };

  /* ---------------- 启动 ---------------- */
  showLogin();
  connect();
})();
