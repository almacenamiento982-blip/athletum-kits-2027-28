(() => {
  const KITS = {
    j3: { n: '01', name: 'Yellow kit', flat: 'assets/j3_amarilla_front.webp', flatBack: 'assets/j3_amarilla_back.webp' },
    j4: { n: '02', name: 'Gray training kit', tone: 0.8, flat: 'assets/j4_gris_front.webp', flatBack: 'assets/j4_gris_back.webp' },
    j1: { n: '03', opt: 'Option 1', name: 'Black kit, option 1', flat: 'assets/j1_celeste_front.webp', flatBack: 'assets/j1_celeste_back.webp' },
    j2: { n: '03', opt: 'Option 2', name: 'Black kit, option 2', flat: 'assets/j2_negra_front.webp', flatBack: 'assets/j2_negra_back.webp' }
  };
  // Grosores, relativos al semiancho del cuerpo y al semialto de la manga.
  const BODY_DEPTH = 0.42;
  const SLEEVE_DEPTH = 1.0;
  const SEG = 72;                 // segmentos por anillo
  const CAM_DIST = 6.2;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const stage = document.getElementById('stage');
  const canvas = document.getElementById('gl');
  const nowEl = document.getElementById('now');
  const degEl = document.getElementById('deg');
  const loading = document.getElementById('loading');
  const fallback = document.getElementById('fallback');
  const legend = [...document.querySelectorAll('#legend li')];
  const sideBtns = [...document.querySelectorAll('.side')];
  const kitBtns = [...document.querySelectorAll('.kit')];
  const zoomIn = document.getElementById('zoom-in');
  const zoomOut = document.getElementById('zoom-out');
  const zoomReset = document.getElementById('zoom-reset');

  let kit = 'j3', rot = 0, vel = 0, target = null, dragging = false;
  let zoom = 1, zoomTarget = 1;
  let lastX = 0, lastT = 0, idleAt = performance.now(), lastSide = null, drawnKey = null;
  const pointers = new Map();
  let pinchDist = 0;

  // ---------- WebGL ----------
  let renderer = null;
  try {
    if (!window.THREE) throw new Error('no three');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch (e) { renderer = null; }

  const scene = renderer ? new THREE.Scene() : null;
  const camera = renderer ? new THREE.PerspectiveCamera(26, 1, 0.1, 50) : null;
  const pivot = renderer ? new THREE.Group() : null;
  const meshes = {};
  const loader = renderer ? new THREE.TextureLoader() : null;

  if (renderer) {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputEncoding = THREE.sRGBEncoding;
    camera.position.set(0, 0.1, CAM_DIST);
    camera.lookAt(0, 0, 0);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 0.7); key.position.set(2.5, 3, 4); scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.35); fill.position.set(-3, 1, 2.5); scene.add(fill);
    const back = new THREE.DirectionalLight(0xffffff, 0.5); back.position.set(0, 2, -5); scene.add(back);
    pivot.rotation.x = 0.04;
    scene.add(pivot);
  } else {
    canvas.hidden = true;
    fallback.hidden = false;
  }

  function loadImage(src) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  }
  function loadJson(src) { return fetch(src).then(r => r.json()); }
  function loadTex(src) {
    return new Promise((res, rej) => loader.load(src, t => {
      t.encoding = THREE.sRGBEncoding;
      t.anisotropy = renderer.capabilities.getMaxAnisotropy();
      res(t);
    }, undefined, rej));
  }

  // Tubo cerrado: una lista de anillos (centro, semiejes) a lo largo de un eje. Cada anillo
  // es una elipse en el plano perpendicular. La textura se proyecta en plano desde el frente
  // (u = x, v = y): los triangulos con z > 0 usan la foto del frente y los de z < 0 la de la
  // espalda (que viene espejada), asi la union de ambas cae exactamente en el costado.
  // Peso frente/espalda por vertice: 1 en el frente, 0 en la espalda y una transicion suave
  // de +-BLEND grados alrededor del costado, donde el material mezcla las dos fotos.
  const BLEND = Math.sin(22 * Math.PI / 180);
  const sideWeight = th => { const t = Math.min(1, Math.max(0, (Math.sin(th) + BLEND) / (2 * BLEND))); return t * t * (3 - 2 * t); };
  // Peso "costado": 1 justo en el costado (donde la foto llega estirada), 0 a mas de SIDE grados.
  const SIDE = Math.sin(40 * Math.PI / 180);
  const edgeWeight = th => { const t = Math.min(1, Math.max(0, 1 - Math.abs(Math.sin(th)) / SIDE)); return t * t * (3 - 2 * t); };

  // rings: anillos {cx, cy, a, b} a lo largo del eje d (unitario, en el plano xy); cada anillo
  // es una elipse en el plano perpendicular: semieje a sobre u (perpendicular a d) y b en z.
  // normalAt(x, y) -> [nx, ny, nz] del campo de volumen (frente). Para cada vertice se usa esa
  // normal con el signo de z suavizado segun el lado (sin(th)): torso y mangas comparten la luz
  // en cada punto, y en el costado la normal pasa de frente a espalda sin salto.
  const ZSIGN = Math.sin(25 * Math.PI / 180);
  let PULL = 0.01;                                       // se fija por kit: 2,5 pixeles de la rejilla
  function tube(rings, d, uvOf, mat, caps, normalAt, useEdge = true) {
    const u = [-d[1], d[0]];
    const n = rings.length, V = SEG + 1;
    const pos = [], uv = [], side = [], edge = [], nrm = [], idx = [];
    const push = (x, y, z, w, e) => { pos.push(x, y, z); const t = uvOf(x, y); uv.push(t[0], t[1]); side.push(w); edge.push(e); return pos.length / 3 - 1; };
    for (let k = 0; k < n; k++) {
      const r = rings[k];
      for (let s = 0; s <= SEG; s++) {
        const th = s / SEG * Math.PI * 2, e = 2 / (r.p || 2);
        const cs = Math.cos(th), sn = Math.sin(th);
        const ca = r.a * Math.sign(cs) * Math.pow(Math.abs(cs), e);
        const x = r.cx + ca * u[0], y = r.cy + ca * u[1];
        // El campo se lee un poco HACIA DENTRO del contorno (en la direccion de su propia normal):
        // justo en el filo cambia de golpe y medio pixel de diferencia entre anillos daba rayas.
        // Se lee hacia el centro del propio anillo (direccion suave y determinista), no por la
        // normal del campo: en el borde exacto de la silueta el campo tiene ruido de pixel y cada
        // vertice del costado leia un valor distinto (rayitas en la luz y en la textura).
        let f = null;
        if (normalAt) {
          const k = Math.max(0, (r.a - PULL) / r.a);
          f = normalAt(r.cx + ca * k * u[0], r.cy + ca * k * u[1]);
        }
        // Donde la superficie mira de lado respecto a la foto, la foto llega estirada y se usa la
        // textura suavizada: por angulo de la seccion (costados, filos de manga) o por el campo
        // (techo del hombro), lo que sea mayor.
        const sf = f ? Math.min(1, Math.max(0, (0.6 - f[2]) / 0.45)) : 0;
        const stretch = Math.max(edgeWeight(th), sf);
        push(x, y, r.b * Math.sign(sn) * Math.pow(Math.abs(sn), e), sideWeight(th), useEdge ? stretch * stretch * (3 - 2 * stretch) : 0);
        if (f) {
          const sg = Math.max(-1, Math.min(1, Math.sin(th) / ZSIGN));
          const nz = f[2] * sg, l = Math.hypot(f[0], f[1], nz) || 1;
          nrm.push(f[0] / l, f[1] / l, nz / l);
        }
      }
    }
    for (let k = 0; k < n - 1; k++) for (let s = 0; s < SEG; s++) {
      const a = k * V + s, b = a + 1, c = a + V, d = c + 1;
      idx.push(a, b, c, b, d, c);                        // antihorario visto desde fuera
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('side', new THREE.Float32BufferAttribute(side, 1));
    g.setAttribute('edge', new THREE.Float32BufferAttribute(edge, 1));
    g.setIndex(idx);
    if (normalAt) g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    else g.computeVertexNormals();
    const out = new THREE.Group();
    out.add(new THREE.Mesh(g, mat));
    // Interior oscuro y hundido en los extremos abiertos (bocamanga, bajo): de perfil se ve la
    // abertura de la prenda, no una tapa plana con la tela estirada.
    for (const end of caps || []) {
      const k = end === 'start' ? 0 : (typeof end === 'number' ? end : n - 1), r = rings[k];
      const len = Math.hypot(rings[n - 1].cx - rings[0].cx, rings[n - 1].cy - rings[0].cy);
      const inset = (end === 'start' ? 1 : -1) * Math.min(0.08 * len, 0.06);
      const cp = [], ci = [];
      const cxp = r.cx + d[0] * inset, cyp = r.cy + d[1] * inset;
      cp.push(cxp, cyp, 0);
      for (let s = 0; s <= SEG; s++) {
        const th = s / SEG * Math.PI * 2, sh = 0.94, ca = r.a * sh * Math.cos(th);
        cp.push(cxp + ca * u[0], cyp + ca * u[1], r.b * sh * Math.sin(th));
      }
      for (let s = 1; s <= SEG; s++) ci.push(0, s, s + 1);
      const cg = new THREE.BufferGeometry();
      cg.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
      cg.setIndex(ci);
      cg.computeVertexNormals();
      out.add(new THREE.Mesh(cg, innerMat));
    }
    return out;
  }
  const innerMat = renderer ? new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 1, metalness: 0, side: THREE.DoubleSide }) : null;

  // Un solo material con las dos fotos: en el fragmento se mezclan segun el peso del vertice,
  // asi el costado no muestra una linea donde cambia la textura.
  // La transparencia (recorte del escote y de la bocamanga) se lee de copias de las fotos SIN
  // mipmaps: en las versiones reducidas el borde se promediaba con el fondo y, al ver el costado
  // en angulo, el recorte abria agujeros en un patron regular por los que se veia el interior.
  function alphaCopy(t) {
    const a = new THREE.Texture(t.image);
    a.minFilter = THREE.LinearFilter; a.magFilter = THREE.LinearFilter; a.generateMipmaps = false;
    a.needsUpdate = true;
    return a;
  }
  function blendMaterial(tf, tb, sf, sb) {
    const m = new THREE.MeshStandardMaterial({ map: tf, roughness: 0.85, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.5, alphaToCoverage: true });
    const af = alphaCopy(tf), ab = alphaCopy(tb);
    m.onBeforeCompile = sh => {
      sh.uniforms.backMap = { value: tb };
      sh.uniforms.sideFront = { value: sf };
      sh.uniforms.sideBack = { value: sb };
      sh.uniforms.alphaFront = { value: af };
      sh.uniforms.alphaBack = { value: ab };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float side;\nattribute float edge;\nvarying float vSide;\nvarying float vEdge;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvSide = side;\nvEdge = edge;');
      // En el costado (vEdge -> 1) la foto llega estirada: ahi se usa la textura de costado
      // (suavizada a lo largo del contorno), mezclando frente y espalda por vSide.
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D backMap;\nuniform sampler2D sideFront;\nuniform sampler2D sideBack;\nuniform sampler2D alphaFront;\nuniform sampler2D alphaBack;\nvarying float vSide;\nvarying float vEdge;')
        .replace('#include <map_fragment>',
          'vec4 photo = mix(texture2D(backMap, vUv), texture2D(map, vUv), vSide);\n' +
          'vec4 sideCol = mix(texture2D(sideBack, vUv), texture2D(sideFront, vUv), vSide);\n' +
          'float alphaCut = mix(texture2D(alphaBack, vUv).a, texture2D(alphaFront, vUv).a, vSide);\n' +
          'vec4 texelColor = vec4(mix(photo.rgb, sideCol.rgb, vEdge), alphaCut);\n' +
          'texelColor = mapTexelToLinear(texelColor);\ndiffuseColor *= texelColor;');
    };
    m.customProgramCacheKey = () => 'frontback3';
    return m;
  }

  async function buildKit(id) {
    if (meshes[id]) return meshes[id];
    const [geo, tf, tb, sf, sb, nimg] = await Promise.all([
      loadJson(`assets/${id}_geo.json`), loadTex(`assets/${id}_tex_front.webp`), loadTex(`assets/${id}_tex_back.webp`),
      loadTex(`assets/${id}_side_front.webp`), loadTex(`assets/${id}_side_back.webp`), loadImage(`assets/${id}_nrm.png`)
    ]);
    const W = geo.w, H = geo.h, px = 2 / (W - 1), aspect = H / W;
    PULL = 10 * px;
    const X = i => (i / (W - 1) - 0.5) * 2;
    const Y = j => (0.5 - j / (H - 1)) * 2 * aspect;
    const nc = document.createElement('canvas'); nc.width = nimg.width; nc.height = nimg.height;
    const nctx = nc.getContext('2d'); nctx.drawImage(nimg, 0, 0);
    const nd = nctx.getImageData(0, 0, nc.width, nc.height).data, NW = nc.width, NH = nc.height;
    // Mapa de altura de 16 bits (R,G) a 2x de la rejilla: las normales salen de su pendiente.
    const hscale = (geo.hmax || 1) / 65535;
    const hAt = (i, j) => {
      i = Math.min(NW - 1, Math.max(0, i)); j = Math.min(NH - 1, Math.max(0, j));
      const k = (j * NW + i) * 4;
      return (nd[k] * 256 + nd[k + 1]) * hscale;
    };
    const hBil = (fi, fj) => {
      const i0 = Math.floor(fi), j0 = Math.floor(fj), ti = fi - i0, tj = fj - j0;
      return (hAt(i0, j0) * (1 - ti) + hAt(i0 + 1, j0) * ti) * (1 - tj) + (hAt(i0, j0 + 1) * (1 - ti) + hAt(i0 + 1, j0 + 1) * ti) * tj;
    };
    const RES = NW / W;                                   // pixeles del mapa por pixel de rejilla
    const normalAt = (x, y) => {
      const fi = (x / 2 + 0.5) * (NW - 1), fj = (0.5 - y / (2 * aspect)) * (NH - 1);
      const st = 1.0;
      const dx = (hBil(fi + st, fj) - hBil(fi - st, fj)) / (2 * st) * RES;   // por pixel de rejilla
      const dy = (hBil(fi, fj + st) - hBil(fi, fj - st)) / (2 * st) * RES;   // j crece hacia abajo
      const nx = -dx, ny = dy, nz = 1, l = Math.hypot(nx, ny, nz);
      return [nx / l, ny / l, nz / l];
    };
    const uvOf = (x, y) => [x / 2 + 0.5, (y / (2 * aspect)) + 0.5];
    const mat = blendMaterial(tf, tb, sf, sb);
    if (KITS[id].tone) mat.color.setScalar(KITS[id].tone);   // tejido muy claro: sin esto la luz lo satura a blanco

    // Suavizado leve de los perfiles: la luz sale del campo de normales, asi que la malla puede
    // seguir la silueta casi exacta (un suavizado fuerte redondeaba la esquina del hombro).
    const smooth = (arr, sigma) => {
      const R = Math.ceil(sigma * 3), out = new Array(arr.length);
      for (let i = 0; i < arr.length; i++) {
        let s = 0, ws = 0;
        for (let k = -R; k <= R; k++) {
          const q = Math.min(arr.length - 1, Math.max(0, i + k));
          const w = Math.exp(-(k * k) / (2 * sigma * sigma));
          s += arr[q] * w; ws += w;
        }
        out[i] = s / ws;
      }
      return out;
    };
    const bodyHalf = (geo.bodyR - geo.bodyL) / 2 * px;
    const bodyB = bodyHalf * BODY_DEPTH;
    const bl = smooth(geo.body.map(b => b[1]), 2), br = smooth(geo.body.map(b => b[2]), 2);
    const rings = geo.body.map(([j], k) => {
      const a = (br[k] - bl[k]) / 2 * px;
      return { cx: X((bl[k] + br[k]) / 2), cy: Y(j), a, b: Math.min(bodyB, a * 0.9) };
    });
    // Por encima del hombro la seccion se aplana hacia el cuello
    const armY = Y(geo.armpit), topY = rings[0].cy;
    for (const r of rings) if (r.cy > armY) { const t = (r.cy - armY) / Math.max(topY - armY, 1e-6); r.b *= 1 - 0.55 * t * t; }
    const chestY = armY - 0.25;
    for (const r of rings) { const t = Math.min(1, Math.max(0, (r.cy - chestY) / Math.max(armY - chestY, 1e-6))); r.p = 2 + 1.2 * t; }
    const group = new THREE.Group();
    group.add(tube(rings, [0, -1], uvOf, mat, ['end'], normalAt)); // cuerpo de arriba abajo; abertura en el bajo

    for (const sl of geo.sleeves) {
      if (!sl || sl.rings.length < 4) continue;
      const sa = smooth(sl.rings.map(r => r[2]), 3);
      const scx = smooth(sl.rings.map(r => r[0]), 2), scy = smooth(sl.rings.map(r => r[1]), 2);
      // Manga casi circular (una manga real es un tubo), limitada por el grosor del torso.
      const sr = sl.rings.map((_, k) => {
        const a = sa[k] * px;
        return { cx: X(scx[k]), cy: Y(scy[k]), a, b: Math.min(a * SLEEVE_DEPTH, bodyB * 0.95) };
      });
      const dlen = Math.hypot(sl.d[0], sl.d[1]);
      const d = [sl.d[0] / dlen, -sl.d[1] / dlen];              // eje de la manga, con y hacia arriba
      group.add(tube(sr, d, uvOf, mat, [sl.capAt ?? sr.length - 1], normalAt)); // interior en el ultimo anillo completo
    }
    group.position.y = -0.04;
    meshes[id] = group;
    return group;
  }

  function resize() {
    if (!renderer) return;
    const w = stage.clientWidth, h = stage.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    drawnKey = null;
  }

  async function selectKit(id) {
    kit = id;
    kitBtns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.kit === kit)));
    lastSide = null;
    if (!renderer) { renderFallback(); return; }
    loading.hidden = false;
    const g = await buildKit(id);
    loading.hidden = true;
    pivot.clear();
    pivot.add(g);
    drawnKey = null;
  }

  const norm = d => ((d % 360) + 360) % 360;

  function updateUi() {
    const c = Math.cos(rot * Math.PI / 180);
    degEl.textContent = Math.round(norm(rot)) + String.fromCharCode(176);
    const side = c >= 0 ? 'front' : 'back';
    if (side !== lastSide) {
      lastSide = side;
      const k = KITS[kit];
      const dot = String.fromCharCode(183);
      nowEl.textContent = `Kit ${k.n}${k.opt ? ' ' + dot + ' ' + k.opt : ''} ${dot} ${side === 'front' ? 'Front' : 'Back'}`;
      stage.setAttribute('aria-label', `${k.name}, ${side} view. Drag or use the arrow keys to turn the jersey; scroll or pinch to zoom.`);
      legend.forEach(li => li.classList.toggle('on', li.dataset.on === side));
      sideBtns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.side === side)));
      if (!renderer) renderFallback();
    }
  }

  function renderFallback() {
    const k = KITS[kit];
    fallback.src = Math.cos(rot * Math.PI / 180) >= 0 ? k.flat : k.flatBack;
  }

  function draw() {
    const key = rot + '|' + zoom;
    if (drawnKey === key) return;
    drawnKey = key;
    updateUi();
    if (renderer) {
      pivot.rotation.y = rot * Math.PI / 180;
      camera.position.z = CAM_DIST / zoom;
      camera.position.y = 0.1 / zoom;
      renderer.render(scene, camera);
    }
  }

  function goTo(side) {
    const off = side === 'front' ? 0 : 180;
    target = Math.round((rot - off) / 360) * 360 + off;
    vel = 0;
    idleAt = performance.now();
    if (reduce || !renderer) { rot = target; target = null; }
  }
  function setZoom(z) { zoomTarget = Math.min(2.6, Math.max(0.7, z)); idleAt = performance.now(); }

  function tick(now) {
    if (!dragging) {
      if (target !== null) {
        const d = target - rot;
        rot += d * 0.12;
        if (Math.abs(d) < 0.15) { rot = target; target = null; idleAt = now; }
      } else if (Math.abs(vel) > 0.04) {
        rot += vel; vel *= 0.94; idleAt = now;
      } else if (!reduce && renderer && now - idleAt > 3200) {
        rot += 0.18;
      }
    }
    if (Math.abs(zoomTarget - zoom) > 0.001) zoom += (zoomTarget - zoom) * (reduce ? 1 : 0.18); else zoom = zoomTarget;
    draw();
    requestAnimationFrame(tick);
  }

  stage.addEventListener('pointerdown', e => {
    pointers.set(e.pointerId, e);
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('used');
    if (pointers.size === 2) {
      const [p1, p2] = [...pointers.values()];
      pinchDist = Math.hypot(p1.clientX - p2.clientX, p1.clientY - p2.clientY);
      dragging = false;
      return;
    }
    dragging = true; target = null; vel = 0;
    lastX = e.clientX; lastT = performance.now();
    stage.classList.add('grabbing');
  });
  stage.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, e);
    if (pointers.size === 2) {
      const [p1, p2] = [...pointers.values()];
      const d = Math.hypot(p1.clientX - p2.clientX, p1.clientY - p2.clientY);
      if (pinchDist > 0) { zoomTarget = Math.min(2.6, Math.max(0.7, zoomTarget * d / pinchDist)); zoom = zoomTarget; }
      pinchDist = d;
      return;
    }
    if (!dragging) return;
    const now = performance.now();
    const dx = e.clientX - lastX;
    rot += dx * 0.5;
    vel = (dx * 0.5) / Math.max(now - lastT, 1) * 16;
    lastX = e.clientX; lastT = now;
  });
  const end = e => {
    pointers.delete(e.pointerId);
    pinchDist = 0;
    if (!dragging) return;
    dragging = false; idleAt = performance.now(); stage.classList.remove('grabbing');
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('wheel', e => { e.preventDefault(); setZoom(zoomTarget * Math.pow(1.0015, -e.deltaY)); stage.classList.add('used'); }, { passive: false });
  stage.addEventListener('dblclick', () => setZoom(zoomTarget > 1.2 ? 1 : 1.8));
  stage.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault(); target = null; vel = 0;
      rot += e.key === 'ArrowLeft' ? -15 : 15;
      idleAt = performance.now(); stage.classList.add('used');
    } else if (e.key === '+' || e.key === '=') { setZoom(zoomTarget * 1.2); }
    else if (e.key === '-') { setZoom(zoomTarget / 1.2); }
  });
  zoomIn.addEventListener('click', () => setZoom(zoomTarget * 1.25));
  zoomOut.addEventListener('click', () => setZoom(zoomTarget / 1.25));
  zoomReset.addEventListener('click', () => { setZoom(1); goTo('front'); });

  sideBtns.forEach(b => b.addEventListener('click', () => goTo(b.dataset.side)));
  kitBtns.forEach(b => b.addEventListener('click', () => selectKit(b.dataset.kit)));
  const toStage = () => stage.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
  document.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => { goTo(b.dataset.goto); toStage(); }));
  document.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', async () => { await selectKit(b.dataset.open); goTo('front'); toStage(); }));

  addEventListener('resize', resize);
  resize();
  selectKit('j3').then(() => {
    if (renderer) { buildKit('j4'); buildKit('j1'); buildKit('j2'); }
    idleAt = performance.now();
    requestAnimationFrame(tick);
  }).catch(() => {
    if (renderer) { renderer = null; canvas.hidden = true; fallback.hidden = false; }
    loading.hidden = true;
    renderFallback();
    requestAnimationFrame(tick);
  });
})();
