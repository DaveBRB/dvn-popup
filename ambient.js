// Park ambience with the Web Audio API: recorded birdsong from the trees (see setBirds) and the hum of Paris
// traffic beyond the park, synthesised. Every source sits somewhere in the scene, so it moves as you turn.
// scheduleUntil(t) plans sounds up to time t, so the same code plays live or renders offline for testing.

export function createAmbience(ctx, { birdSpots, roads, birdLevel = 1.6, trafficLevel = 0.18 }) {
  const rand = Math.random, pick = (a) => a[Math.floor(rand() * a.length)];
  const gain = (v, to) => { const g = ctx.createGain(); g.gain.value = v; if (to) g.connect(to); return g; };

  const out = gain(1.4);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16; comp.ratio.value = 3;
  out.connect(comp).connect(ctx.destination);
  const birdsBus = gain(birdLevel, out), trafficBus = gain(trafficLevel, out);

  // noise buffers: white for hiss and tyres, brown (integrated white) for the low city rumble
  const sr = ctx.sampleRate;
  const noise = (seconds, brown) => {
    const b = ctx.createBuffer(1, sr * seconds, sr), d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const w = rand() * 2 - 1;
      d[i] = brown ? (last = (last + 0.02 * w) / 1.02) * 3.5 : w;
    }
    return b;
  };
  const white = noise(3, false), brownNoise = noise(6, true);

  const place = (node, x, y, z) => {
    if (node.positionX) { node.positionX.value = x; node.positionY.value = y; node.positionZ.value = z; }
    else node.setPosition(x, y, z);
  };
  const panner = (x, y, z, model, ref, rolloff, to) => {
    const p = ctx.createPanner();
    Object.assign(p, { panningModel: model, distanceModel: "inverse", refDistance: ref, rolloffFactor: rolloff, maxDistance: 400 });
    place(p, x, y, z);
    p.connect(to);
    return p;
  };
  const env = (g, t, attack, hold, release, peak) => {
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setValueAtTime(peak, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
  };

  // ---------------------------------------------------------------- traffic
  for (const road of roads) {
    for (const x of road.xs) {   // steady rumble and tyre hiss, slowly swelling with the traffic
      const p = panner(x, 1, road.z, "equalpower", 25, 1, trafficBus);
      const rumble = ctx.createBufferSource();
      rumble.buffer = brownNoise; rumble.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass"; lp.frequency.value = 360;
      const g = gain(0.6 * road.level);
      rumble.connect(lp).connect(g).connect(p);
      const lfo = ctx.createOscillator(), depth = gain(0.25 * road.level);
      lfo.frequency.value = 0.03 + rand() * 0.05;
      lfo.connect(depth).connect(g.gain);
      const hiss = ctx.createBufferSource();
      hiss.buffer = white; hiss.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass"; bp.frequency.value = 900; bp.Q.value = 0.6;
      hiss.connect(bp).connect(gain(0.05 * road.level, p));
      rumble.start(0, rand() * 5); hiss.start(0, rand() * 2); lfo.start(0);
    }
    road.next = rand() * 3;
    road.nextHorn = 30 + rand() * 60;
  }

  function car(t, road) {   // a vehicle passing along the road, its pitch dropping as it goes by
    const dur = 4.5 + rand() * 3, dir = rand() < 0.5 ? 1 : -1, peak = 0.35 * road.level * (0.5 + rand() * 0.7);
    const p = panner(-60 * dir, 0.8, road.z + (rand() - 0.5) * 8, "equalpower", 20, 1, trafficBus);
    if (p.positionX) { p.positionX.setValueAtTime(-60 * dir, t); p.positionX.linearRampToValueAtTime(60 * dir, t + dur); }
    const src = ctx.createBufferSource();
    src.buffer = white; src.loop = true;
    const bp = ctx.createBiquadFilter(), f = 380 + rand() * 300;
    bp.type = "bandpass"; bp.Q.value = 1.1;
    bp.frequency.setValueAtTime(f * 1.15, t);
    bp.frequency.linearRampToValueAtTime(f * 0.85, t + dur);
    const g = gain(0);
    env(g, t, dur * 0.5, 0, dur * 0.5, peak);
    src.connect(bp).connect(g).connect(p);
    src.start(t, rand() * 2); src.stop(t + dur + 0.1);
    if (rand() < 0.3) {   // now and then a scooter's engine
      const o = ctx.createOscillator(), lp = ctx.createBiquadFilter(), ge = gain(0);
      o.type = "sawtooth";
      const fe = 70 + rand() * 50;
      o.frequency.setValueAtTime(fe * 1.06, t);
      o.frequency.linearRampToValueAtTime(fe * 0.94, t + dur);
      lp.type = "lowpass"; lp.frequency.value = 500;
      env(ge, t, dur * 0.5, 0, dur * 0.5, peak * 0.35);
      o.connect(lp).connect(ge).connect(p);
      o.start(t); o.stop(t + dur + 0.1);
    }
  }

  function horn(t, road) {   // a far-off two-tone horn, very quiet
    const p = panner((rand() - 0.5) * 120, 1, road.z, "equalpower", 20, 1, trafficBus);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 1100;
    lp.connect(p);
    for (const [f, dt] of [[392, 0], [494, 0]]) {
      const o = ctx.createOscillator(), g = gain(0);
      o.type = "square"; o.frequency.value = f;
      env(g, t + dt, 0.02, 0.18 + rand() * 0.25, 0.08, 0.05 * road.level);
      o.connect(g).connect(lp);
      o.start(t); o.stop(t + 0.6);
    }
  }

  // ---------------------------------------------------------------- birds
  // Recorded calls: CC0 field recordings from Freesound (listed in CREDITS.md), cleaned up and packed back to back
  // into one sound file. setBirds() hands over the decoded file and where each clip sits in it. Every bird in the
  // trees keeps to one species and its own voice (a slightly higher or lower pitch) and sings one of its clips now and then.
  const species = {   // how many of each turn up, how loud they are, and the pause between songs (s)
    sparrow:   { weight: 4, level: 0.55, rest: [1.5, 6], low: true },   // chatter from the bushes and lower branches
    blackbird: { weight: 3, level: 0.6, rest: [3, 9] },
    robin:     { weight: 3, level: 0.55, rest: [3, 10] },
    greattit:  { weight: 2, level: 0.5, rest: [4, 12] },
    chaffinch: { weight: 2, level: 0.5, rest: [5, 14] },
    bluetit:   { weight: 1, level: 0.45, rest: [5, 15] },
    wren:      { weight: 1, level: 0.5, rest: [10, 25] },
    magpie:    { weight: 1, level: 0.45, rest: [20, 50] },
    pigeon:    { weight: 1, level: 0.6, rest: [20, 45] },
    crow:      { weight: 1, level: 0.4, rest: [30, 70] },
  };
  let birds = [], sheet = null;
  function setBirds(buffer, clips) {
    sheet = { buffer, clips: {} };
    for (const c of clips) (sheet.clips[c.kind] ||= []).push(c);
    // one of every species first, then the common ones again by weight
    const kinds = Object.keys(species).filter((k) => sheet.clips[k]);
    const extra = kinds.flatMap((k) => Array(species[k].weight - 1).fill(k));
    birds = birdSpots.map((b, i) => {
      const kind = i < kinds.length ? kinds[i] : pick(extra);
      const y = species[kind].low ? 1 + rand() * 2.5 : b.y;
      return { kind, to: panner(b.x, y, b.z, "HRTF", 8, 1, birdsBus), voice: 0.94 + rand() * 0.12, next: ctx.currentTime + rand() * 8 };
    });
  }
  function sing(b, t) {
    const list = sheet.clips[b.kind], c = list[Math.floor(rand() * list.length)];
    const rate = b.voice * (0.98 + rand() * 0.04);
    const src = ctx.createBufferSource(), g = gain(species[b.kind].level * (0.6 + rand() * 0.4), b.to);
    src.buffer = sheet.buffer;
    src.playbackRate.value = rate;
    src.connect(g);
    src.onended = () => g.disconnect();
    src.start(t, c.start, c.dur);
    return c.dur / rate;
  }

  // ---------------------------------------------------------------- scheduling
  function scheduleUntil(until) {
    for (const b of birds) {
      while (b.next < until) {
        const [lo, hi] = species[b.kind].rest;
        b.next += sing(b, Math.max(b.next, ctx.currentTime)) + lo + rand() * (hi - lo);
      }
    }
    for (const road of roads) {
      while (road.next < until) { car(Math.max(road.next, ctx.currentTime), road); road.next += (1.5 + rand() * 5) / road.level; }
      while (road.nextHorn < until) { if (rand() < 0.4) horn(Math.max(road.nextHorn, ctx.currentTime), road); road.nextHorn += 40 + rand() * 60; }
    }
  }

  // the listener follows the camera
  const fwd = { x: 0, y: 0, z: -1 }, up = { x: 0, y: 1, z: 0 };
  function setListener(camera) {
    const L = ctx.listener, e = camera.matrixWorld.elements;
    fwd.x = -e[8]; fwd.y = -e[9]; fwd.z = -e[10];
    up.x = e[4]; up.y = e[5]; up.z = e[6];
    const p = camera.position;
    if (L.positionX) {
      L.positionX.value = p.x; L.positionY.value = p.y; L.positionZ.value = p.z;
      L.forwardX.value = fwd.x; L.forwardY.value = fwd.y; L.forwardZ.value = fwd.z;
      L.upX.value = up.x; L.upY.value = up.y; L.upZ.value = up.z;
    } else {
      L.setPosition(p.x, p.y, p.z);
      L.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }

  return { scheduleUntil, setListener, setBirds, out, buses: { birds: birdsBus, traffic: trafficBus } };
}
