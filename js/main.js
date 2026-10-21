/* =========================================================
   VERDANT — Emeraude 300
   Scroll-scrubbed hero + site interactions
   ========================================================= */
(() => {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = window.matchMedia('(pointer: fine)').matches;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  window.scrollTo(0, 0);

  gsap.registerPlugin(ScrollTrigger);

  /* ---------- SVG tick marks (loader + scroll dial) ---------- */
  function buildTicks(group, cx, r1, r2, count, majorEvery) {
    const ns = 'http://www.w3.org/2000/svg';
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const major = i % majorEvery === 0;
      const ri = major ? r1 - 3 : r1;
      const l = document.createElementNS(ns, 'line');
      l.setAttribute('x1', cx + Math.cos(a) * ri);
      l.setAttribute('y1', cx + Math.sin(a) * ri);
      l.setAttribute('x2', cx + Math.cos(a) * r2);
      l.setAttribute('y2', cx + Math.sin(a) * r2);
      if (major) l.style.strokeWidth = 1.6;
      group.appendChild(l);
    }
  }
  buildTicks($('.loader__ticks'), 60, 44, 48, 60, 5);
  buildTicks($('.scroll-dial__ticks'), 50, 36, 40, 12, 3);

  /* ---------- Smooth scroll (Lenis) ---------- */
  let lenis = null;
  if (!reduceMotion && window.Lenis) {
    lenis = new Lenis({ duration: 1.15, easing: (t) => 1 - Math.pow(1 - t, 3), smoothWheel: true });
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add((t) => lenis.raf(t * 1000));
    gsap.ticker.lagSmoothing(0);
    lenis.stop();
  }
  const scrollToTarget = (target) => {
    if (lenis) lenis.scrollTo(target, { offset: 0, duration: 1.6 });
    else target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
  };
  $$('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href');
      const target = id === '#top' ? document.body : $(id);
      if (!target) return;
      e.preventDefault();
      closeMenu();
      scrollToTarget(id === '#top' ? 0 : target);
    });
  });

  /* =========================================================
     HERO FRAME ENGINE
     The MP4 is decoded once into a JPEG frame sequence so scroll
     scrubbing is instant in both directions (no seek latency).
     ========================================================= */
  const canvas = $('#heroCanvas');
  const ctx = canvas.getContext('2d');
  const video = $('#heroVideo');
  const FPS = 24;
  const VIDEO_URL = 'assets/hero.mp4';

  const engine = {
    mode: 'frames',      // 'frames' | 'video' (fallback)
    frames: [],
    total: 0,
    progress: 0,
    lastImg: null,
    lastKey: '',
    W: 0, H: 0, dpr: 1,
  };

  const loaderPct = $('#loaderPct');
  const loaderRing = $('#loaderRing');
  const loaderMsg = $('#loaderMsg');
  function setLoad(p, msg) {
    const v = Math.round(clamp(p, 0, 1) * 100);
    loaderPct.textContent = String(v).padStart(2, '0');
    loaderRing.style.strokeDashoffset = 100 - v;
    if (msg) loaderMsg.textContent = msg;
  }

  async function fetchVideo(onProgress) {
    const res = await fetch(VIDEO_URL);
    if (!res.ok) throw new Error('video fetch failed');
    const len = +res.headers.get('Content-Length') || 0;
    if (!res.body || !len) return res.blob();
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress(got / len);
    }
    return new Blob(chunks, { type: 'video/mp4' });
  }

  // Resolves true if the event fired, false on timeout.
  function once(el, ev, timeout = 2000) {
    return new Promise((resolve) => {
      let t;
      const done = (fired) => { clearTimeout(t); el.removeEventListener(ev, onEv); resolve(fired); };
      const onEv = () => done(true);
      el.addEventListener(ev, onEv);
      t = setTimeout(() => done(false), timeout);
    });
  }

  // iOS Safari doesn't decode frames for a video that has never played, so seeks
  // and drawImage come back blank. A muted inline play() + pause() primes the decoder.
  async function loadVideo(src) {
    video.src = src;
    const loaded = once(video, 'loadeddata', 8000);
    // Don't await play(): it can stay pending forever when the video can't load.
    const playing = video.play();
    if (playing) playing.catch(() => { /* autoplay blocked, e.g. iOS Low Power Mode */ });
    const ok = (await loaded) || video.readyState >= 2;
    video.pause();
    if (!ok) throw new Error('video did not load');
  }

  async function seek(time) {
    video.currentTime = time;
    await once(video, 'seeked');
  }

  async function extractFrames(onFirstFrame) {
    const off = document.createElement('canvas');
    off.width = video.videoWidth;
    off.height = video.videoHeight;
    const octx = off.getContext('2d');
    const dur = video.duration;
    engine.total = Math.max(2, Math.floor(dur * FPS));
    engine.frames = new Array(engine.total);

    // Coarse-to-fine order: the whole range is scrubbable after the first pass.
    const order = [];
    const seen = new Set();
    for (const stride of [12, 6, 3, 1]) {
      for (let i = 0; i < engine.total; i += stride) if (!seen.has(i)) { seen.add(i); order.push(i); }
    }
    if (!seen.has(engine.total - 1)) order.splice(1, 0, engine.total - 1);

    for (let n = 0; n < order.length; n++) {
      const i = order[n];
      await seek(Math.min((i + 0.5) / FPS, dur - 0.02));
      octx.drawImage(video, 0, 0, off.width, off.height);
      // Video frames are opaque, so a transparent pixel means the decoder gave us nothing.
      if (n === 0 && octx.getImageData(off.width >> 1, off.height >> 1, 1, 1).data[3] === 0) {
        throw new Error('video frames are blank');
      }
      // toBlob snapshots the bitmap synchronously, so the next seek can start immediately.
      off.toBlob((blob) => {
        if (!blob) return;
        const img = new Image();
        img.src = URL.createObjectURL(blob);
        img.decode().then(() => { engine.frames[i] = img; requestRender(); }).catch(() => {});
      }, 'image/jpeg', 0.88);

      if (n === 0) onFirstFrame();
    }
  }

  function nearestFrame(idx) {
    const f = engine.frames;
    if (f[idx]) return f[idx];
    for (let d = 1; d < engine.total; d++) {
      if (f[idx - d]) return f[idx - d];
      if (f[idx + d]) return f[idx + d];
    }
    return null;
  }

  function resizeCanvas() {
    engine.dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    engine.W = canvas.clientWidth;
    engine.H = canvas.clientHeight;
    canvas.width = Math.round(engine.W * engine.dpr);
    canvas.height = Math.round(engine.H * engine.dpr);
    engine.lastKey = '';
    render();
  }

  // Cover-fit with a scroll-aware focal point. On portrait screens we dolly
  // out as the watch explodes, so every component stays in frame.
  function drawSource(src, sw, sh) {
    const { W, H, dpr, progress: p } = engine;
    const portrait = H > W * 1.05;
    let scale;
    if (portrait) {
      const ease = p * p * (3 - 2 * p);
      const visibleFrac = lerp(0.42, 0.72, ease);
      scale = W / (sw * visibleFrac);
    } else {
      scale = Math.max(W / sw, H / sh);
    }
    const dw = sw * scale, dh = sh * scale;
    const fx = portrait ? lerp(0.5, 0.45, p) : 0.5;
    let dx = W / 2 - dw * fx;
    dx = clamp(dx, W - dw, 0);
    const dy = portrait ? (H - dh) * 0.26 : (H - dh) / 2;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (dh < H) {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#062213'); g.addColorStop(clamp(dy / H, 0, 1), '#062213');
      g.addColorStop(clamp((dy + dh) / H, 0, 1), '#041409'); g.addColorStop(1, '#041409');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.drawImage(src, dx, dy, dw, dh);
    if (dh < H) {
      // feather the letterbox edges into the background
      const fade = Math.min(160, dh * 0.3);
      let g = ctx.createLinearGradient(0, dy, 0, dy + fade);
      g.addColorStop(0, '#062213'); g.addColorStop(1, 'rgba(6,34,19,0)');
      ctx.fillStyle = g; ctx.fillRect(0, dy, W, fade);
      g = ctx.createLinearGradient(0, dy + dh - fade, 0, dy + dh);
      g.addColorStop(0, 'rgba(4,20,9,0)'); g.addColorStop(1, '#041409');
      ctx.fillStyle = g; ctx.fillRect(0, dy + dh - fade, W, fade);
    }
  }

  let videoSeeking = false;
  function render() {
    if (!engine.W) return;
    if (engine.mode === 'frames') {
      if (!engine.total) return;
      const idx = Math.round(engine.progress * (engine.total - 1));
      const img = nearestFrame(idx);
      if (!img) return;
      const key = img.src + engine.W + 'x' + engine.H + (engine.H > engine.W ? engine.progress.toFixed(3) : '');
      if (key === engine.lastKey) return;
      engine.lastKey = key;
      drawSource(img, img.naturalWidth, img.naturalHeight);
    } else if (engine.mode === 'poster') {
      // Last resort when the video can't play at all: cross-fade the assembled
      // watch into the exploded view as the user scrolls.
      const [a, b] = engine.posters;
      const p = engine.progress;
      const mix = clamp((p - 0.15) / 0.5, 0, 1);
      const key = 'poster' + engine.W + 'x' + engine.H + p.toFixed(3);
      if (!a.naturalWidth || key === engine.lastKey) return;
      engine.lastKey = key;
      drawSource(a, a.naturalWidth, a.naturalHeight);
      if (b.naturalWidth && mix > 0) {
        ctx.globalAlpha = mix * mix * (3 - 2 * mix);
        drawSource(b, b.naturalWidth, b.naturalHeight);
        ctx.globalAlpha = 1;
      }
    } else if (video.readyState >= 2) {
      // Fallback: seek the <video> directly (used when frames can't be extracted, e.g. file://).
      const t = engine.progress * (video.duration - 0.05);
      if (!videoSeeking && Math.abs(video.currentTime - t) > 0.02) {
        videoSeeking = true;
        video.currentTime = t;
        once(video, 'seeked', 500).then(() => { videoSeeking = false; drawSource(video, video.videoWidth, video.videoHeight); render(); });
      } else if (!videoSeeking) {
        drawSource(video, video.videoWidth, video.videoHeight);
      }
    }
  }

  let renderQueued = false;
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  async function initHero() {
    resizeCanvas();
    try {
      const blob = await fetchVideo((p) => setLoad(p * 0.9, 'Winding the movement…'));
      await loadVideo(URL.createObjectURL(blob));
      setLoad(0.9, 'Setting the hands…');
      // Probe: make sure the canvas isn't tainted before committing to frame mode.
      const probe = document.createElement('canvas');
      probe.getContext('2d').drawImage(video, 0, 0, 1, 1);
      probe.toDataURL();
      // Resolve once the first frame is in: the visitor starts at the top of the hero,
      // and the rest of the timeline fills in (coarse to fine) while they read.
      await new Promise((resolve, reject) => {
        extractFrames(() => { setLoad(1); resolve(); }).then(resolve, reject);
      });
    } catch (err) {
      try {
        engine.mode = 'video';
        await loadVideo(VIDEO_URL);
      } catch (e) {
        await loadPosters();
      }
      setLoad(1);
      requestRender();
    }
  }

  async function loadPosters() {
    engine.mode = 'poster';
    const wide = window.innerWidth > 900;
    engine.posters = ['watch-studio', 'watch-exploded'].map((name) => {
      const img = new Image();
      img.src = `assets/${name}-${wide ? 1672 : 900}.jpg`;
      return img;
    });
    await Promise.all(engine.posters.map((img) => img.complete || once(img, 'load', 8000)));
  }

  /* ---------- Dust particles (glints that drift off as the watch comes apart) ---------- */
  const dust = $('#dustCanvas');
  const dctx = dust.getContext('2d');
  const particles = [];
  let dustRunning = false;
  function seedDust() {
    dust.width = dust.clientWidth;
    dust.height = dust.clientHeight;
    particles.length = 0;
    const n = window.innerWidth < 768 ? 36 : 70;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      particles.push({
        a,
        r0: 40 + Math.random() * 120,           // start radius around the watch
        spread: 200 + Math.random() * 600,      // how far it flies at full progress
        depth: 0.3 + Math.random() * 1.2,       // parallax depth
        size: 0.6 + Math.random() * 1.8,
        phase: Math.random() * Math.PI * 2,
        speed: 0.4 + Math.random() * 0.8,
        gold: Math.random() < 0.25,
      });
    }
  }
  function drawDust(time) {
    const w = dust.width, h = dust.height;
    dctx.clearRect(0, 0, w, h);
    const p = engine.progress;
    const intensity = clamp(p * 2.2, 0, 1) * (1 - clamp((p - 0.9) * 8, 0, 1));
    if (intensity <= 0.01) return;
    const cx = w * (h > w ? 0.5 : 0.48), cy = h * 0.48;
    const t = time * 0.001;
    for (const q of particles) {
      const r = q.r0 + q.spread * p * q.depth;
      const x = cx + Math.cos(q.a + t * 0.05 * q.speed) * r;
      const y = cy + Math.sin(q.a + t * 0.05 * q.speed) * r * 0.6 - p * 120 * q.depth;
      const tw = 0.5 + 0.5 * Math.sin(t * 2 * q.speed + q.phase);
      dctx.globalAlpha = intensity * tw * 0.9;
      dctx.fillStyle = q.gold ? '#e8d39a' : '#7dffb5';
      dctx.beginPath();
      dctx.arc(x, y, q.size * (0.6 + q.depth * 0.6), 0, Math.PI * 2);
      dctx.fill();
    }
    dctx.globalAlpha = 1;
  }
  function dustLoop(time) {
    if (!dustRunning) return;
    drawDust(time);
    requestAnimationFrame(dustLoop);
  }

  /* ---------- Hero scroll choreography ---------- */
  const partCount = $('#partCount');
  const dialHand = $('#dialHand');
  const dialArc = $('#dialArc');
  const FRAMES_END = 0.86;   // portion of the hero scroll that drives the video

  function onFrameProgress() {
    const p = engine.progress;
    partCount.textContent = String(Math.round(p * 312)).padStart(3, '0');
    dialHand.style.transform = `rotate(${p * 360}deg)`;
    dialArc.style.strokeDashoffset = 100 - p * 100;
    requestRender();
    if (reduceMotion) drawDust(performance.now());
  }

  function buildHeroTimeline() {
    const state = { p: 0 };
    const tl = gsap.timeline({
      defaults: { ease: 'none' },
      scrollTrigger: {
        trigger: '.hero',
        start: 'top top',
        end: 'bottom bottom',
        scrub: reduceMotion ? true : 0.6,
        onToggle: (self) => {
          dustRunning = self.isActive && !reduceMotion;
          if (dustRunning) requestAnimationFrame(dustLoop);
        },
      },
    });

    tl.to(state, {
      p: 1, duration: FRAMES_END,
      onUpdate: () => { engine.progress = state.p; onFrameProgress(); },
    }, 0);

    // 3D dolly: the camera pulls back and levels out as the watch comes apart
    if (!reduceMotion) {
      tl.fromTo('#heroCanvas', { scale: 1.14, rotationX: 7, yPercent: 3 }, { scale: 1, rotationX: 0, yPercent: 0, duration: FRAMES_END }, 0);
      tl.fromTo('#dustCanvas', { scale: 1.3 }, { scale: 1, duration: FRAMES_END }, 0);
    }

    // Phase A out
    tl.to('#hint', { autoAlpha: 0, duration: 0.04 }, 0.02);
    tl.to('.js-phase-a', { autoAlpha: 0, y: -60, z: 120, filter: 'blur(6px)', duration: 0.1, stagger: 0 }, 0.08);

    // Phase B in, callouts staggered, out
    tl.fromTo('.hero__phase--b', { autoAlpha: 0, y: 40 }, { autoAlpha: 1, y: 0, duration: 0.06 }, 0.24);
    tl.fromTo('.callouts li', { autoAlpha: 0, x: 40 }, { autoAlpha: 1, x: 0, duration: 0.05, stagger: 0.05 }, 0.28);
    tl.to('.hero__phase--b', { autoAlpha: 0, y: -40, filter: 'blur(6px)', duration: 0.06 }, 0.58);

    // Phase C in
    tl.fromTo('.hero__phase--c', { autoAlpha: 0, y: 40 }, { autoAlpha: 1, y: 0, filter: 'blur(0px)', duration: 0.07 }, 0.66);

    // Exit: the stage folds into a floating card
    tl.to('#stage', { clipPath: 'inset(7% 4% 7% 4% round 28px)', scale: 0.94, duration: 0.12, ease: 'power1.in' }, 0.88);
    tl.to(['.hero__phase--c', '.scroll-dial'], { autoAlpha: 0, y: -30, duration: 0.08 }, 0.9);
    gsap.set('#stage', { clipPath: 'inset(0% 0% 0% 0% round 0px)' });
  }

  // Pointer parallax on the hero stage (layered depth)
  function initHeroTilt() {
    if (reduceMotion || !finePointer) return;
    const rx = gsap.quickTo('#stage', 'rotationX', { duration: 1, ease: 'power3.out' });
    const ry = gsap.quickTo('#stage', 'rotationY', { duration: 1, ease: 'power3.out' });
    const tx = gsap.quickTo('.hero__phase', 'x', { duration: 1.2, ease: 'power3.out' });
    const dx = gsap.quickTo('#dustCanvas', 'x', { duration: 1.4, ease: 'power3.out' });
    $('.hero').addEventListener('pointermove', (e) => {
      const nx = e.clientX / window.innerWidth - 0.5;
      const ny = e.clientY / window.innerHeight - 0.5;
      rx(-ny * 3); ry(nx * 4); tx(nx * -14); dx(nx * 40);
    });
  }

  function introAnimation() {
    if (reduceMotion) return;
    gsap.from('.hero__title .line > *', { yPercent: 110, duration: 1.3, ease: 'expo.out', stagger: 0.1, delay: 0.15 });
    gsap.from(['.hero__phase--a .eyebrow', '.hero__lede', '.hero__side span', '.scroll-dial', '.hero__hint', '.nav'], {
      autoAlpha: 0, y: 20, duration: 1, ease: 'power3.out', stagger: 0.06, delay: 0.5,
    });
    gsap.from('#stage', { scale: 1.08, duration: 2, ease: 'expo.out' });
  }

  /* =========================================================
     NAV + MOBILE MENU
     ========================================================= */
  const nav = $('#nav');
  const burger = $('#burger');
  const menu = $('#mobileMenu');
  let lastY = 0;
  function onScrollNav(y) {
    nav.classList.toggle('is-scrolled', y > 40);
    const goingDown = y > lastY && y > 400;
    if (!menu.classList.contains('is-open')) nav.classList.toggle('is-hidden', goingDown && y - lastY > 2);
    lastY = y;
  }
  if (lenis) lenis.on('scroll', ({ scroll }) => onScrollNav(scroll));
  else window.addEventListener('scroll', () => onScrollNav(window.scrollY), { passive: true });

  function openMenu() {
    menu.hidden = false;
    requestAnimationFrame(() => menu.classList.add('is-open'));
    burger.setAttribute('aria-expanded', 'true');
    burger.setAttribute('aria-label', 'Close menu');
    nav.classList.remove('is-hidden');
    if (lenis) lenis.stop(); else document.body.style.overflow = 'hidden';
    $('a', menu).focus();
  }
  function closeMenu() {
    if (menu.hidden) return;
    menu.classList.remove('is-open');
    burger.setAttribute('aria-expanded', 'false');
    burger.setAttribute('aria-label', 'Open menu');
    if (lenis) lenis.start(); else document.body.style.overflow = '';
    setTimeout(() => { menu.hidden = true; }, 300);
  }
  burger.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) { closeMenu(); burger.focus(); }
  });

  // Active section highlighting
  $$('.nav__links a').forEach((link) => {
    const sec = $(link.getAttribute('href'));
    if (!sec) return;
    ScrollTrigger.create({
      trigger: sec, start: 'top 50%', end: 'bottom 50%',
      onToggle: (self) => link.classList.toggle('is-active', self.isActive),
    });
  });

  /* =========================================================
     MANIFESTO — word-by-word reveal
     ========================================================= */
  function initManifesto() {
    const el = $('#manifesto');
    const walk = (node) => {
      Array.from(node.childNodes).forEach((child) => {
        if (child.nodeType === 3) {
          const frag = document.createDocumentFragment();
          child.textContent.split(/(\s+)/).forEach((part) => {
            if (!part) return;
            if (/^\s+$/.test(part)) frag.appendChild(document.createTextNode(part));
            else { const s = document.createElement('span'); s.className = 'w'; s.textContent = part; frag.appendChild(s); }
          });
          child.replaceWith(frag);
        } else if (child.nodeType === 1) walk(child);
      });
    };
    walk(el);
    if (reduceMotion) return;
    const words = $$('.w', el);
    ScrollTrigger.create({
      trigger: el, start: 'top 80%', end: 'bottom 45%', scrub: true,
      onUpdate: (self) => {
        const n = self.progress * words.length;
        words.forEach((w, i) => { w.style.opacity = clamp(n - i, 0.16, 1); });
      },
    });
  }

  /* =========================================================
     CONFIGURATOR
     ========================================================= */
  const editions = {
    emeraude: { kicker: 'Edition 01', name: 'Emeraude', ref: 'VR-300 · EMR', price: 'CHF 11,900', accent: '#1fa35a', filter: 'none',
      desc: 'Our signature. A sunburst emerald dial that shifts from forest to jade as the light moves across it.' },
    abysse: { kicker: 'Edition 02', name: 'Abysse', ref: 'VR-300 · ABY', price: 'CHF 11,900', accent: '#1f6fb8', filter: 'hue-rotate(68deg) saturate(1.05)',
      desc: 'The colour of water at two hundred metres. A deep cobalt lacquer with a matching ceramic insert.' },
    onyx: { kicker: 'Edition 03', name: 'Onyx', ref: 'VR-300 · ONX', price: 'CHF 11,400', accent: '#55605a', filter: 'saturate(0.05) brightness(0.88) contrast(1.12)',
      desc: 'Pure tool watch. Matte black ceramic and grained black dial, nothing to distract from the time.' },
    soleil: { kicker: 'Edition 04', name: 'Soleil', ref: 'VR-300 · SOL', price: 'CHF 14,200', accent: '#b88a3e', filter: 'hue-rotate(-95deg) saturate(0.75) sepia(0.25)',
      desc: 'A champagne sunburst dial warmed by a bronze-tone bezel. Limited to 300 pieces each year.' },
  };
  function initConfigurator() {
    const img = $('#configImg');
    const section = $('#collection');
    const fields = {
      kicker: $('#configKicker'), name: $('#configName'), desc: $('#configDesc'), ref: $('#configRef'), price: $('#configPrice'),
    };
    $$('input[name="dial"]').forEach((input) => {
      input.addEventListener('change', () => {
        const e = editions[input.value];
        img.style.filter = e.filter;
        section.style.setProperty('--accent', e.accent);
        img.alt = `Emeraude 300 diver watch in the ${e.name} edition`;
        const swap = () => {
          fields.kicker.textContent = e.kicker; fields.name.textContent = e.name; fields.desc.textContent = e.desc;
          fields.ref.textContent = e.ref; fields.price.textContent = e.price;
        };
        if (reduceMotion) return swap();
        gsap.timeline()
          .to([fields.name, fields.desc, fields.kicker, fields.price], { autoAlpha: 0, y: -10, duration: 0.2, ease: 'power2.in', stagger: 0.02 })
          .add(swap)
          .to([fields.name, fields.desc, fields.kicker, fields.price], { autoAlpha: 1, y: 0, duration: 0.45, ease: 'power3.out', stagger: 0.04 });
      });
    });

    // 3D tilt on the product card
    if (reduceMotion || !finePointer) return;
    const card = $('#tiltCard');
    gsap.set(card, { transformPerspective: 1000 });
    const rx = gsap.quickTo(card, 'rotationX', { duration: 0.8, ease: 'power3.out' });
    const ry = gsap.quickTo(card, 'rotationY', { duration: 0.8, ease: 'power3.out' });
    const ix = gsap.quickTo(img, 'x', { duration: 0.8, ease: 'power3.out' });
    const iy = gsap.quickTo(img, 'y', { duration: 0.8, ease: 'power3.out' });
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width - 0.5;
      const ny = (e.clientY - r.top) / r.height - 0.5;
      rx(-ny * 8); ry(nx * 10); ix(nx * -16); iy(ny * -10);
    });
    card.addEventListener('pointerleave', () => { rx(0); ry(0); ix(0); iy(0); });
  }

  /* =========================================================
     ANATOMY HOTSPOTS
     ========================================================= */
  const parts = [
    ['Sapphire crystal', 'Synthetic sapphire, second only to diamond in hardness, domed by 0.4 mm and coated on both sides so the dial reads cleanly at any angle.'],
    ['Ceramic bezel', 'Fired at 1,500 °C and polished with diamond paste. Its emerald colour will not fade — not in sunlight, not in salt water, not in fifty years.'],
    ['Sunburst dial', 'Twelve coats of hand-sprayed lacquer over a brushed brass base. The sunburst catches light in a slow sweep as your wrist turns.'],
    ['Calibre V-70', 'Our in-house automatic: 31 jewels, 4 Hz, a silicon hairspring immune to magnetism and a 70-hour power reserve across twin barrels.'],
    ['Screw-down crown', 'A triple-seal crown with a protected tube. Screw it down and the case is sealed to 300 metres.'],
    ['Oyster bracelet', 'Solid three-piece links in 904L steel with a tool-free 5 mm extension clasp — for a wetsuit, or a warm afternoon.'],
  ];
  function initAnatomy() {
    const card = $('#anatomyCard');
    const idx = $('#anatomyIdx'), title = $('#anatomyTitle'), text = $('#anatomyText');
    const spots = $$('.hotspot');
    const select = (i) => {
      spots.forEach((s, j) => s.setAttribute('aria-pressed', String(i === j)));
      card.classList.add('is-swapping');
      setTimeout(() => {
        idx.textContent = `${String(i + 1).padStart(2, '0')} / ${String(parts.length).padStart(2, '0')}`;
        title.textContent = parts[i][0];
        text.textContent = parts[i][1];
        card.classList.remove('is-swapping');
      }, reduceMotion ? 0 : 220);
    };
    spots.forEach((s, i) => {
      s.addEventListener('click', () => select(i));
      if (finePointer) s.addEventListener('mouseenter', () => select(i));
    });
    spots[0].setAttribute('aria-pressed', 'true');
    spots.slice(1).forEach((s) => s.setAttribute('aria-pressed', 'false'));
  }

  /* =========================================================
     COUNTERS
     ========================================================= */
  function initCounters() {
    $$('.count').forEach((el) => {
      const to = +el.dataset.to;
      ScrollTrigger.create({
        trigger: el, start: 'top 88%', once: true,
        onEnter: () => {
          if (reduceMotion) { el.textContent = to.toLocaleString('en-US'); return; }
          const o = { v: 0 };
          gsap.to(o, { v: to, duration: 1.8, ease: 'power3.out', onUpdate: () => { el.textContent = Math.round(o.v).toLocaleString('en-US'); } });
        },
      });
    });
    gsap.to('.reserve i', {
      scaleX: 1, duration: reduceMotion ? 0 : 2.2, ease: 'power2.out',
      scrollTrigger: { trigger: '.reserve', start: 'top 90%', once: true },
    });
  }

  /* =========================================================
     CRAFT — horizontal pinned scroll
     ========================================================= */
  function initCraft() {
    const track = $('#craftTrack');
    const bar = $('#craftBar');
    if (reduceMotion) {
      track.parentElement.style.overflowX = 'auto';
      return;
    }
    const dist = () => Math.max(0, track.scrollWidth - window.innerWidth);
    gsap.to(track, {
      x: () => -dist(),
      ease: 'none',
      scrollTrigger: {
        trigger: '.craft',
        start: 'top top',
        end: () => '+=' + dist(),
        pin: true,
        scrub: 0.6,
        invalidateOnRefresh: true,
        onUpdate: (self) => { bar.style.transform = `scaleX(${self.progress})`; },
      },
    });
  }

  /* =========================================================
     SCROLL REVEALS
     ========================================================= */
  function initReveals() {
    if (reduceMotion) return;
    const groups = [
      '.section-head', '.config__visual', '.config__panel', '.anatomy__frame', '.bento__cell',
      '.press__quote', '.press__logos li', '.boutique__intro', '.form', '.manifesto__sig', '.footer__grid > *',
    ];
    groups.forEach((sel) => {
      ScrollTrigger.batch(sel, {
        start: 'top 88%',
        once: true,
        onEnter: (els) => gsap.fromTo(els, { autoAlpha: 0, y: 48 }, { autoAlpha: 1, y: 0, duration: 1.1, ease: 'expo.out', stagger: 0.08, overwrite: true }),
      });
      gsap.set(sel, { autoAlpha: 0 });
    });
    gsap.fromTo('.footer__word', { yPercent: 60 }, {
      yPercent: 12, ease: 'none',
      scrollTrigger: { trigger: '.footer', start: 'top bottom', end: 'bottom bottom', scrub: true },
    });
  }

  /* =========================================================
     BOOKING FORM
     ========================================================= */
  function initForm() {
    const form = $('#bookForm');
    const btn = $('#bookBtn');
    const ok = $('#formOk');
    const rules = {
      name: (v) => (v.trim().length < 2 ? 'Please enter your full name.' : ''),
      email: (v) => (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) ? 'Please enter a valid email, e.g. name@example.com.' : ''),
    };
    const check = (input) => {
      const msg = rules[input.name] ? rules[input.name](input.value) : '';
      input.setAttribute('aria-invalid', msg ? 'true' : 'false');
      $('#e-' + input.name).textContent = msg;
      return !msg;
    };
    $$('input', form).forEach((input) => {
      input.addEventListener('blur', () => { if (input.value) check(input); });
      input.addEventListener('input', () => { if (input.getAttribute('aria-invalid') === 'true') check(input); });
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const inputs = $$('input', form);
      const firstBad = inputs.find((i) => !check(i));
      if (firstBad) { firstBad.focus(); return; }
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner" aria-hidden="true"></span><span>Sending…</span>';
      // No backend yet — simulate the request.
      setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = '<span>Request appointment</span>';
        form.reset();
        ok.hidden = false;
        if (!reduceMotion) gsap.from(ok, { autoAlpha: 0, y: 10, duration: 0.5, ease: 'power3.out' });
      }, 1200);
    });
  }

  /* =========================================================
     BOOT
     ========================================================= */
  seedDust();
  buildHeroTimeline();
  initHeroTilt();
  initManifesto();
  initConfigurator();
  initAnatomy();
  initCounters();
  initCraft();
  initReveals();
  initForm();

  let resizeT;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { resizeCanvas(); seedDust(); ScrollTrigger.refresh(); }, 150);
  });

  initHero().then(() => {
    resizeCanvas();
    onFrameProgress();
    setTimeout(() => {
      if (!location.hash) {
        window.scrollTo(0, 0);
        if (lenis) lenis.scrollTo(0, { immediate: true, force: true });
      }
      $('#loader').classList.add('is-done');
      document.body.classList.remove('is-loading');
      if (lenis) lenis.start();
      ScrollTrigger.refresh();
      introAnimation();
    }, 250);
  });
})();
