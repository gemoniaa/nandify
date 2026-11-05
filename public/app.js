(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  /* ================================================================== */
  /* Saved data (kept only in this browser)                              */
  /* ================================================================== */
  const KEY = 'nandify.v4';
  const store = { liked: [], playlists: [], pinned: [], recent: [], artists: [], theme: 'classic', shuffle: false, smart: false, name: '' };

  function loadStore() {
    try {
      const o = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (!o || typeof o !== 'object') return;
      for (const k of ['liked', 'playlists', 'pinned', 'recent', 'artists']) if (Array.isArray(o[k])) store[k] = o[k];
      if (['classic', 'kawaii', 'gotham'].includes(o.theme)) store.theme = o.theme;
      store.shuffle = Boolean(o.shuffle);
      store.smart = Boolean(o.smart);
      if (typeof o.name === 'string') store.name = o.name.slice(0, 24);
    } catch { /* ignore broken saved data */ }
  }
  function saveStore() {
    try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* storage full or blocked */ }
  }
  loadStore();

  const slim = (t) => ({ id: t.id, title: t.title, artist: t.artist || '', duration: t.duration || 0, thumbnail: t.thumbnail || '' });
  const thumb = (t) => t.thumbnail || 'https://i.ytimg.com/vi/' + t.id + '/mqdefault.jpg';
  const isLiked = (id) => store.liked.some((x) => x.id === id);
  const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  /* ================================================================== */
  /* Audio engine: the official YouTube player behind an audio-like API  */
  /* ================================================================== */
  class YTAudio extends EventTarget {
    constructor() {
      super();
      this.player = null;
      this.ready = false;
      this.pending = null;
      this.paused = true;
      this.error = null;
      this.playbackRate = 1;
      this._volume = 1;
      this._lastDur = NaN;
    }
    init() {
      this.player = new YT.Player('yt', {
        width: '100%',
        height: '100%',
        playerVars: { playsinline: 1, rel: 0, origin: location.origin },
        events: {
          onReady: () => this._onReady(),
          onStateChange: (e) => this._onState(e.data),
          onError: (e) => this._onError(e.data),
        },
      });
    }
    _emit(name) { this.dispatchEvent(new Event(name)); }
    _onReady() {
      this.ready = true;
      this.player.setVolume(Math.round(this._volume * 100));
      setInterval(() => {
        this._emit('timeupdate');
        const d = this.duration;
        if (Number.isFinite(d) && d !== this._lastDur) { this._lastDur = d; this._emit('durationchange'); }
      }, 250);
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        this._load(p.id, p.start);
      }
    }
    _onState(s) {
      if (s === 1) { this.paused = false; this._emit('play'); this._emit('playing'); this._emit('durationchange'); }
      else if (s === 2) { this.paused = true; this._emit('pause'); }
      else if (s === 3) { this._emit('waiting'); }
      else if (s === 0) { this.paused = true; this._emit('pause'); this._emit('ended'); }
    }
    _onError(code) {
      this.error = { code };
      this.paused = true;
      this._emit('pause');
      this._emit('error');
    }
    get currentTime() { return this.ready ? (this.player.getCurrentTime() || 0) : 0; }
    set currentTime(v) { if (this.ready) this.player.seekTo(v, true); }
    get duration() {
      if (!this.ready) return NaN;
      const d = this.player.getDuration();
      return d > 0 ? d : NaN;
    }
    _load(id, start) {
      if (start > 0) this.player.loadVideoById({ videoId: id, startSeconds: start });
      else this.player.loadVideoById(id);
    }
    load(id, start = 0) {
      this.error = null;
      if (this.ready) this._load(id, start);
      else this.pending = { id, start };
    }
    play() { if (this.ready) this.player.playVideo(); return Promise.resolve(); }
    pause() { if (this.ready) this.player.pauseVideo(); }
  }
  const audio = new YTAudio();

  /* ================================================================== */
  /* App state                                                           */
  /* ================================================================== */
  const S = { tab: 'home', ent: null, queue: [], qi: -1, source: '', results: [], seeking: false };
  // Listen together: role is null, 'host' or 'guest'
  const T = { role: null, code: '', cid: '', people: [], peopleBox: null, members: 1, offset: 0, hb: 0, poll: 0, v: 0, lastPush: 0, last: null, publicUrl: '' };
  const artistCache = new Map(); // lower case name -> { name, thumbnail, tracks }
  const cur = () => S.queue[S.qi] || null;

  const el = {
    nav: $('#nav'), navBack: $('#navBack'), navTitle: $('#navTitle'),
    navSearch: $('#navSearch'), navMenu: $('#navMenu'), navProfile: $('#navProfile'),
    greet: $('#greet'), homeTiles: $('#homeTiles'), homeRecent: $('#homeRecent'), homeRecentWrap: $('#homeRecentWrap'),
    homeEmpty: $('#homeEmpty'), homeChips: $('#homeChips'),
    searchForm: $('#searchForm'), q: $('#q'), searchNote: $('#searchNote'), browse: $('#browse'), browseGrid: $('#browseGrid'), results: $('#results'),
    newPlaylist: $('#newPlaylist'), libList: $('#libList'),
    entArt: $('#entArt'), entTitle: $('#entTitle'), entMeta: $('#entMeta'), entPin: $('#entPin'), entShuffle: $('#entShuffle'),
    entMore: $('#entMore'), entPlay: $('#entPlay'), entList: $('#entList'), entEmpty: $('#entEmpty'), entEmptyT: $('#entEmptyT'), entEmptyS: $('#entEmptyS'),
    mini: $('#mini'), miniArt: $('#miniArt'), miniTitle: $('#miniTitle'), miniArtist: $('#miniArtist'), miniPlay: $('#miniPlay'), miniNext: $('#miniNext'), miniBar: $('#miniBar'),
    np: $('#np'), npClose: $('#npClose'), npFrom: $('#npFrom'), npMore: $('#npMore'), npTitle: $('#npTitle'), npArtist: $('#npArtist'),
    npLike: $('#npLike'), npShuffle: $('#npShuffle'), npPrev: $('#npPrev'), npPlay: $('#npPlay'), npNext: $('#npNext'), npAdd: $('#npAdd'),
    seek: $('#seek'), cur: $('#cur'), dur: $('#dur'), npQueue: $('#npQueue'), lyrBody: $('#lyrBody'),
    scrim: $('#scrim'), sheet: $('#sheet'), shTitle: $('#shTitle'), shSub: $('#shSub'), shBody: $('#shBody'),
    dlg: $('#dlg'), dlgTitle: $('#dlgTitle'), dlgInput: $('#dlgInput'), dlgOk: $('#dlgOk'), dlgCancel: $('#dlgCancel'),
    toast: $('#toast'),
    navTogether: $('#navTogether'), tgCount: $('#tgCount'),
    artistsWrap: $('#artistsWrap'), artistRow: $('#artistRow'), songsHead: $('#songsHead'),
    homeArtistsWrap: $('#homeArtistsWrap'), homeArtists: $('#homeArtists'),
    npSmart: $('#npSmart'), entSmart: $('#entSmart'), npPeople: $('#npPeople'), npStack: $('#npStack'), npPeopleText: $('#npPeopleText'),
    ytBox: $('#ytBox'), ytSignIn: $('#ytSignIn'), ytList: $('#ytList'), ytSignOut: $('#ytSignOut'),
  };

  /* ---------- small helpers ---------- */
  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }
  function mk(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  let toastTimer = 0;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('on'), 2400);
  }
  function setPaint(input) {
    input.style.setProperty('--p', (Number(input.value) / Number(input.max || 100) * 100).toFixed(2) + '%');
  }

  /* ================================================================== */
  /* Themes                                                              */
  /* ================================================================== */
  const THEME_COLOR = { classic: '#000000', kawaii: '#ffe0ea', gotham: '#0a0a0b' };
  function applyTheme(name) {
    store.theme = name;
    document.documentElement.dataset.theme = name;
    $('#metaTheme').setAttribute('content', THEME_COLOR[name] || '#000000');
    saveStore();
  }
  applyTheme(store.theme);

  /* ================================================================== */
  /* Sheets and dialog                                                   */
  /* ================================================================== */
  let sheetOpen = false;
  function openSheet(opts) {
    el.shTitle.textContent = opts.title || '';
    el.shSub.textContent = opts.sub || '';
    el.shSub.hidden = !opts.sub;
    el.shBody.textContent = '';
    if (opts.build) opts.build(el.shBody);
    (opts.items || []).forEach((it) => {
      const b = mk('button', 'sh-item' + (it.danger ? ' danger' : ''));
      b.type = 'button';
      b.appendChild(mk('span', '', it.label));
      if (it.hint) b.appendChild(mk('small', '', it.hint));
      b.addEventListener('click', () => { closeSheet(); if (it.run) it.run(); });
      el.shBody.appendChild(b);
    });
    el.scrim.hidden = false;
    requestAnimationFrame(() => {
      el.scrim.classList.add('on');
      el.sheet.classList.add('open');
    });
    el.sheet.setAttribute('aria-hidden', 'false');
    sheetOpen = true;
  }
  function closeSheet() {
    if (!sheetOpen) return;
    sheetOpen = false;
    el.sheet.classList.remove('open');
    el.sheet.setAttribute('aria-hidden', 'true');
    el.scrim.classList.remove('on');
    setTimeout(() => { if (!sheetOpen) el.scrim.hidden = true; }, 260);
  }
  el.scrim.addEventListener('click', closeSheet);

  function askName(title, initial) {
    return new Promise((resolve) => {
      el.dlgTitle.textContent = title;
      el.dlgInput.value = initial || '';
      el.dlg.hidden = false;
      setTimeout(() => el.dlgInput.focus(), 30);
      const done = (val) => {
        el.dlg.hidden = true;
        el.dlgOk.removeEventListener('click', ok);
        el.dlgCancel.removeEventListener('click', cancel);
        el.dlgInput.removeEventListener('keydown', key);
        resolve(val);
      };
      const ok = () => { const v = el.dlgInput.value.trim(); done(v || null); };
      const cancel = () => done(null);
      const key = (e) => { if (e.key === 'Enter') ok(); else if (e.key === 'Escape') cancel(); };
      el.dlgOk.addEventListener('click', ok);
      el.dlgCancel.addEventListener('click', cancel);
      el.dlgInput.addEventListener('keydown', key);
    });
  }

  /* ================================================================== */
  /* Navigation                                                          */
  /* ================================================================== */
  const TAB_TITLES = { home: 'Home', search: 'Search', library: 'Your Library' };

  function entityData() {
    if (!S.ent) return null;
    if (S.ent.type === 'liked') return { kind: 'liked', name: 'Liked Songs', tracks: store.liked };
    if (S.ent.type === 'yt') {
      const c = ytTracks.get(S.ent.id);
      return { kind: 'yt', name: S.ent.name, tracks: c ? c.tracks : [], loading: !c, failed: Boolean(c && c.failed) };
    }
    if (S.ent.type === 'artist') {
      const c = artistCache.get(S.ent.name.toLowerCase());
      return { kind: 'artist', name: S.ent.name, tracks: c ? c.tracks : [], thumb: (c && c.thumbnail) || S.ent.thumb || '', loading: !c, failed: Boolean(c && c.failed) };
    }
    const p = store.playlists.find((x) => x.id === S.ent.id);
    return p ? { kind: 'playlist', name: p.name, tracks: p.tracks, p } : null;
  }

  const artistName = (t) => String(t.artist || '').split(',')[0].trim();
  const isFollowing = (name) => store.artists.some((a) => a.name.toLowerCase() === name.toLowerCase());

  function avatarEl(name, url, cls) {
    const box = mk('span', cls);
    if (url) {
      const im = document.createElement('img');
      im.src = url; im.alt = ''; im.loading = 'lazy';
      box.appendChild(im);
    } else {
      box.textContent = (name || '?').trim().charAt(0).toUpperCase();
    }
    return box;
  }

  async function loadArtist(name) {
    const key = name.toLowerCase();
    const old = artistCache.get(key);
    if (old && !old.failed) return;
    artistCache.delete(key);
    try {
      const r = await fetch('/api/artist?' + new URLSearchParams({ name }));
      if (!r.ok) throw new Error('artist');
      artistCache.set(key, await r.json());
    } catch {
      artistCache.set(key, { name, thumbnail: '', tracks: [], failed: true });
    }
    if (S.ent && S.ent.type === 'artist' && S.ent.name.toLowerCase() === key) renderEntity();
  }

  function openArtist(name, thumb) {
    if (!name) return;
    S.ent = { type: 'artist', name, thumb: thumb || '' };
    renderEntity();
    showView();
    loadArtist(name);
  }

  function toggleFollow(name, thumb) {
    if (isFollowing(name)) {
      store.artists = store.artists.filter((a) => a.name.toLowerCase() !== name.toLowerCase());
      toast('Unfollowed ' + name);
    } else {
      store.artists.unshift({ name, thumbnail: thumb || '' });
      toast('Following ' + name);
    }
    saveStore();
    renderEntity();
    renderLibrary();
  }

  function showView() {
    const entity = S.ent ? entityData() : null;
    if (S.ent && !entity) S.ent = null;
    const view = S.ent ? 'entity' : S.tab;
    $$('.view').forEach((v) => { v.hidden = v.id !== 'v-' + view; });
    $$('.tab').forEach((t) => {
      const on = t.dataset.tab === S.tab;
      t.classList.toggle('active', on);
      if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    });
    document.body.classList.toggle('is-entity', Boolean(S.ent));
    el.navBack.hidden = !S.ent;
    el.navTitle.textContent = S.ent ? entity.name : TAB_TITLES[S.tab];
    window.scrollTo(0, 0);
  }

  function goTab(tab) {
    if (S.tab === tab && !S.ent) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    S.tab = tab;
    S.ent = null;
    renderTab(tab);
    showView();
  }
  function renderTab(tab) {
    if (tab === 'home') renderHome();
    else if (tab === 'library') renderLibrary();
  }
  function openEntity(type, id) {
    S.ent = { type, id };
    renderEntity();
    showView();
  }

  $$('.tab').forEach((t) => t.addEventListener('click', () => goTab(t.dataset.tab)));
  el.navBack.addEventListener('click', () => { S.ent = null; renderTab(S.tab); showView(); });
  el.navSearch.addEventListener('click', () => { goTab('search'); setTimeout(() => el.q.focus(), 60); });
  el.navProfile.addEventListener('click', openThemes);
  el.navMenu.addEventListener('click', () => {
    if (S.ent && entityData() && entityData().kind === 'playlist') return playlistMenu(entityData().p);
    openSheet({
      title: 'Music',
      items: [
        { label: 'Listen together', run: togetherSheet },
        { label: 'Themes', run: openThemes },
        { label: 'Privacy policy', run: () => { location.href = '/privacy.html'; } },
        { label: 'Terms and conditions', run: () => { location.href = '/terms.html'; } },
      ],
    });
  });

  function openThemes() {
    openSheet({
      title: 'Themes',
      sub: 'Pick how the app looks',
      build(body) {
        const list = [
          { id: 'classic', name: 'Classic', d: 'Clean dark iOS look', img: '' },
          { id: 'kawaii', name: 'Kawaii', d: 'Soft pink with stickers', img: '/themes/kt-face.png' },
          { id: 'gotham', name: 'Gotham', d: 'Dark with a yellow signal', img: '/themes/bat-logo.png' },
        ];
        list.forEach((t) => {
          const b = mk('button', 'theme-card' + (store.theme === t.id ? ' on' : ''));
          b.type = 'button';
          const sw = mk('span', 'sw ' + t.id);
          if (t.img) {
            const im = document.createElement('img');
            im.src = t.img; im.alt = '';
            sw.appendChild(im);
          } else {
            sw.appendChild(mk('i'));
          }
          const txt = mk('span', 'tx');
          txt.append(mk('b', '', t.name), mk('span', 'd', t.d));
          b.append(sw, txt);
          b.addEventListener('click', () => { applyTheme(t.id); closeSheet(); toast(t.name + ' theme on'); });
          body.appendChild(b);
        });
      },
    });
  }

  /* ================================================================== */
  /* Track rows and lists                                                */
  /* ================================================================== */
  function trackRow(t, list, idx, src, ctx) {
    const li = mk('li');
    const row = mk('div', 'row' + (cur() && cur().id === t.id ? ' playing' : ''));
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.dataset.id = t.id;

    const img = document.createElement('img');
    img.src = thumb(t); img.alt = ''; img.loading = 'lazy'; img.width = 52; img.height = 52;
    const txt = mk('div', 'txt');
    txt.append(mk('span', 'rt', t.title), mk('span', 'ra', t.artist));
    const more = mk('button', 'ib more');
    more.type = 'button';
    more.setAttribute('aria-label', 'More options for ' + t.title);
    more.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';

    row.append(img, txt, more);
    row.addEventListener('click', () => { if (ctx && ctx.play) ctx.play(); else playList(list, idx, src); });
    row.addEventListener('keydown', (e) => {
      if (e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); row.click(); }
    });
    more.addEventListener('click', (e) => { e.stopPropagation(); trackSheet(t, ctx); });
    li.appendChild(row);
    return li;
  }

  function fillList(ul, tracks, src, ctx) {
    ul.textContent = '';
    tracks.forEach((t, i) => ul.appendChild(trackRow(t, tracks, i, src, ctx)));
  }

  function markPlaying() {
    const id = cur() && cur().id;
    $$('.row[data-id]').forEach((r) => r.classList.toggle('playing', r.dataset.id === id));
  }

  /* ---------- track menu ---------- */
  function trackSheet(t, ctx) {
    const items = [
      { label: isLiked(t.id) ? 'Remove from Liked Songs' : 'Add to Liked Songs', run: () => toggleLike(t) },
      { label: 'Add to playlist', run: () => addToPlaylistSheet(t) },
      { label: 'Play next', run: () => playNext(t) },
      { label: 'Add to queue', run: () => addToQueue(t) },
    ];
    if (artistName(t)) items.push({ label: 'Go to artist', hint: artistName(t), run: () => openArtist(artistName(t)) });
    if (ctx && ctx.removeFrom) items.push({ label: 'Remove from this playlist', danger: true, run: () => removeFromPlaylist(ctx.removeFrom, t) });
    openSheet({ title: t.title, sub: t.artist, items });
  }

  function addToPlaylistSheet(t) {
    const items = [{ label: 'New playlist', run: async () => {
      const name = await askName('New playlist', '');
      if (!name) return;
      const p = { id: newId(), name, tracks: [slim(t)] };
      store.playlists.unshift(p); saveStore();
      toast('Added to ' + name);
      if (!$('#v-library').hidden) renderLibrary();
    } }];
    store.playlists.forEach((p) => items.push({
      label: p.name,
      hint: p.tracks.some((x) => x.id === t.id) ? 'Added' : p.tracks.length + ' songs',
      run: () => {
        if (p.tracks.some((x) => x.id === t.id)) { toast('Already in ' + p.name); return; }
        p.tracks.push(slim(t)); saveStore(); toast('Added to ' + p.name);
        if (S.ent && S.ent.id === p.id) renderEntity();
      },
    }));
    openSheet({ title: 'Add to playlist', sub: t.title, items });
  }

  function removeFromPlaylist(p, t) {
    p.tracks = p.tracks.filter((x) => x.id !== t.id);
    saveStore(); renderEntity(); toast('Removed');
  }

  function toggleLike(t) {
    if (isLiked(t.id)) {
      store.liked = store.liked.filter((x) => x.id !== t.id);
      toast('Removed from Liked Songs');
    } else {
      store.liked.unshift(slim(t));
      toast('Added to Liked Songs');
    }
    saveStore();
    paintLike();
    if (S.ent && S.ent.type === 'liked') renderEntity();
    else if (!$('#v-library').hidden) renderLibrary();
  }

  /* ================================================================== */
  /* Home                                                                */
  /* ================================================================== */
  const GENRES = [
    { n: 'Bollywood hits', h: 345 }, { n: 'Tamil hits', h: 28 }, { n: 'Telugu hits', h: 200 }, { n: 'Punjabi', h: 150 },
    { n: 'Lo-fi', h: 260 }, { n: 'English pop', h: 310 }, { n: 'Hip hop', h: 40 }, { n: 'Romantic', h: 330 },
    { n: 'Workout', h: 10 }, { n: '90s hits', h: 50 }, { n: 'Indie', h: 170 }, { n: 'Devotional', h: 35 },
  ];

  function renderHome() {
    const h = new Date().getHours();
    el.greet.textContent = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';

    el.homeTiles.textContent = '';
    const liked = mk('button', 'tile');
    liked.type = 'button';
    const la = mk('span', 'tile-art lib-art liked');
    la.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M12 20.5s-7.5-4.6-9.3-9.2C1.5 8 3.4 4.8 6.6 4.8c1.9 0 3.5 1 4.4 2.6.9-1.6 2.5-2.6 4.4-2.6 3.2 0 5.1 3.2 3.9 6.5-1.8 4.6-7.3 9.2-7.3 9.2Z"/></svg>';
    la.style.borderRadius = '0';
    liked.append(la, mk('span', 'l', 'Liked Songs'));
    liked.addEventListener('click', () => openEntity('liked'));
    el.homeTiles.appendChild(liked);

    store.pinned.forEach((id) => {
      const p = store.playlists.find((x) => x.id === id);
      if (!p) return;
      el.homeTiles.appendChild(entityTile(p.name, p.tracks, () => openEntity('playlist', p.id)));
    });
    let n = el.homeTiles.children.length;
    for (const t of store.recent) {
      if (n >= 8) break;
      const idx = store.recent.indexOf(t);
      el.homeTiles.appendChild(trackTile(t, idx));
      n++;
    }

    el.homeRecent.textContent = '';
    const hasRecent = store.recent.length > 0;
    el.homeRecentWrap.hidden = !hasRecent;
    el.homeEmpty.hidden = hasRecent;
    store.recent.slice(0, 14).forEach((t, i) => {
      const c = mk('button', 'hcard');
      c.type = 'button';
      const img = document.createElement('img');
      img.src = thumb(t); img.alt = ''; img.loading = 'lazy'; img.width = 140; img.height = 140;
      c.append(img, mk('span', 'rt', t.title), mk('span', 'ra', t.artist));
      c.addEventListener('click', () => playList(store.recent, i, 'Recently played'));
      el.homeRecent.appendChild(c);
    });

    el.homeArtists.textContent = '';
    el.homeArtistsWrap.hidden = !store.artists.length;
    store.artists.slice(0, 14).forEach((a) => {
      const c = mk('button', 'acard');
      c.type = 'button';
      c.append(avatarEl(a.name, a.thumbnail, 'av'), mk('span', 'rt', a.name));
      c.addEventListener('click', () => openArtist(a.name, a.thumbnail));
      el.homeArtists.appendChild(c);
    });

    el.homeChips.textContent = '';
    GENRES.slice(0, 8).forEach((g) => {
      const c = mk('button', 'chip', g.n);
      c.type = 'button';
      c.addEventListener('click', () => searchFor(g.n));
      el.homeChips.appendChild(c);
    });
  }

  function trackTile(t, idx) {
    const b = mk('button', 'tile');
    b.type = 'button';
    const img = document.createElement('img');
    img.src = thumb(t); img.alt = ''; img.width = 56; img.height = 56;
    b.append(img, mk('span', 'l', t.title));
    b.addEventListener('click', () => playList(store.recent, idx, 'Recently played'));
    return b;
  }
  function entityTile(name, tracks, run) {
    const b = mk('button', 'tile');
    b.type = 'button';
    b.append(collageEl(tracks, 'tile-art lib-art collage', 56), mk('span', 'l', name));
    b.addEventListener('click', run);
    return b;
  }
  function collageEl(tracks, cls, size) {
    const box = mk('span', cls);
    box.style.borderRadius = '0';
    const pics = tracks.slice(0, 4);
    if (!pics.length) {
      box.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M9 4.5a1 1 0 0 1 .8-1l9-1.5A1 1 0 0 1 20 3v12.4a3.5 3.5 0 1 1-2-3.1V5.2l-7 1.2v10a3.5 3.5 0 1 1-2-3.1Z"/></svg>';
      return box;
    }
    if (pics.length < 4) {
      const img = document.createElement('img');
      img.src = thumb(pics[0]); img.alt = ''; img.width = size; img.height = size;
      box.style.display = 'block';
      box.appendChild(img);
      return box;
    }
    pics.forEach((t) => {
      const img = document.createElement('img');
      img.src = thumb(t); img.alt = ''; box.appendChild(img);
    });
    return box;
  }

  /* ================================================================== */
  /* Search                                                              */
  /* ================================================================== */
  function renderBrowse() {
    el.browseGrid.textContent = '';
    GENRES.forEach((g) => {
      const b = mk('button', 'btile', g.n);
      b.type = 'button';
      b.style.setProperty('--h', g.h);
      b.addEventListener('click', () => searchFor(g.n));
      el.browseGrid.appendChild(b);
    });
  }

  const SEARCH_ERR = 'Could not search right now. Check that the server is running and your internet works.';
  let searchToken = 0;

  async function runSearch(q) {
    const token = ++searchToken;
    loadArtists(q, token);
    el.searchNote.hidden = true;
    renderArtistRow([]);
    el.browse.hidden = true;
    el.results.hidden = false;
    el.results.textContent = '';
    el.results.appendChild(mk('li', 'notice', 'Searching'));
    try {
      const r = await fetch('/api/search?q=' + encodeURIComponent(q));
      if (!r.ok) throw new Error('search');
      const d = await r.json();
      if (token !== searchToken) return;
      S.results = d.results || [];
      if (!S.results.length) {
        el.results.textContent = '';
        el.searchNote.textContent = 'No songs found. Try different words.';
        el.searchNote.hidden = false;
        return;
      }
      el.songsHead.hidden = false;
      fillList(el.results, S.results, 'Search: ' + q);
    } catch {
      if (token !== searchToken) return;
      el.results.textContent = '';
      el.searchNote.textContent = SEARCH_ERR;
      el.searchNote.hidden = false;
    }
  }

  function renderArtistRow(list) {
    el.artistRow.textContent = '';
    el.artistsWrap.hidden = !list.length;
    el.songsHead.hidden = true;
    list.forEach((a) => {
      const c = mk('button', 'acard');
      c.type = 'button';
      c.append(avatarEl(a.name, a.thumbnail, 'av'), mk('span', 'rt', a.name));
      c.addEventListener('click', () => openArtist(a.name, a.thumbnail));
      el.artistRow.appendChild(c);
    });
  }
  async function loadArtists(q, token) {
    try {
      const r = await fetch('/api/artists?q=' + encodeURIComponent(q));
      if (!r.ok) return;
      const d = await r.json();
      if (token !== searchToken) return;
      renderArtistRow((d.results || []).slice(0, 8));
      if (S.results.length) el.songsHead.hidden = false;
    } catch { /* artists are a bonus */ }
  }

  function searchFor(q) {
    goTab('search');
    el.q.value = q;
    runSearch(q);
  }

  el.searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = el.q.value.trim();
    if (!q) {
      searchToken++;
      el.results.hidden = true; el.results.textContent = '';
      el.searchNote.hidden = true; el.browse.hidden = false;
      renderArtistRow([]);
      return;
    }
    el.q.blur();
    runSearch(q);
  });
  el.q.addEventListener('input', () => {
    if (!el.q.value.trim()) {
      searchToken++;
      el.results.hidden = true; el.results.textContent = '';
      el.searchNote.hidden = true; el.browse.hidden = false;
      renderArtistRow([]);
    }
  });

  /* ================================================================== */
  /* Library and playlist pages                                          */
  /* ================================================================== */
  function renderLibrary() {
    el.libList.textContent = '';
    const liked = mk('li');
    const lr = mk('button', 'row');
    lr.type = 'button';
    const la = mk('span', 'lib-art liked');
    la.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M12 20.5s-7.5-4.6-9.3-9.2C1.5 8 3.4 4.8 6.6 4.8c1.9 0 3.5 1 4.4 2.6.9-1.6 2.5-2.6 4.4-2.6 3.2 0 5.1 3.2 3.9 6.5-1.8 4.6-7.3 9.2-7.3 9.2Z"/></svg>';
    const lt = mk('span', 'txt');
    lt.append(mk('span', 'rt', 'Liked Songs'), mk('span', 'ra', 'Playlist \u00b7 ' + store.liked.length + (store.liked.length === 1 ? ' song' : ' songs')));
    lr.append(la, lt);
    lr.addEventListener('click', () => openEntity('liked'));
    liked.appendChild(lr);
    el.libList.appendChild(liked);

    store.artists.forEach((a) => {
      const li = mk('li');
      const r = mk('button', 'row');
      r.type = 'button';
      const art = avatarEl(a.name, a.thumbnail, 'lib-art round');
      const tx = mk('span', 'txt');
      tx.append(mk('span', 'rt', a.name), mk('span', 'ra', 'Artist'));
      r.append(art, tx);
      r.addEventListener('click', () => openArtist(a.name, a.thumbnail));
      li.appendChild(r);
      el.libList.appendChild(li);
    });

    store.playlists.forEach((p) => {
      const li = mk('li');
      const r = mk('button', 'row');
      r.type = 'button';
      const art = collageEl(p.tracks, 'lib-art collage', 52);
      art.style.borderRadius = '8px';
      const tx = mk('span', 'txt');
      tx.append(mk('span', 'rt', p.name), mk('span', 'ra', 'Playlist \u00b7 ' + p.tracks.length + (p.tracks.length === 1 ? ' song' : ' songs')));
      r.append(art, tx);
      r.addEventListener('click', () => openEntity('playlist', p.id));
      li.appendChild(r);
      el.libList.appendChild(li);
    });
    renderYt();
  }

  el.ytSignIn.addEventListener('click', ytSignIn);
  el.ytSignOut.addEventListener('click', ytSignOut);

  el.newPlaylist.addEventListener('click', async () => {
    const name = await askName('New playlist', '');
    if (!name) return;
    const p = { id: newId(), name, tracks: [] };
    store.playlists.unshift(p); saveStore();
    renderLibrary();
    openEntity('playlist', p.id);
  });

  function renderEntity() {
    const e = entityData();
    if (!e) { S.ent = null; return; }
    el.navTitle.textContent = e.name;
    el.entTitle.textContent = e.name;
    const n = e.tracks.length;
    const secs = e.tracks.reduce((a, t) => a + (t.duration || 0), 0);
    el.entMeta.textContent = (e.kind === 'artist' ? 'Artist \u00b7 ' : e.kind === 'yt' ? 'YouTube playlist \u00b7 ' : '') + n + (n === 1 ? ' song' : ' songs') + (secs ? ' \u00b7 ' + Math.max(1, Math.round(secs / 60)) + ' min' : '');

    el.entArt.textContent = '';
    el.entArt.classList.toggle('round', e.kind === 'artist');
    const inner = mk('div', 'in');
    if (e.kind === 'artist') {
      if (e.thumb) { const im = document.createElement('img'); im.src = e.thumb; im.alt = ''; inner.appendChild(im); }
      else inner.appendChild(mk('span', 'initial', e.name.charAt(0).toUpperCase()));
    } else if (e.kind === 'liked') {
      inner.classList.add('liked');
      inner.innerHTML = '<svg viewBox="0 0 24 24" width="84" height="84" aria-hidden="true"><path d="M12 20.5s-7.5-4.6-9.3-9.2C1.5 8 3.4 4.8 6.6 4.8c1.9 0 3.5 1 4.4 2.6.9-1.6 2.5-2.6 4.4-2.6 3.2 0 5.1 3.2 3.9 6.5-1.8 4.6-7.3 9.2-7.3 9.2Z"/></svg>';
    } else if (n >= 4) {
      inner.classList.add('grid');
      e.tracks.slice(0, 4).forEach((t) => { const im = document.createElement('img'); im.src = thumb(t); im.alt = ''; inner.appendChild(im); });
    } else if (n > 0) {
      const im = document.createElement('img'); im.src = thumb(e.tracks[0]); im.alt = ''; inner.appendChild(im);
    } else {
      inner.innerHTML = '<svg viewBox="0 0 24 24" width="70" height="70" aria-hidden="true" style="color:var(--text-2)"><path d="M9 4.5a1 1 0 0 1 .8-1l9-1.5A1 1 0 0 1 20 3v12.4a3.5 3.5 0 1 1-2-3.1V5.2l-7 1.2v10a3.5 3.5 0 1 1-2-3.1Z"/></svg>';
    }
    el.entArt.appendChild(inner);

    el.entPin.hidden = e.kind !== 'playlist' && e.kind !== 'artist';
    el.entMore.hidden = e.kind !== 'playlist' && e.kind !== 'yt';
    if (e.kind === 'playlist') {
      el.entPin.classList.toggle('liked', store.pinned.includes(e.p.id));
      el.entPin.setAttribute('aria-label', 'Pin to Home');
    } else if (e.kind === 'artist') {
      const f = isFollowing(e.name);
      el.entPin.classList.toggle('liked', f);
      el.entPin.setAttribute('aria-label', f ? 'Unfollow ' + e.name : 'Follow ' + e.name);
    }
    el.entShuffle.classList.toggle('on', store.shuffle);
    el.entShuffle.setAttribute('aria-pressed', String(store.shuffle));
    el.entPlay.disabled = n === 0;
    el.entPlay.style.opacity = n === 0 ? '0.4' : '1';

    fillList(el.entList, e.tracks, e.name, e.kind === 'playlist' ? { removeFrom: e.p } : null);
    el.entEmpty.hidden = n > 0;
    if (n === 0) {
      if (e.kind === 'artist' || e.kind === 'yt') {
        el.entEmptyT.textContent = e.loading ? 'Loading songs' : 'No songs found';
        el.entEmptyS.textContent = e.failed ? 'Could not load this. Check your internet, sign in again if needed, and open it again.' : (e.loading ? 'One moment.' : 'Nothing playable is in here.');
      } else {
        el.entEmptyT.textContent = e.kind === 'liked' ? 'No liked songs yet' : 'This playlist is empty';
        el.entEmptyS.textContent = e.kind === 'liked' ? 'Tap the heart on a song to save it here.' : 'Use the three dots on any song and pick Add to playlist.';
      }
    }
  }

  el.entPlay.addEventListener('click', () => {
    const e = entityData();
    if (e && e.tracks.length) playList(e.tracks, -1, e.name);
  });
  el.entShuffle.addEventListener('click', toggleShuffle);
  el.entPin.addEventListener('click', () => {
    const e = entityData();
    if (e && e.kind === 'artist') { toggleFollow(e.name, e.thumb); return; }
    if (!e || e.kind !== 'playlist') return;
    const i = store.pinned.indexOf(e.p.id);
    if (i >= 0) { store.pinned.splice(i, 1); toast('Unpinned from Home'); } else { store.pinned.unshift(e.p.id); toast('Pinned to Home'); }
    saveStore();
    renderEntity();
  });
  el.entMore.addEventListener('click', () => {
    const e = entityData();
    if (!e) return;
    if (e.kind === 'playlist') { playlistMenu(e.p); return; }
    if (e.kind === 'yt') {
      openSheet({
        title: e.name,
        sub: e.tracks.length + ' songs',
        items: [{ label: 'Copy to my playlists', run: () => {
          const p = { id: newId(), name: e.name, tracks: e.tracks.map(slim) };
          store.playlists.unshift(p); saveStore(); renderLibrary(); toast('Copied to your playlists');
        } }],
      });
    }
  });

  function playlistMenu(p) {
    openSheet({
      title: p.name,
      sub: p.tracks.length + ' songs',
      items: [
        { label: 'Rename', run: async () => {
          const name = await askName('Rename playlist', p.name);
          if (!name) return;
          p.name = name; saveStore(); renderEntity(); el.navTitle.textContent = name;
        } },
        { label: 'Delete playlist', danger: true, run: () => {
          openSheet({
            title: 'Delete "' + p.name + '"?',
            sub: 'This can not be undone.',
            items: [{ label: 'Delete', danger: true, run: () => {
              store.playlists = store.playlists.filter((x) => x.id !== p.id);
              store.pinned = store.pinned.filter((x) => x !== p.id);
              saveStore(); S.ent = null; renderLibrary(); showView(); toast('Playlist deleted');
            } }, { label: 'Cancel' }],
          });
        } },
      ],
    });
  }

  /* ================================================================== */
  /* Playback                                                            */
  /* ================================================================== */
  function guestBlock() {
    if (T.role !== 'guest') return false;
    toast('Only the host controls playback. Leave the session to play your own music.');
    return true;
  }

  function playList(list, idx, src) {
    if (!list || !list.length || guestBlock()) return;
    let start = idx;
    if (start < 0) start = store.shuffle ? Math.floor(Math.random() * list.length) : 0;
    if (start >= list.length) start = 0;
    if (store.shuffle) {
      const first = list[start];
      S.queue = [first, ...shuffled(list.filter((_, i) => i !== start))];
      start = 0;
    } else {
      S.queue = list.slice();
    }
    S.source = src || '';
    loadAt(start);
    if (store.smart) smartShuffle();
  }

  function playNext(t) {
    if (guestBlock()) return;
    if (!cur()) { S.queue = [t]; S.source = 'Your queue'; loadAt(0); return; }
    S.queue.splice(S.qi + 1, 0, t);
    renderQueue();
    toast('Plays next');
  }
  function addToQueue(t) {
    if (guestBlock()) return;
    if (!cur()) { S.queue = [t]; S.source = 'Your queue'; loadAt(0); return; }
    S.queue.push(t);
    renderQueue();
    toast('Added to queue');
  }

  function loadAt(i, start = 0) {
    const t = S.queue[i];
    if (!t) return;
    S.qi = i;
    audio.load(t.playId || t.id, start);
    document.body.classList.add('has-track');
    paintNow(t);
    pushRecent(t);
    startLyrics(t);
    updateMediaSession();
    markPlaying();
    if (T.role !== 'guest' && S.queue.length - 1 - S.qi < 3) extendQueue();
    tgPush(true, { playing: true, position: 0 });
  }

  function pushRecent(t) {
    store.recent = [slim(t), ...store.recent.filter((x) => x.id !== t.id)].slice(0, 30);
    saveStore();
  }

  function step(dir) {
    if (!cur() || guestBlock()) return;
    if (dir < 0 && audio.currentTime > 3) { audio.currentTime = 0; return; }
    const n = S.qi + dir;
    if (n < 0) { audio.currentTime = 0; return; }
    if (n >= S.queue.length) {
      const from = S.qi;
      extendQueue().then(() => {
        if (S.qi !== from) return;
        if (S.qi + 1 < S.queue.length) loadAt(S.qi + 1);
        else { audio.pause(); audio.currentTime = 0; }
      });
      return;
    }
    loadAt(n);
  }

  function toggle() {
    const t = cur();
    if (!t || guestBlock()) return;
    if (audio.error) { loadAt(S.qi); return; }
    if (audio.paused) audio.play(); else audio.pause();
  }

  function toggleShuffle() {
    if (guestBlock()) return;
    store.shuffle = !store.shuffle;
    saveStore();
    if (store.shuffle && cur()) {
      S.queue = [...S.queue.slice(0, S.qi + 1), ...shuffled(S.queue.slice(S.qi + 1))];
      renderQueue();
    }
    paintShuffle();
    toast(store.shuffle ? 'Shuffle on' : 'Shuffle off');
  }
  function paintSmart() {
    [el.npSmart, el.entSmart].forEach((b) => { b.classList.toggle('on', store.smart); b.setAttribute('aria-pressed', String(store.smart)); });
  }
  function toggleSmart() {
    if (guestBlock()) return;
    store.smart = !store.smart;
    saveStore();
    paintSmart();
    toast(store.smart ? 'Smart shuffle on. New songs you may like get mixed in.' : 'Smart shuffle off');
    if (store.smart) smartShuffle();
  }
  el.npSmart.addEventListener('click', toggleSmart);
  el.entSmart.addEventListener('click', toggleSmart);

  function paintShuffle() {
    [el.npShuffle, el.entShuffle].forEach((b) => { b.classList.toggle('on', store.shuffle); b.setAttribute('aria-pressed', String(store.shuffle)); });
  }

  /* ---------- smart shuffle: a taste based mix from the server ---------- */
  const firstArtist = (a) => String(a || '').split(',')[0].trim().toLowerCase();
  const noBar = (s) => String(s || '').replace(/\|/g, ' ');

  function smartParams() {
    const t = cur();
    const pool = [...store.liked, ...store.recent];
    const seeds = [];
    const seen = new Set();
    const add = (x) => { if (x && !seen.has(x.id) && seeds.length < 6) { seen.add(x.id); seeds.push(x); } };
    add(t);
    pool.forEach(add);
    const count = new Map();
    pool.forEach((x) => { const k = noBar(firstArtist(x.artist)); if (k) count.set(k, (count.get(k) || 0) + 1); });
    const artists = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map((e) => e[0]);
    const avoid = [...new Set(S.queue.slice(Math.max(0, S.qi - 2), S.qi + 1).map((x) => noBar(firstArtist(x.artist))).filter(Boolean))];
    return new URLSearchParams({
      seeds: seeds.map((x) => x.id).join(','),
      titles: seeds.map((x) => noBar(x.title)).join('|'),
      artists: artists.join('|'),
      avoid: avoid.join('|'),
      exclude: S.queue.slice(-60).map((x) => x.id).join(','),
      limit: '12',
    });
  }
  async function fetchRecommended() {
    const r = await fetch('/api/recommend?' + smartParams());
    if (!r.ok) return [];
    const d = await r.json();
    return d.results || [];
  }

  // Like Spotify's smart shuffle: after every few songs in the shuffled queue, one new song you may like.
  let smartBusy = false;
  async function smartShuffle() {
    if (!store.smart || !cur() || smartBusy) return;
    smartBusy = true;
    try {
      const from = cur().id;
      const have = new Set(S.queue.map((x) => x.id));
      const recs = (await fetchRecommended()).filter((x) => !have.has(x.id)).slice(0, 8);
      if (!recs.length || !store.smart || !cur() || cur().id !== from) return;
      const head = S.queue.slice(0, S.qi + 1);
      const tail = S.queue.slice(S.qi + 1);
      const out = [];
      let r = 0;
      tail.forEach((t, i) => {
        out.push(t);
        if ((i + 1) % 3 === 0 && r < recs.length) out.push(recs[r++]);
      });
      while (r < recs.length) out.push(recs[r++]);
      S.queue = [...head, ...out];
      renderQueue();
      toast('Smart shuffle added ' + recs.length + ' songs');
    } catch { /* the queue just stays as it is */ } finally { smartBusy = false; }
  }

  /* ---------- autoplay: related songs keep the queue going ---------- */
  let extending = null;
  async function fetchRelated(q) {
    const exclude = S.queue.slice(-60).map((x) => x.id).join(',');
    const r = await fetch('/api/related?' + new URLSearchParams({ q, exclude }));
    if (!r.ok) return [];
    const d = await r.json();
    return d.results || [];
  }
  function extendQueue() {
    if (extending) return extending;
    const t = cur();
    if (!t) return Promise.resolve();
    extending = (async () => {
      const tries = [(t.title + ' ' + t.artist).trim(), (t.artist || '').split(',')[0].trim()].filter(Boolean);
      const sources = tries.map((q) => () => fetchRelated(q));
      if (store.smart) sources.unshift(fetchRecommended);
      for (const get of sources) {
        const have = new Set(S.queue.map((x) => x.id));
        const fresh = (await get().catch(() => [])).filter((x) => !have.has(x.id));
        if (fresh.length) { S.queue.push(...(store.shuffle ? shuffled(fresh) : fresh)); break; }
      }
      renderQueue();
    })().catch(() => {}).finally(() => { extending = null; });
    return extending;
  }

  /* ---------- paint the player ---------- */
  function setMarquee(box, text) {
    const sp = box.firstElementChild;
    sp.classList.remove('marquee');
    sp.style.removeProperty('--shift');
    sp.textContent = text;
    requestAnimationFrame(() => {
      const over = sp.scrollWidth - box.clientWidth;
      if (over > 4) { sp.style.setProperty('--shift', -over + 'px'); sp.classList.add('marquee'); }
    });
  }

  function paintNow(t) {
    el.miniArt.src = thumb(t);
    setMarquee(el.miniTitle, t.title);
    setMarquee(el.miniArtist, t.artist);
    el.npTitle.textContent = t.title;
    el.npArtist.textContent = t.artist;
    el.npFrom.textContent = T.role ? 'Listening together' : (S.source || 'Your queue');
    document.title = t.title + ' | Music';
    el.seek.value = '0'; setPaint(el.seek);
    el.cur.textContent = '0:00'; el.dur.textContent = fmt(t.duration);
    el.miniBar.style.width = '0%';
    paintLike();
    renderQueue();
  }

  function paintLike() {
    const t = cur();
    const on = Boolean(t && isLiked(t.id));
    el.npLike.classList.toggle('liked', on);
    el.npLike.setAttribute('aria-label', on ? 'Remove from Liked Songs' : 'Add to Liked Songs');
  }

  function renderQueue() {
    const next = S.queue.slice(S.qi + 1, S.qi + 26);
    el.npQueue.textContent = '';
    if (!next.length) { el.npQueue.appendChild(mk('li', 'lyr-msg', 'Related songs are added when the queue runs out.')); return; }
    next.forEach((t, i) => {
      const at = S.qi + 1 + i;
      el.npQueue.appendChild(trackRow(t, S.queue, at, S.source, { play: () => loadAt(at) }));
    });
  }

  function setPlayingUI(playing) {
    [el.miniPlay, el.npPlay].forEach((b) => {
      $('.i-play', b).hidden = playing;
      $('.i-pause', b).hidden = !playing;
      b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    });
    document.body.classList.toggle('is-playing', playing);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }

  const dur = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : ((cur() && cur().duration) || 0));

  function updateTime() {
    const c = audio.currentTime || 0;
    const d = dur();
    syncLyrics(c);
    el.miniBar.style.width = d ? Math.min(100, c / d * 100).toFixed(2) + '%' : '0%';
    if (S.seeking) return;
    el.cur.textContent = fmt(c);
    el.dur.textContent = d ? '-' + fmt(Math.max(0, d - c)) : '0:00';
    if (d) { el.seek.value = String(Math.round(c / d * 1000)); setPaint(el.seek); }
  }

  el.seek.addEventListener('input', () => {
    S.seeking = true;
    const d = dur();
    el.cur.textContent = fmt(d * Number(el.seek.value) / 1000);
    setPaint(el.seek);
  });
  el.seek.addEventListener('change', () => {
    const d = dur();
    if (guestBlock()) { S.seeking = false; updateTime(); return; }
    if (d) audio.currentTime = d * Number(el.seek.value) / 1000;
    S.seeking = false;
    updatePosition();
    tgPush(true);
  });

  /* ---------- engine events ---------- */
  let errTimer = 0;
  audio.addEventListener('play', () => { setPlayingUI(true); tgPush(true); });
  audio.addEventListener('pause', () => { setPlayingUI(false); tgPush(true); });
  audio.addEventListener('playing', () => {
    clearTimeout(errTimer);
    updatePosition();
    // A guest who joined while the host is paused should not start playing.
    if (T.role === 'guest' && T.last && !T.last.playing) audio.pause();
  });
  audio.addEventListener('timeupdate', updateTime);
  audio.addEventListener('durationchange', updateTime);
  audio.addEventListener('ended', () => { if (T.role !== 'guest') step(1); });
  audio.addEventListener('error', () => {
    const t = cur();
    if (!t) return;
    const code = audio.error && audio.error.code;
    if (code === 152 || code === 153) {
      toast('YouTube blocked the player on this page (error ' + code + '). Open the app in a normal browser tab from its web address.');
      return;
    }
    if (!t.altTried) {
      t.altTried = true;
      toast('Finding another version of this song');
      findAlternative(t).then((found) => { if (!found && cur() === t) giveUp(t, code); });
      return;
    }
    giveUp(t, code);
  });

  function giveUp(t, code) {
    const skip = T.role === 'guest' ? '' : ' Skipping.';
    toast(code === 100 ? 'This song is not available.' + skip
      : (code === 101 || code === 150) ? 'The owner does not allow this song to play here.' + skip
      : 'This song can not be played (error ' + code + ').' + skip);
    if (T.role === 'guest') return; // the host skips and everyone follows
    errTimer = setTimeout(() => { if (cur() === t && audio.error) step(1); }, 2200);
  }

  // Some songs forbid playing outside YouTube. The server looks for another upload of the same song.
  async function findAlternative(t) {
    try {
      const q = new URLSearchParams({ id: t.id, title: t.title, artist: t.artist || '', duration: String(Math.round(t.duration || 0)) });
      const r = await fetch('/api/playable?' + q);
      if (!r.ok) return false;
      const d = await r.json();
      if (!d.alt || !d.id || d.id === (t.playId || t.id) || cur() !== t) return false;
      t.playId = d.id;
      audio.load(d.id, 0);
      return true;
    } catch {
      return false;
    }
  }

  /* ---------- buttons ---------- */
  el.miniPlay.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  el.miniNext.addEventListener('click', (e) => { e.stopPropagation(); step(1); });
  el.npPlay.addEventListener('click', toggle);
  el.npNext.addEventListener('click', () => step(1));
  el.npPrev.addEventListener('click', () => step(-1));
  el.npShuffle.addEventListener('click', toggleShuffle);
  el.npLike.addEventListener('click', () => { if (cur()) toggleLike(cur()); });
  el.npAdd.addEventListener('click', () => { if (cur()) addToPlaylistSheet(cur()); });
  el.npMore.addEventListener('click', () => { if (cur()) trackSheet(cur()); });
  el.npArtist.style.cursor = 'pointer';
  el.npArtist.addEventListener('click', () => { if (cur() && artistName(cur())) { closeNP(); openArtist(artistName(cur())); } });
  el.mini.addEventListener('click', openNP);
  el.mini.addEventListener('keydown', (e) => { if (e.target === el.mini && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openNP(); } });
  el.npClose.addEventListener('click', closeNP);

  function openNP() {
    if (!cur()) return;
    el.np.classList.add('open');
    el.np.setAttribute('aria-hidden', 'false');
    document.body.classList.add('np-open');
    renderQueue();
    requestAnimationFrame(() => centerLyric(false));
  }
  function closeNP() {
    el.np.classList.remove('open');
    el.np.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('np-open');
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!el.dlg.hidden) return;
      if (sheetOpen) closeSheet(); else closeNP();
      return;
    }
    if (e.code === 'Space') {
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' || (e.target && e.target.getAttribute && e.target.getAttribute('role') === 'button')) return;
      if (cur()) { e.preventDefault(); toggle(); }
    }
  });

  /* ================================================================== */
  /* Synced lyrics (LrcLib through our server)                           */
  /* ================================================================== */
  const LYR_NOISE = /\s*[\(\[][^\)\]]*(official|video|audio|lyric|visuali[sz]er|hd|4k|mv)[^\)\]]*[\)\]]/gi;
  let lyricLines = [];
  let lyricActive = -1;
  let lyricsFor = null;
  let lyricsReady = false;

  function parseLRC(text) {
    const lines = [];
    for (const raw of String(text).split('\n')) {
      const stamps = [...raw.matchAll(/\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
      if (!stamps.length) continue;
      const words = raw.replace(/\[[^\]]*\]/g, '').trim();
      for (const m of stamps) {
        const frac = m[3] ? Number('0.' + m[3]) : 0;
        lines.push({ time: Number(m[1]) * 60 + Number(m[2]) + frac, text: words });
      }
    }
    return lines.sort((a, b) => a.time - b.time);
  }
  function lineIndexAt(lines, t) {
    let lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].time <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return ans;
  }
  function setLyricsMsg(text) {
    lyricLines = [];
    lyricActive = -1;
    lyricsReady = false;
    el.lyrBody.textContent = '';
    el.lyrBody.classList.add('plain');
    if (text) el.lyrBody.appendChild(mk('div', 'lyr-msg', text));
  }
  async function startLyrics(t) {
    lyricsFor = t.id;
    setLyricsMsg('Loading lyrics');
    try {
      const q = new URLSearchParams({
        title: t.title.replace(LYR_NOISE, '').trim(),
        artist: (t.artist || '').split(',')[0].trim(),
        duration: String(Math.round(t.duration || 0)),
      });
      const r = await fetch('/api/lyrics?' + q);
      if (!r.ok) throw new Error('lyrics');
      const d = await r.json();
      if (lyricsFor !== t.id) return;
      const lines = d.synced ? parseLRC(d.synced) : [];
      if (lines.length) {
        el.lyrBody.textContent = '';
        el.lyrBody.classList.remove('plain');
        lyricLines = lines;
        lyricActive = -1;
        lyricsReady = true;
        lines.forEach((l) => {
          const div = mk('div', 'lyr-line', l.text || '\u00A0');
          div.addEventListener('click', () => { if (guestBlock()) return; audio.currentTime = l.time; tgPush(true); });
          el.lyrBody.appendChild(div);
        });
        syncLyrics(audio.currentTime || 0, true);
      } else if (d.plain) {
        setLyricsMsg('');
        el.lyrBody.appendChild(mk('div', 'lyr-plain', d.plain));
      } else {
        setLyricsMsg('No lyrics found for this song.');
      }
    } catch {
      if (lyricsFor === t.id) setLyricsMsg('Could not load lyrics.');
    }
  }
  function centerLyric(smooth) {
    if (lyricActive < 0 || !document.body.classList.contains('np-open')) return;
    const line = el.lyrBody.children[lyricActive];
    if (!line) return;
    el.lyrBody.scrollTo({ top: line.offsetTop - el.lyrBody.clientHeight / 2 + line.offsetHeight / 2, behavior: smooth ? 'smooth' : 'auto' });
  }
  function syncLyrics(t, force) {
    if (!lyricLines.length) return;
    const i = lineIndexAt(lyricLines, t);
    if (i === lyricActive && !force) return;
    const kids = el.lyrBody.children;
    if (kids[lyricActive]) kids[lyricActive].classList.remove('active');
    lyricActive = i;
    if (i < 0 || !kids[i]) return;
    kids[i].classList.add('active');
    centerLyric(true);
  }

  /* ================================================================== */
  /* Lock screen and media keys                                          */
  /* ================================================================== */
  function updateMediaSession() {
    if (!('mediaSession' in navigator) || !cur()) return;
    const t = cur();
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist,
      album: S.source || 'Music',
      artwork: [
        { src: thumb(t), sizes: '512x512' },
        { src: 'https://i.ytimg.com/vi/' + t.id + '/hqdefault.jpg', sizes: '480x360', type: 'image/jpeg' },
      ],
    });
  }
  function updatePosition() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    const d = audio.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    try {
      navigator.mediaSession.setPositionState({ duration: d, position: Math.min(audio.currentTime || 0, d), playbackRate: 1 });
    } catch { /* not supported */ }
  }
  (function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const set = (name, fn) => { try { navigator.mediaSession.setActionHandler(name, fn); } catch { /* not supported */ } };
    set('play', () => { if (cur()) audio.play(); });
    set('pause', () => { if (cur()) audio.pause(); });
    set('previoustrack', () => step(-1));
    set('nexttrack', () => step(1));
    set('seekto', (d) => { if (cur() && !guestBlock() && Number.isFinite(d.seekTime)) { audio.currentTime = d.seekTime; updatePosition(); tgPush(true); } });
    set('seekbackward', (d) => { if (guestBlock()) return; audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10)); updatePosition(); });
    set('seekforward', (d) => { if (guestBlock()) return; audio.currentTime = Math.min(dur() || 1e9, audio.currentTime + (d.seekOffset || 10)); updatePosition(); });
  })();

  /* ================================================================== */
  /* Google sign in: your YouTube Music playlists (read only)            */
  /* ================================================================== */
  /*
   * Uses Google's official sign in and the YouTube Data API, straight from the browser. The access token
   * stays in this page's memory, is never sent to our server, and only allows reading your playlists.
   */
  const G = { clientId: '', token: '', exp: 0, client: null };
  let ytLists = [];
  let ytListsFailed = false;
  const ytTracks = new Map(); // playlist id -> { tracks, failed }
  const TITLE_NOISE = /\s*[\(\[][^\)\]]*(official|video|audio|lyric|visuali[sz]er|hd|4k|mv)[^\)\]]*[\)\]]/gi;

  function tidyTrack(t) {
    const cleaned = String(t.title || '').replace(TITLE_NOISE, '').trim();
    const channel = String(t.artist || '').replace(/\s*-\s*Topic$/i, '').trim();
    const m = cleaned.match(/^(.+?)\s+-\s+(.+)$/);
    return Object.assign({}, t, { title: (m ? m[2] : cleaned) || cleaned || 'Unknown title', artist: m ? m[1].trim() : channel });
  }

  function parseIso(d) {
    const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d || '');
    return m ? (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) : 0;
  }

  function loadGsi() {
    return new Promise((resolve, reject) => {
      if (window.google && window.google.accounts && window.google.accounts.oauth2) { resolve(); return; }
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('gsi'));
      document.head.appendChild(s);
    });
  }

  function ytSignedIn() { return Boolean(G.token) && Date.now() < G.exp; }

  async function ytSignIn() {
    if (!G.clientId) { toast('Google sign in is not set up. See DEPLOY.md.'); return; }
    try { await loadGsi(); } catch { toast('Could not load Google sign in. Check your internet.'); return; }
    if (!G.client) {
      G.client = window.google.accounts.oauth2.initTokenClient({
        client_id: G.clientId,
        scope: 'https://www.googleapis.com/auth/youtube.readonly',
        callback: (resp) => {
          if (!resp || resp.error || !resp.access_token) { toast('Google sign in was cancelled.'); return; }
          G.token = resp.access_token;
          G.exp = Date.now() + (Number(resp.expires_in) || 3600) * 1000 - 60_000;
          toast('Signed in');
          loadYtLists();
        },
        error_callback: () => toast('Google sign in was cancelled.'),
      });
    }
    G.client.requestAccessToken();
  }

  function ytSignOut() {
    try {
      if (G.token && window.google && window.google.accounts && window.google.accounts.oauth2) window.google.accounts.oauth2.revoke(G.token, () => {});
    } catch { /* ignore */ }
    G.token = ''; G.exp = 0;
    ytLists = []; ytTracks.clear();
    if (S.ent && S.ent.type === 'yt') { S.ent = null; showView(); }
    renderLibrary();
    toast('Signed out');
  }

  async function ytApi(path, params) {
    if (!ytSignedIn()) { const e = new Error('auth'); e.auth = true; throw e; }
    const u = new URL('https://www.googleapis.com/youtube/v3/' + path);
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
    const r = await fetch(u, { headers: { Authorization: 'Bearer ' + G.token } });
    if (r.status === 401) { G.token = ''; G.exp = 0; const e = new Error('auth'); e.auth = true; throw e; }
    if (!r.ok) { const e = new Error('youtube ' + r.status); e.status = r.status; throw e; }
    return r.json();
  }

  async function loadYtLists() {
    ytListsFailed = false;
    try {
      const lists = [{ id: 'LIKED', title: 'Liked on YouTube', count: 0, thumb: '' }];
      let pageToken = '';
      for (let i = 0; i < 3; i++) {
        const params = { part: 'snippet,contentDetails', mine: 'true', maxResults: '50' };
        if (pageToken) params.pageToken = pageToken;
        const d = await ytApi('playlists', params);
        for (const it of d.items || []) {
          const sn = it.snippet || {};
          const th = sn.thumbnails || {};
          lists.push({ id: it.id, title: sn.title || 'Playlist', count: (it.contentDetails && it.contentDetails.itemCount) || 0, thumb: (th.medium || th.default || {}).url || '' });
        }
        pageToken = d.nextPageToken || '';
        if (!pageToken) break;
      }
      ytLists = lists;
    } catch (err) {
      ytListsFailed = true;
      if (err.auth) toast('Please sign in with Google again.');
      else if (err.status === 403) toast('YouTube refused access. Check that YouTube Data API v3 is turned on (see DEPLOY.md).');
      else toast('Could not load your YouTube playlists.');
    }
    renderLibrary();
  }

  async function fetchYtTracks(id) {
    const liked = id === 'LIKED';
    const items = [];
    let pageToken = '';
    for (let i = 0; i < 4; i++) {
      const params = liked
        ? { part: 'snippet,contentDetails', myRating: 'like', maxResults: '50' }
        : { part: 'snippet,contentDetails', playlistId: id, maxResults: '50' };
      if (pageToken) params.pageToken = pageToken;
      const d = await ytApi(liked ? 'videos' : 'playlistItems', params);
      items.push(...(d.items || []));
      pageToken = d.nextPageToken || '';
      if (!pageToken) break;
    }
    const out = [];
    for (const it of items) {
      const sn = it.snippet || {};
      const vid = liked ? it.id : ((it.contentDetails && it.contentDetails.videoId) || (sn.resourceId && sn.resourceId.videoId));
      if (!vid || !/^[A-Za-z0-9_-]{11}$/.test(vid)) continue;
      if (/^(Private|Deleted) video$/i.test(sn.title || '')) continue;
      const th = sn.thumbnails || {};
      out.push(tidyTrack({
        id: vid,
        title: sn.title || '',
        artist: sn.videoOwnerChannelTitle || sn.channelTitle || '',
        duration: liked ? parseIso(it.contentDetails && it.contentDetails.duration) : 0,
        thumbnail: (th.medium || th.default || {}).url || '',
      }));
    }
    if (!liked) {
      for (let i = 0; i < out.length; i += 50) {
        const chunk = out.slice(i, i + 50);
        try {
          const d = await ytApi('videos', { part: 'contentDetails', id: chunk.map((t) => t.id).join(','), maxResults: '50' });
          const secs = new Map((d.items || []).map((v) => [v.id, parseIso(v.contentDetails && v.contentDetails.duration)]));
          chunk.forEach((t) => { t.duration = secs.get(t.id) || 0; });
        } catch { /* durations are a bonus */ }
      }
    }
    return out;
  }

  async function openYtPlaylist(pl) {
    S.ent = { type: 'yt', id: pl.id, name: pl.title };
    renderEntity();
    showView();
    const old = ytTracks.get(pl.id);
    if (old && !old.failed) return;
    ytTracks.delete(pl.id);
    try {
      ytTracks.set(pl.id, { tracks: await fetchYtTracks(pl.id) });
    } catch (err) {
      ytTracks.set(pl.id, { tracks: [], failed: true });
      if (err.auth) toast('Please sign in with Google again.');
    }
    if (S.ent && S.ent.type === 'yt' && S.ent.id === pl.id) renderEntity();
  }

  function renderYt() {
    el.ytBox.hidden = !G.clientId;
    if (!G.clientId) return;
    const signed = ytSignedIn();
    el.ytSignIn.hidden = signed;
    el.ytSignOut.hidden = !signed;
    el.ytList.textContent = '';
    if (!signed) return;
    if (ytListsFailed) { el.ytList.appendChild(mk('li', 'notice', 'Could not load your playlists. Tap sign out and sign in again.')); return; }
    if (!ytLists.length) { el.ytList.appendChild(mk('li', 'notice', 'Loading your playlists')); return; }
    ytLists.forEach((pl) => {
      const li = mk('li');
      const r = mk('button', 'row');
      r.type = 'button';
      let art;
      if (pl.id === 'LIKED') {
        art = mk('span', 'lib-art liked');
        art.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M12 20.5s-7.5-4.6-9.3-9.2C1.5 8 3.4 4.8 6.6 4.8c1.9 0 3.5 1 4.4 2.6.9-1.6 2.5-2.6 4.4-2.6 3.2 0 5.1 3.2 3.9 6.5-1.8 4.6-7.3 9.2-7.3 9.2Z"/></svg>';
      } else {
        art = mk('span', 'lib-art');
        if (pl.thumb) { const im = document.createElement('img'); im.src = pl.thumb; im.alt = ''; im.loading = 'lazy'; art.appendChild(im); }
      }
      const tx = mk('span', 'txt');
      tx.append(mk('span', 'rt', pl.title), mk('span', 'ra', pl.id === 'LIKED' ? 'Your liked music' : 'YouTube \u00b7 ' + pl.count + (pl.count === 1 ? ' song' : ' songs')));
      r.append(art, tx);
      r.addEventListener('click', () => openYtPlaylist(pl));
      li.appendChild(r);
      el.ytList.appendChild(li);
    });
  }

  /* ================================================================== */
  /* Listen together                                                     */
  /* ================================================================== */
  /*
   * Everyone plays the song in their own YouTube player. The host sends which song, playing or
   * paused, and the position; guests follow. No audio goes through the server.
   */
  function hashName(s) {
    let h = 0;
    for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return h % 360;
  }
  function personAvatar(name) {
    const a = mk('span', 'pav', (String(name).trim().charAt(0) || '?').toUpperCase());
    a.style.setProperty('--h', hashName(name));
    a.title = name;
    return a;
  }

  function renderPeople(box) {
    box.textContent = '';
    const mine = T.cid.slice(0, 8);
    const n = T.people.length || T.members;
    const head = mk('div', 'ppl-head');
    head.append(mk('b', '', String(n)), mk('span', '', n === 1 ? 'person listening now' : 'people listening now'));
    box.appendChild(head);
    T.people.forEach((pr) => {
      const row = mk('div', 'person');
      const av = personAvatar(pr.name);
      av.classList.add('big');
      const tags = mk('div', 'ptags');
      if (pr.host) tags.appendChild(mk('span', 'ptag host', 'Host'));
      if (pr.id === mine) tags.appendChild(mk('span', 'ptag you', 'You'));
      row.append(av, mk('div', 'pname', pr.name), tags);
      box.appendChild(row);
    });
  }

  function tgPaint() {
    el.navTogether.hidden = !T.role;
    const n = T.people.length || T.members;
    el.tgCount.textContent = String(n);
    el.navTogether.setAttribute('aria-label', T.role ? 'Listening together, ' + n + ' listening' : 'Listening together');
    if (cur()) el.npFrom.textContent = T.role ? 'Listening together' : (S.source || 'Your queue');
    el.npPeople.hidden = !T.role;
    if (T.role) {
      el.npStack.textContent = '';
      T.people.slice(0, 5).forEach((pr) => el.npStack.appendChild(personAvatar(pr.name)));
      el.npPeopleText.textContent = n === 1 ? 'Just you so far' : n + ' listening';
    }
    if (T.peopleBox && T.peopleBox.isConnected) renderPeople(T.peopleBox);
  }
  el.npPeople.addEventListener('click', () => togetherSheet());

  function tgPush(force, over) {
    if (T.role !== 'host' || !T.code) return;
    const now = Date.now();
    if (!force && now - T.lastPush < 400) return;
    T.lastPush = now;
    const t = cur();
    const state = Object.assign({
      track: t ? slim(t) : null,
      playing: !audio.paused,
      position: audio.currentTime || 0,
      queue: S.queue.slice(S.qi + 1, S.qi + 16).map(slim),
    }, over || {});
    fetch('/api/together/' + T.code + '/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cid: T.cid, state }),
    }).catch(() => {});
  }

  function applyRemote(st) {
    if (!st || T.role !== 'guest') return;
    T.last = st;
    if (!st.track) { audio.pause(); return; }
    const elapsed = st.playing ? Math.max(0, (Date.now() + T.offset - st.at) / 1000) : 0;
    const est = st.position + elapsed;
    const queue = [st.track, ...(st.queue || [])];
    if (!cur() || cur().id !== st.track.id) {
      S.queue = queue;
      S.source = 'Listening together';
      loadAt(0, est);
      return;
    }
    S.queue = queue;
    S.qi = 0;
    renderQueue();
    if (st.playing) {
      if (audio.paused) audio.play();
      if (Math.abs(audio.currentTime - est) > 2.5) audio.currentTime = est;
    } else {
      if (!audio.paused) audio.pause();
      if (Math.abs(audio.currentTime - st.position) > 1) audio.currentTime = st.position;
    }
  }

  // Everyone asks the server for news (about once a second for guests). Plain requests work from any
  // network, through tunnels and hosting services.
  function tgPoll() {
    clearTimeout(T.poll);
    if (!T.role) return;
    const code = T.code;
    const t0 = Date.now();
    fetch('/api/together/' + code + '/poll?cid=' + encodeURIComponent(T.cid) + '&v=' + T.v, { cache: 'no-store' })
      .then(async (r) => {
        if (T.code !== code || !T.role) return;
        if (r.status === 404 || r.status === 403) { tgEnd('The session is no longer available.'); return; }
        if (!r.ok) throw new Error('poll');
        const d = await r.json();
        if (T.code !== code || !T.role) return;
        if (d.now) T.offset = d.now - (t0 + Date.now()) / 2; // server clock minus ours, with the trip time halved
        if (d.closed) { tgEnd(d.reason || 'The session ended.'); return; }
        if (d.count) T.members = d.count;
        if (Array.isArray(d.people)) T.people = d.people;
        if (d.v !== undefined) T.v = d.v;
        tgPaint();
        if (T.role === 'guest' && d.state) applyRemote(d.state);
      })
      .catch(() => { /* a hiccup: try again on the next round */ })
      .finally(() => {
        if (T.role && T.code === code) T.poll = setTimeout(tgPoll, T.role === 'guest' ? 1000 : 3000);
      });
  }

  function tgEnd(message) {
    if (!T.role) return;
    clearTimeout(T.poll);
    clearInterval(T.hb);
    T.role = null; T.code = ''; T.cid = ''; T.members = 1; T.people = []; T.peopleBox = null; T.last = null; T.v = 0;
    tgPaint();
    if (message) toast(message);
  }

  function leaveSession() {
    if (!T.role) return;
    const code = T.code;
    const cid = T.cid;
    fetch('/api/together/' + code + '/leave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cid }),
      keepalive: true,
    }).catch(() => {});
    tgEnd('You left the session');
  }
  window.addEventListener('pagehide', () => {
    if (!T.role || !navigator.sendBeacon) return;
    navigator.sendBeacon('/api/together/' + T.code + '/leave', new Blob([JSON.stringify({ cid: T.cid })], { type: 'application/json' }));
  });

  async function pickName(raw) {
    let name = String(raw || store.name || '').trim().slice(0, 24);
    if (!name) name = String((await askName('Your name', '')) || '').trim().slice(0, 24);
    if (!name) return '';
    store.name = name;
    saveStore();
    return name;
  }

  async function startSession(rawName) {
    if (T.role) { togetherSheet(); return; }
    const name = await pickName(rawName);
    if (!name) { toast('Add your name so friends know who you are.'); return; }
    try {
      const r = await fetch('/api/together/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) throw new Error('create');
      const d = await r.json();
      T.role = 'host'; T.code = d.code; T.cid = d.cid; T.members = 1; T.v = 0; T.people = d.people || [];
      tgPoll();
      T.hb = setInterval(() => tgPush(true), 4000);
      tgPaint();
      tgPush(true);
      togetherSheet();
    } catch {
      toast('Could not start a session. Is the server running?');
    }
  }

  async function joinSession(raw, rawName) {
    if (T.role) { toast('Leave your current session first.'); return; }
    const code = String(raw || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(code)) { toast('Enter the 5 letter code.'); return; }
    const name = await pickName(rawName);
    if (!name) { toast('Add your name so friends know who you are.'); return; }
    try {
      const r = await fetch('/api/together/' + code + '/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast(d.error || 'Could not join that session.'); return; }
      T.role = 'guest'; T.code = d.code; T.cid = d.cid; T.members = d.count || 2; T.v = d.v || 0; T.people = d.people || [];
      T.offset = d.now ? d.now - Date.now() : 0;
      tgPoll();
      tgPaint();
      toast('Joined ' + d.code);
      if (d.state) applyRemote(d.state);
    } catch {
      toast('Could not join. Is the server reachable?');
    }
  }

  function inviteLink() { return (T.publicUrl || location.origin) + '/?join=' + T.code; }

  function togetherSheet() {
    if (T.role) {
      openSheet({
        title: 'Listening together',
        sub: T.role === 'host' ? 'You are the host. Friends follow your playback.' : 'You are following the host.',
        build(body) {
          body.appendChild(mk('div', 'tg-code', T.code));
          const box = mk('div', 'people');
          T.peopleBox = box;
          renderPeople(box);
          body.appendChild(box);
          body.appendChild(mk('p', 'tg-note', 'Friends open this app, type their name and the code, or use the link.'));
          const row = mk('div', 'tg-row');
          const input = mk('input', 'tg-input');
          input.readOnly = true;
          input.value = inviteLink();
          input.setAttribute('aria-label', 'Invite link');
          input.addEventListener('focus', () => input.select());
          const copy = mk('button', 'tg-btn', 'Copy');
          copy.type = 'button';
          copy.addEventListener('click', async () => {
            try { await navigator.clipboard.writeText(inviteLink()); toast('Link copied'); }
            catch { input.focus(); input.select(); toast('Press copy on your keyboard'); }
          });
          row.append(input, copy);
          body.appendChild(row);
          if (!T.publicUrl && (location.hostname === '127.0.0.1' || location.hostname === 'localhost')) {
            body.appendChild(mk('p', 'tg-note', 'This link only works on this computer. For friends on other networks, open the app through its public link and start the session from there (see DEPLOY.md).'));
          }
        },
        items: [{ label: T.role === 'host' ? 'End session' : 'Leave session', danger: true, run: leaveSession }],
      });
      return;
    }
    let nameIn = null;
    openSheet({
      title: 'Listen together',
      sub: 'Play the same song at the same time',
      build(body) {
        const nrow = mk('div', 'tg-row');
        nameIn = mk('input', 'tg-input');
        nameIn.placeholder = 'Your name';
        nameIn.maxLength = 24;
        nameIn.autocomplete = 'nickname';
        nameIn.value = store.name;
        nameIn.setAttribute('aria-label', 'Your name');
        nrow.appendChild(nameIn);
        body.appendChild(nrow);
        const row = mk('div', 'tg-row');
        const input = mk('input', 'tg-input code');
        input.placeholder = 'CODE';
        input.maxLength = 5;
        input.autocomplete = 'off';
        input.setAttribute('aria-label', 'Session code');
        const go = mk('button', 'tg-btn', 'Join');
        go.type = 'button';
        const join = () => { const c = input.value; const n = nameIn.value; closeSheet(); joinSession(c, n); };
        go.addEventListener('click', join);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
        row.append(input, go);
        body.appendChild(row);
      },
      items: [{ label: 'Start a new session', run: () => startSession(nameIn && nameIn.value) }],
    });
  }
  el.navTogether.addEventListener('click', togetherSheet);

  (function inviteFromLink() {
    const code = (new URLSearchParams(location.search).get('join') || '').toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(code)) return;
    try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ }
    openSheet({
      title: 'Join session ' + code + '?',
      sub: 'You will hear what the host plays',
      items: [{ label: 'Join', run: () => joinSession(code) }, { label: 'Not now' }],
    });
  })();

  /* ================================================================== */
  /* Start                                                               */
  /* ================================================================== */
  window.onYouTubeIframeAPIReady = () => audio.init();
  const ytScript = document.createElement('script');
  ytScript.src = 'https://www.youtube.com/iframe_api';
  ytScript.onerror = () => toast('Could not load the YouTube player. Check your internet.');
  document.head.appendChild(ytScript);

  fetch('/api/config').then((r) => (r.ok ? r.json() : {})).then((c) => { T.publicUrl = String((c && c.publicUrl) || ''); G.clientId = String((c && c.googleClientId) || ''); renderLibrary(); }).catch(() => {});

  paintShuffle();
  paintSmart();
  renderBrowse();
  renderHome();
  renderLibrary();
  renderQueue();
  setPlayingUI(false);
  setPaint(el.seek);
  showView();
})();
