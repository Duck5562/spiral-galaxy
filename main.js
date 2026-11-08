'use strict';
/*
 * Spiral Galaxy: see your vault as a slowly spinning spiral galaxy.
 *
 * Every note is a star, sized by its links. Each arm of the galaxy is a group of folders (yours to choose, or picked
 * automatically), each folder is a glowing star cluster along its arm with its hub note in the middle, your top-level
 * notes are the bright core, and any "moon" folders become a little satellite galaxy.
 * Hover a star for its name and links, click it to open the note, scroll to zoom, drag to move, and drag the bright
 * middle to swing the whole galaxy like jelly.
 *
 * Star positions are seeded from each note's path, so the galaxy looks the same every time you open it.
 * Speed: the deep-space background is painted once onto its own canvas. The galaxy's glow, clouds, dust lanes and tiny
 * stars are all separate dots drawn by the graphics card; they share a few dozen jelly springs, so each dot can lag on
 * its own for almost no cost. Every note star is one pre-made sprite; the view only redraws when something moves.
 */
const { Plugin, ItemView, PluginSettingTab, Setting, TFolder, debounce } = require('obsidian');

const VIEW_TYPE = 'spiral-galaxy-view';
const PALETTE = ['#86aaff', '#ff7f6e', '#ff9f45', '#6fd6e8', '#f4efe0', '#f07fc0', '#ffd36b', '#a98cff', '#b7d4ff'];
const DEFAULT_SETTINGS = {
	arms: [],               // [{ name, color, folders: [path, ...] }]; empty = chosen automatically from your folders
	coreFolders: [''],      // notes directly inside these folders form the bright core ('' = the vault root)
	coreName: 'Core', coreColor: '#ffd98a', coreAltColor: '#e8d8c0',
	moonFolders: [], moonName: 'Moon', moonColor: '#c8d4f0',
	homeNote: '', homeColor: '#fff8ea',
	spinOnOpen: true, spinSpeed: 1, dust: 'normal', jelly: true, showLegend: true,
};
const DUST = { none: 0, light: 0.5, normal: 1, rich: 2 };
const R = 1000;          // galaxy radius (world units)
const WIND = 2.7;        // how far each arm curls (radians from core to tip)
const SPIN = -0.012;     // radians per second at spin speed 1 (negative = anticlockwise, so the arms trail behind like a real galaxy's)
const TILT = 0.6;        // how flat it looks: 1 = seen from straight above, lower = flatter
const ROLL = -0.2;       // how far it leans, in radians (negative = rising to the right)
const COS_ROLL = Math.cos(ROLL), SIN_ROLL = Math.sin(ROLL), LIFT = Math.sqrt(1 - TILT * TILT); // (LIFT: how much a star's height above the disc shows)
const FRAME = 16;        // ms between redraws (60 a second)
const CLOUD_TILE = 512;  // size of the repeating cloud noise (must be a power of 2)
// the dots the galaxy is made of. Gap = world units between neighbouring dots (smaller = more dots and more detail, but slower)
const HAZE_GAP = 34, CLOUD_GAP = 11, DUST_GAP = 9;
const ARM_STARS = 46000, DISC_STARS = 46000, CORE_STARS = 8000, MOON_STARS = 700, CORE_BLOBS = 2500; // tiny stars and core glow, at normal dust
const DOT_VARY = 0.9;    // how much brighter or dimmer each glow dot is than its neighbours (0 = smooth, higher = more speckled)
const JELLY_VARY = 0.4;  // how differently dots next to each other lag when you swing the galaxy (0 = together, higher = they scatter more)
// how far each kind of dot wanders on its own as the galaxy spins (world units), so it never looks like a solid sheet
const WANDER_HAZE = 10, WANDER_CLOUD = 6, WANDER_DUST = 6, WANDER_STAR = 2.5;
const STRIDE = 11;       // numbers per dot: x, y, z, r, g, b, a, size in the galaxy, size on screen, jelly group, wander phase
const GROUPS = 48;       // the dots share this many jelly springs, from floppy to stiff
const K_LOW = 4, K_HIGH = 100;
// notes aren't all equally bright. MIN = how faint the faintest ones get (1 = none faded). CURVE = how many are faded (lower = fewer)
const NOTE_FADE_MIN = 0.22, NOTE_FADE_CURVE = 0.45;
const SKY_MARGIN = 1.1;  // the space background is this much bigger than the view, so it can drift when you drag
const SKY_DRIFT = 0.04;  // how far the background moves compared with the galaxy when you drag
const EXPOSURE = 1.1;   // how bright the galaxy is; very bright parts roll off to white-gold like a photograph
// the galaxy's colour from the middle (0) to past the edge (1.4 R): white-gold, orange, tan, grey-lilac, then blue
const RAMP = [[0, 1, 0.95, 0.8], [0.08, 1, 0.82, 0.5], [0.2, 1, 0.56, 0.2], [0.36, 0.95, 0.43, 0.18], [0.5, 0.85, 0.52, 0.36], [0.66, 0.68, 0.64, 0.72], [0.82, 0.5, 0.62, 0.92], [1, 0.34, 0.5, 0.98], [1.4, 0.16, 0.24, 0.7]];
// jelly drag: stiff near the core, loose at the edge, a little bouncy
const K_CORE = 70, K_EDGE = 7, BOUNCE = 0.45, K_BACKDROP = 14;
const HUB = /(start here|readme|index|hub|moc|overview)$|^00 /i;

function seeded(str) { // mulberry32 seeded from a string
	let h = 1779033703 ^ str.length;
	for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
	let a = h >>> 0;
	return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gauss(rnd) { return Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd()); }
function armWidth(t) { return R * (0.016 + 0.045 * t); }
function rgba(hex, a) {
	let h = String(hex || '#ffffff').replace('#', '');
	if (h.length === 3) h = h.split('').map(c => c + c).join('');
	const n = parseInt(h, 16) || 0;
	return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
function rgb01(hex) {
	let h = String(hex || '#ffffff').replace('#', '');
	if (h.length === 3) h = h.split('').map(c => c + c).join('');
	const n = parseInt(h, 16) || 0;
	return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function mixHex(hex, other, t) {
	const a = rgb01(hex), b = rgb01(other), m = i => Math.round((a[i] + (b[i] - a[i]) * t) * 255);
	return `rgb(${m(0)},${m(1)},${m(2)})`;
}
function smooth(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
// a square of soft, repeating cloud noise (0..1), made once and shared; every cloud and dust lane is read from it
let cloudTile = null;
function clouds() {
	if (cloudTile) return cloudTile;
	const S = CLOUD_TILE, out = new Float32Array(S * S), rnd = seeded('clouds');
	let cells = 4, amp = 1;
	for (let o = 0; o < 6; o++, cells *= 2, amp *= 0.55) {
		const grid = new Float32Array(cells * cells);
		for (let i = 0; i < grid.length; i++) grid[i] = rnd();
		for (let y = 0; y < S; y++) {
			const fy = (y / S) * cells, iy = Math.floor(fy), ty = fy - iy, sy = ty * ty * (3 - 2 * ty), y0 = iy * cells, y1 = ((iy + 1) % cells) * cells;
			for (let x = 0; x < S; x++) {
				const fx = (x / S) * cells, ix = Math.floor(fx), tx = fx - ix, sx = tx * tx * (3 - 2 * tx), x1 = (ix + 1) % cells;
				const a = grid[y0 + ix], b = grid[y0 + x1], c = grid[y1 + ix], d = grid[y1 + x1];
				out[y * S + x] += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
			}
		}
	}
	let lo = Infinity, hi = -Infinity;
	for (const v of out) { if (v < lo) lo = v; if (v > hi) hi = v; }
	for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) / (hi - lo);
	return (cloudTile = out);
}
function cloudAt(tile, x, y) { // smooth lookup; x and y are in tile pixels and can be any size
	const m = CLOUD_TILE - 1, ix = Math.floor(x), iy = Math.floor(y), tx = x - ix, ty = y - iy, x0 = ix & m, x1 = (ix + 1) & m, y0 = (iy & m) * CLOUD_TILE, y1 = ((iy + 1) & m) * CLOUD_TILE;
	const a = tile[y0 + x0], b = tile[y0 + x1], c = tile[y1 + x0], d = tile[y1 + x1];
	return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}
function cleanFolder(p) { const f = String(p || '').trim().replace(/^\/+|\/+$/g, ''); return f; }
function lines(text) { return String(text || '').split('\n').map(l => l.trim()).filter(Boolean); }
function parentPath(file) { return file.parent && file.parent.path !== '/' ? file.parent.path : ''; }
function inFolder(path, folder) { return folder === '' || path.startsWith(folder + '/'); }

// Draws the dots on the graphics card. They're added up in a high-range buffer first, then rolled off like a photograph,
// so thousands of faint dots build into smooth light without banding.
const DOT_VERT = `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec3 aPos;
layout(location = 2) in vec4 aColor;
layout(location = 3) in vec2 aSize;
layout(location = 4) in vec2 aExtra;
uniform vec2 uView, uCenter, uSpin, uRoll;
uniform vec2 uLag[${GROUPS}];
uniform float uScale, uTilt, uLift, uTime, uWander, uFade, uGain, uGrow;
out vec2 vUv;
out vec4 vColor;
void main() {
	float ph = aExtra.y;
	vec2 p = aPos.xy + uWander * vec2(sin(uTime * (0.2 + fract(ph * 3.7) * 0.25) + ph), cos(uTime * (0.16 + fract(ph * 5.3) * 0.25) + ph * 1.7));
	float ax = p.x * uSpin.x - p.y * uSpin.y, ay = (p.x * uSpin.y + p.y * uSpin.x) * uTilt + aPos.z * uLift;
	vec2 at = uCenter + vec2(ax * uRoll.x - ay * uRoll.y, ax * uRoll.y + ay * uRoll.x) * uScale + uLag[int(aExtra.x)];
	vec2 lying = aCorner * aSize.x * uScale; // glow and dust dots lie flat in the disc; tiny stars stay round
	lying.y *= uTilt;
	at += vec2(lying.x * uRoll.x - lying.y * uRoll.y, lying.x * uRoll.y + lying.y * uRoll.x) + aCorner * aSize.y * uGrow;
	gl_Position = vec4(at.x / uView.x * 2.0 - 1.0, 1.0 - at.y / uView.y * 2.0, 0.0, 1.0);
	vUv = aCorner;
	vColor = vec4(aColor.rgb * uGain, aColor.a) * uFade;
}`;
const DOT_FRAG = `#version 300 es
precision highp float;
uniform float uPow;
in vec2 vUv;
in vec4 vColor;
out vec4 color;
void main() { float k = 1.0 - dot(vUv, vUv); color = k > 0.0 ? vColor * pow(k, uPow) : vec4(0.0); }`;
const TONE_VERT = `#version 300 es
void main() { gl_Position = vec4(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0, 0.0, 1.0); }`;
const TONE_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform float uGain;
out vec4 color;
void main() {
	vec4 h = texelFetch(uTex, ivec2(gl_FragCoord.xy), 0);
	vec3 c = 1.0 - exp(-h.rgb / uGain * ${EXPOSURE.toFixed(3)});
	float a = clamp(max(max(c.r, max(c.g, c.b)) * 1.05, h.a * 0.72), 0.0, 1.0);
	float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5; // stops dark gradients showing as bands
	color = vec4(clamp(c + n / 255.0, vec3(0.0), vec3(a)), a);
}`;
class DotPainter {
	constructor(canvas) { this.canvas = canvas; this.layers = []; this.ok = this.init(); }
	init() {
		const gl = (this.gl = this.canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false }));
		if (!gl) return false;
		const program = (vs, fs) => {
			const p = gl.createProgram();
			for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
				const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
				if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
				gl.attachShader(p, sh);
			}
			gl.linkProgram(p);
			if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
			return p;
		};
		try { this.dot = program(DOT_VERT, DOT_FRAG); this.tone = program(TONE_VERT, TONE_FRAG); } catch (e) { console.error('Spiral Galaxy:', e); return false; }
		this.u = {};
		for (const n of ['uView', 'uCenter', 'uSpin', 'uRoll', 'uLag', 'uScale', 'uTilt', 'uLift', 'uTime', 'uWander', 'uFade', 'uGain', 'uGrow', 'uPow']) this.u[n] = gl.getUniformLocation(this.dot, n);
		this.uTex = gl.getUniformLocation(this.tone, 'uTex'); this.uToneGain = gl.getUniformLocation(this.tone, 'uGain');
		this.corners = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, this.corners); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
		this.emptyVao = gl.createVertexArray();
		this.hdr = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
		this.target = gl.createTexture(); this.fbo = gl.createFramebuffer();
		this.bw = this.bh = 0;
		return true;
	}
	resize(w, h) {
		const gl = this.gl;
		if (!this.ok || (w === this.bw && h === this.bh)) return;
		this.bw = w; this.bh = h;
		const alloc = hdr => {
			gl.bindTexture(gl.TEXTURE_2D, this.target);
			gl.texImage2D(gl.TEXTURE_2D, 0, hdr ? gl.RGBA16F : gl.RGBA8, w, h, 0, gl.RGBA, hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
			gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
			gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.target, 0);
			return gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
		};
		if (!(this.hdr && alloc(true))) { this.hdr = false; alloc(false); }
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	}
	setLayers(layers) {
		const gl = this.gl;
		if (!this.ok) return;
		for (const l of this.layers) { gl.deleteBuffer(l.buffer); gl.deleteVertexArray(l.vao); }
		this.layers = layers.map(l => {
			const buffer = gl.createBuffer(), vao = gl.createVertexArray(), bytes = STRIDE * 4;
			gl.bindVertexArray(vao);
			gl.bindBuffer(gl.ARRAY_BUFFER, this.corners); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
			gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, l.data.subarray(0, l.count * STRIDE), gl.STATIC_DRAW);
			[[1, 3, 0], [2, 4, 12], [3, 2, 28], [4, 2, 36]].forEach(([loc, size, at]) => {
				gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, bytes, at); gl.vertexAttribDivisor(loc, 1);
			});
			gl.bindVertexArray(null);
			return { buffer, vao, count: l.count, kind: l.kind, pow: l.pow, wander: l.wander };
		});
	}
	draw(v) {
		const gl = this.gl, u = this.u, gain = this.hdr ? 1 : 0.5;
		if (!this.ok || gl.isContextLost()) return;
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
		gl.viewport(0, 0, this.bw, this.bh);
		gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
		gl.useProgram(this.dot);
		gl.uniform2f(u.uView, v.w, v.h); gl.uniform2f(u.uCenter, v.cx, v.cy); gl.uniform2f(u.uSpin, v.cs, v.sn); gl.uniform2f(u.uRoll, COS_ROLL, SIN_ROLL);
		gl.uniform2fv(u.uLag, v.lag);
		gl.uniform1f(u.uScale, v.scale); gl.uniform1f(u.uTilt, TILT); gl.uniform1f(u.uLift, LIFT); gl.uniform1f(u.uTime, v.time);
		gl.uniform1f(u.uFade, v.fade); gl.uniform1f(u.uGain, gain); gl.uniform1f(u.uGrow, Math.pow(v.zoom, 0.35));
		gl.enable(gl.BLEND);
		for (const l of this.layers) {
			// glow and stars add light (leaving alpha alone); dust covers what's behind it
			if (l.kind === 'add') gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE); else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
			gl.uniform1f(u.uWander, l.wander); gl.uniform1f(u.uPow, l.pow);
			gl.bindVertexArray(l.vao);
			gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, l.count);
		}
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, 0, this.bw, this.bh);
		gl.disable(gl.BLEND);
		gl.useProgram(this.tone);
		gl.bindVertexArray(this.emptyVao);
		gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.target);
		gl.uniform1i(this.uTex, 0); gl.uniform1f(this.uToneGain, gain);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		gl.bindVertexArray(null);
	}
	free() { const lose = this.gl && this.gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); }
}

class GalaxyView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
		this.stars = []; this.labels = []; this.byPath = new Map(); this.adj = new Map();
		this.zoom = 1; this.panX = 0; this.panY = 0; this.spin = 0; this.cs = 1; this.sn = 0;
		this.spinning = plugin.settings.spinOnOpen;
		this.hover = null; this.drag = null; this.glows = {}; this.starSprites = {}; this.dirty = true; this.lastDraw = 0;
		this.bg = { ox: 0, oy: 0, vx: 0, vy: 0 }; this.wobbling = false; this.fade = 1; this.time = 0;
		this.groups = Array.from({ length: GROUPS }, (_, i) => ({ k: K_LOW * Math.pow(K_HIGH / K_LOW, i / (GROUPS - 1)), ox: 0, oy: 0, vx: 0, vy: 0 }));
		this.lag = new Float32Array(GROUPS * 2);
	}
	getViewType() { return VIEW_TYPE; }
	getDisplayText() { return 'Galaxy'; }
	getIcon() { return 'sparkles'; }

	async onOpen() {
		const el = this.contentEl;
		el.empty(); el.addClass('spiral-galaxy');
		this.sky = el.createEl('canvas', { cls: 'spiral-galaxy-sky' });
		this.dotCanvas = el.createEl('canvas', { cls: 'spiral-galaxy-dots' });
		this.canvas = el.createEl('canvas', { cls: 'spiral-galaxy-canvas' });
		const painter = new DotPainter(this.dotCanvas);
		this.dots = painter.ok ? painter : null; // (without WebGL2 a much simpler version is drawn instead)
		// the graphics card can drop what it's holding (e.g. when a laptop sleeps): set it all up again when it comes back
		this.registerDomEvent(this.dotCanvas, 'webglcontextlost', e => e.preventDefault());
		this.registerDomEvent(this.dotCanvas, 'webglcontextrestored', () => {
			if (!this.dots || !this.dots.init()) return;
			this.dots.layers = []; this.dots.resize(this.canvas.width, this.canvas.height);
			if (this.layers) this.dots.setLayers(this.layers);
			this.dirty = true;
		});
		this.ctx = this.canvas.getContext('2d');
		this.font = getComputedStyle(document.body).getPropertyValue('--font-interface').trim() || 'sans-serif';
		el.createDiv({ cls: 'spiral-galaxy-hint', text: 'Scroll to zoom · drag to move · drag the bright middle to swing it · click a star to open it' });
		this.legend = el.createDiv({ cls: 'spiral-galaxy-legend' });
		this.spinBtn = el.createEl('button', { cls: 'spiral-galaxy-spin' });
		this.spinBtn.setText('Spin: ' + (this.spinning ? 'on' : 'off'));
		this.registerDomEvent(this.spinBtn, 'click', () => { this.spinning = !this.spinning; this.spinBtn.setText('Spin: ' + (this.spinning ? 'on' : 'off')); });

		this.resize = new ResizeObserver(() => this.fit());
		this.resize.observe(el);
		this.registerDomEvent(this.canvas, 'wheel', e => this.onWheel(e), { passive: false });
		this.registerDomEvent(this.canvas, 'mousedown', e => {
			const home = !!this.hover && this.hover === this.home && this.plugin.settings.jelly;
			this.drag = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, px: this.panX, py: this.panY, moved: false, home };
		});
		this.registerDomEvent(window, 'mouseup', e => this.onUp(e));
		this.registerDomEvent(this.canvas, 'mousemove', e => this.onMove(e));
		this.registerDomEvent(this.canvas, 'mouseleave', () => { this.hover = null; this.dirty = true; });
		// right after Obsidian starts the links are still being read, so refresh the sizes every 2 s until they settle
		const later = () => { if (!this.rebuildTimer) this.rebuildTimer = window.setTimeout(() => { this.rebuildTimer = null; this.build(); }, 2000); };
		this.registerEvent(this.app.metadataCache.on('resolve', later));
		this.registerEvent(this.app.metadataCache.on('resolved', later));
		this.registerEvent(this.app.vault.on('rename', later));
		this.registerEvent(this.app.vault.on('delete', later));

		this.build(); this.fit();
		let last = performance.now();
		const loop = now => {
			if (this.closed) return;
			this.frame = requestAnimationFrame(loop);
			const dt = Math.min(0.1, (now - last) / 1000); last = now;
			if (this.wobbling) { this.wobbling = this.step(Math.min(dt, 1 / 30)); this.dirty = true; }
			if (this.fade < 1) { this.fade = Math.min(1, this.fade + dt / 0.8); this.dirty = true; }
			if (this.spinning && !this.hover && !(this.drag && this.drag.moved)) { this.spin += dt * SPIN * this.plugin.settings.spinSpeed; this.time = (this.time + dt) % 3600; this.dirty = true; }
			if (!this.dirty || now - this.lastDraw < FRAME || !this.contentEl.isShown()) return;
			this.lastDraw = now; this.dirty = false;
			this.draw();
		};
		this.frame = requestAnimationFrame(loop);
	}
	async onClose() {
		this.closed = true;
		cancelAnimationFrame(this.frame);
		if (this.resize) this.resize.disconnect();
		window.clearTimeout(this.rebuildTimer);
		window.clearTimeout(this.skyTimer);
		if (this.dots) this.dots.free();
	}

	fit() {
		const r = this.contentEl.getBoundingClientRect();
		this.w = Math.max(1, r.width); this.h = Math.max(1, r.height); this.dpr = Math.min(window.devicePixelRatio || 1, 1.5);
		this.canvas.width = this.dotCanvas.width = Math.round(this.w * this.dpr); this.canvas.height = this.dotCanvas.height = Math.round(this.h * this.dpr);
		if (this.dots) this.dots.resize(this.canvas.width, this.canvas.height);
		this.base = Math.min(this.w / Math.hypot(COS_ROLL, TILT * SIN_ROLL), this.h / Math.hypot(SIN_ROLL, TILT * COS_ROLL)) / ((this.moonAt ? 2.6 : 2.35) * R); // (a moon needs a little more room as it swings round)
		this.dirty = true;
		// the space background only needs painting again once the view has stopped changing size
		window.clearTimeout(this.skyTimer);
		if (this.skyW) this.skyTimer = window.setTimeout(() => this.paintSky(), 150); else this.paintSky();
	}

	renderLegend(arms, hasMoon) {
		const s = this.plugin.settings;
		this.legend.empty();
		this.legend.toggleClass('is-hidden', !s.showLegend);
		const row = (color, text) => {
			const r = this.legend.createDiv({ cls: 'spiral-galaxy-row' });
			r.createSpan({ cls: 'spiral-galaxy-dot' }).setCssProps({ '--spiral-galaxy-dot': color });
			r.createSpan({ text });
		};
		row(s.coreColor, s.coreName === 'Core' ? 'Core' : 'Core: ' + s.coreName);
		arms.forEach(a => row(a.color, a.name));
		if (hasMoon) row(s.moonColor, s.moonName === 'Moon' ? 'Moon' : 'Moon: ' + s.moonName);
	}

	// a soft glow per colour (for the backdrop), and a star stamp per colour: glow with a solid middle baked in
	glow(color) {
		if (this.glows[color]) return this.glows[color];
		const c = document.createElement('canvas'); c.width = c.height = 64;
		const g = c.getContext('2d'), grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
		grad.addColorStop(0, rgba(color, 1)); grad.addColorStop(0.25, rgba(color, 0.45)); grad.addColorStop(1, rgba(color, 0));
		g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
		return (this.glows[color] = c);
	}
	starSprite(color) {
		if (this.starSprites[color]) return this.starSprites[color];
		const c = document.createElement('canvas'); c.width = c.height = 48;
		const g = c.getContext('2d'), grad = g.createRadialGradient(24, 24, 0, 24, 24, 24);
		// like a real star: white-hot in the middle, its colour only showing in the soft glow round it
		grad.addColorStop(0, mixHex(color, '#ffffff', 0.92)); grad.addColorStop(0.14, mixHex(color, '#ffffff', 0.62)); grad.addColorStop(0.22, rgba(color, 0.6));
		grad.addColorStop(0.34, rgba(color, 0.07)); grad.addColorStop(1, rgba(color, 0));
		g.fillStyle = grad; g.fillRect(0, 0, 48, 48);
		return (this.starSprites[color] = c);
	}

	skySprite(color) {
		const key = 'sky' + color;
		if (this.starSprites[key]) return this.starSprites[key];
		const c = document.createElement('canvas'); c.width = c.height = 48;
		const g = c.getContext('2d'), grad = g.createRadialGradient(24, 24, 0, 24, 24, 24);
		grad.addColorStop(0, mixHex(color, '#ffffff', 0.92)); grad.addColorStop(0.12, mixHex(color, '#ffffff', 0.66)); grad.addColorStop(0.23, rgba(color, 0.52));
		grad.addColorStop(0.45, rgba(color, 0.1)); grad.addColorStop(1, rgba(color, 0));
		g.fillStyle = grad; g.fillRect(0, 0, 48, 48);
		return (this.starSprites[key] = c);
	}
	homeSprite() {
		if (this.homeStamp) return this.homeStamp;
		const c = document.createElement('canvas'); c.width = c.height = 96;
		const g = c.getContext('2d'), grad = g.createRadialGradient(48, 48, 0, 48, 48, 48);
		grad.addColorStop(0, '#ffffff'); grad.addColorStop(0.2, '#ffffff'); grad.addColorStop(0.3, 'rgba(255,240,205,0.9)');
		grad.addColorStop(0.46, 'rgba(255,205,125,0.34)'); grad.addColorStop(0.72, 'rgba(255,170,85,0.09)'); grad.addColorStop(1, 'rgba(255,150,70,0)');
		g.fillStyle = grad; g.fillRect(0, 0, 96, 96);
		return (this.homeStamp = c);
	}

	armPoint(k, t) {
		const th = (k * 2 * Math.PI) / this.armCount + WIND * t, r = R * (0.1 + 0.9 * t);
		return [Math.cos(th) * r, Math.sin(th) * r];
	}

	build() {
		const s = this.plugin.settings;
		let arms = s.arms, coreFolders = s.coreFolders;
		if (!arms.length) ({ arms, coreFolders } = this.plugin.autoArms());
		arms = arms.length ? arms : [{ name: 'Notes', color: PALETTE[0], folders: [] }];
		this.armCount = arms.length;
		coreFolders = coreFolders.map(cleanFolder);
		const moonFolders = s.moonFolders.map(cleanFolder).filter(Boolean);

		const files = this.app.vault.getMarkdownFiles(), links = this.app.metadataCache.resolvedLinks;
		const rules = [];
		arms.forEach((a, i) => a.folders.forEach(f => { const folder = cleanFolder(f); if (folder) rules.push({ folder, arm: i }); }));
		rules.sort((a, b) => b.folder.length - a.folder.length); // the deepest matching folder wins
		const clusters = arms.map(() => new Map()), core = [], moon = [], stray = [];
		for (const f of files) {
			const p = f.path;
			if (moonFolders.some(m => inFolder(p, m))) { moon.push(f); continue; }
			const rule = rules.find(r => inFolder(p, r.folder));
			if (rule) { const m = clusters[rule.arm]; if (!m.has(rule.folder)) m.set(rule.folder, []); m.get(rule.folder).push(f); continue; }
			if (coreFolders.includes(parentPath(f))) core.push(f); else stray.push(f);
		}
		// links both ways, for star sizes and the hover lines
		const adj = new Map(), add = (a, b) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b); };
		for (const src in links) for (const dst in links[src]) if (src !== dst && dst.endsWith('.md')) { add(src, dst); add(dst, src); }
		const degree = f => (adj.has(f.path) ? adj.get(f.path).size : 0);
		// the note at the very centre: the one you picked, else Home.md, else the most-linked core note
		let home = files.find(f => f.path === cleanFolder(s.homeNote)) || core.find(f => f.path === 'Home.md') || null;
		if (!home && core.length) home = core.reduce((a, b) => (degree(b) > degree(a) ? b : a));

		const stars = [], byPath = new Map(), nebulae = [], labels = [], old = this.byPath;
		const star = (f, x, y, color) => {
			const deg = degree(f), isHome = f === home;
			const st = { file: f, x, y, color, deg, size: isHome ? 14 : Math.min(6, 1.05 + Math.pow(deg, 0.6) * 0.35) }; // (capped: home stays the biggest)
			// a little height above or below the disc: thin at the edge, puffed up round the middle
			st.fade = isHome ? 1 : NOTE_FADE_MIN + (1 - NOTE_FADE_MIN) * Math.pow(seeded(f.path + '#fade')(), NOTE_FADE_CURVE); // (seeded, so each note keeps its brightness)
			st.z = isHome ? 0 : gauss(seeded(f.path + '#z')) * R * (0.008 + 0.05 * Math.exp(-Math.pow(Math.hypot(x, y) / (R * 0.12), 2)));
			// jelly: stiff near the core, loose at the edge, each a little different; the home star is the handle
			const d = Math.min(1, Math.hypot(x, y) / R);
			st.k = isHome ? 0 : (K_EDGE + (K_CORE - K_EDGE) * (1 - d) * (1 - d)) * (0.85 + 0.3 * seeded(f.path + '#k')());
			const was = old.get(f.path);
			st.ox = was ? was.ox : 0; st.oy = was ? was.oy : 0; st.vx = was ? was.vx : 0; st.vy = was ? was.vy : 0;
			stars.push(st); byPath.set(f.path, st);
		};
		// arms: each folder gets a stretch of its arm, longer for bigger folders; its hub note sits in the middle
		arms.forEach((arm, k) => {
			// sorted by the folder's own name, then its path: the same section from two copies of a library (e.g. V1 and
			// V2) sits side by side instead of one copy taking the whole outer end of the arm
			const leaf = p => p.split('/').pop();
			const secs = [...clusters[k].entries()].sort((a, b) => leaf(a[0]).localeCompare(leaf(b[0])) || a[0].localeCompare(b[0]));
			const weights = secs.map(c => Math.sqrt(c[1].length) + 1), total = weights.reduce((a, b) => a + b, 0);
			let t = 0.06;
			secs.forEach(([folder, notes], i) => {
				const span = (0.94 * weights[i]) / total, tA = t, tB = t + span, mid = (tA + tB) / 2;
				t = tB;
				const [hx, hy] = this.armPoint(k, mid);
				nebulae.push({ x: hx, y: hy, r: armWidth(mid) * 2.6 + R * 0.02 * Math.sqrt(notes.length), color: arm.color });
				labels.push({ x: hx, y: hy, text: folder.split('/').pop().replace(/^\d+\s+/, ''), color: arm.color });
				const top = notes.filter(f => parentPath(f) === folder);
				const hub = top.find(f => HUB.test(f.basename)) || (top.length ? top.reduce((a, b) => (degree(b) > degree(a) ? b : a)) : null);
				for (const f of notes) {
					if (f === hub) { star(f, hx, hy, arm.color); continue; }
					const rnd = seeded(f.path);
					const tt = tA + (tB - tA) * (0.08 + 0.84 * rnd()), [ax, ay] = this.armPoint(k, tt), w = armWidth(tt);
					star(f, ax + gauss(rnd) * w, ay + gauss(rnd) * w, arm.color);
				}
			});
		});
		for (const f of core) {
			const rnd = seeded(f.path), isHome = f === home, root = parentPath(f) === '';
			star(f, isHome ? 0 : gauss(rnd) * R * 0.05, isHome ? 0 : gauss(rnd) * R * 0.05, isHome ? s.homeColor : root ? s.coreColor : s.coreAltColor);
		}
		const mx = R * 1.0, my = -R * 0.75;
		for (const f of moon) { const rnd = seeded(f.path); star(f, mx + gauss(rnd) * R * 0.05, my + gauss(rnd) * R * 0.05, s.moonColor); }
		if (moon.length) { nebulae.push({ x: mx, y: my, r: R * 0.16, color: s.moonColor }); labels.push({ x: mx, y: my - R * 0.12, text: s.moonName, color: s.moonColor }); }
		const hadMoon = !!this.moonAt;
		this.moonAt = moon.length ? [mx, my] : null;
		if (hadMoon !== !!this.moonAt && this.w) this.fit();
		for (const f of stray) { const rnd = seeded(f.path), a = rnd() * 2 * Math.PI, r = R * (1.05 + 0.15 * rnd()); star(f, Math.cos(a) * r, Math.sin(a) * r, s.coreAltColor); }

		this.stars = stars; this.byPath = byPath; this.adj = adj; this.labels = labels; this.home = home ? byPath.get(home.path) : null;
		this.hover = this.hover ? byPath.get(this.hover.file.path) || null : null;
		const key = [s.dust, arms.map(a => a.color).join(), nebulae.map(n => n.color + n.r.toFixed(1)).join()].join('|');
		if (key !== this.backdropKey) { this.backdropKey = key; this.painting = this.makeDots(nebulae, arms); } // (only when it changes)
		this.renderLegend(arms, moon.length > 0);
		this.dirty = true;
	}

	// the galaxy's shape, clouds and dust, made out of separate dots: big soft ones for the glow, dark ones for the dust, then
	// over a hundred thousand tiny stars. It works in short bursts (Obsidian stays smooth) and swaps the new dots in when done.
	async makeDots(nebulae, arms) {
		const token = (this.paintToken = (this.paintToken || 0) + 1), stale = () => this.closed || token !== this.paintToken;
		const breathe = () => new Promise(r => window.setTimeout(r));
		await breathe(); if (stale()) return; // (lets the note stars show before the heavy work starts)
		const tile = clouds();
		await breathe(); if (stale()) return;
		let last = performance.now();
		const busy = () => performance.now() - last > 12;
		const amount = DUST[this.plugin.settings.dust] ?? 1, lanes = Math.min(1.2, amount);
		const armCount = arms.length, tints = arms.map(a => rgb01(a.color)), rnd = seeded('dots'), reach = 1.42 * R;
		// the colour ramp as a quick look-up: 256 steps from the middle to 1.4 R
		const ramp = new Float32Array(257 * 3);
		for (let i = 0, j = 0; i <= 256; i++) {
			const d = (i / 256) * 1.4;
			while (j < RAMP.length - 2 && RAMP[j + 1][0] < d) j++;
			const a = RAMP[j], b = RAMP[j + 1], t = Math.min(1, (d - a[0]) / (b[0] - a[0]));
			for (let k = 0; k < 3; k++) ramp[i * 3 + k] = a[k + 1] + (b[k + 1] - a[k + 1]) * t;
		}
		// what the galaxy looks like at one spot: its broad haze, its clouds and arms, and how much dust is there
		let hazeR = 0, hazeG = 0, hazeB = 0, glowR = 0, glowG = 0, glowB = 0, dust = 0, dist = 0;
		const look = (wx, wy) => {
			const d = (dist = Math.hypot(wx, wy) / R);
			// bend the arms a little so they aren't perfect curves, but stay with the note stars
			const f1 = cloudAt(tile, wx * 0.11 + 131, wy * 0.11 + 77), f2 = cloudAt(tile, wx * 0.11 + 413, wy * 0.11 + 299);
			const qx = wx + (f1 - 0.5) * R * 0.13, qy = wy + (f2 - 0.5) * R * 0.13, rq = Math.hypot(qx, qy), t = (rq / R - 0.1) / 0.9;
			const turn = ((Math.atan2(qy, qx) - WIND * t) * armCount) / (2 * Math.PI), near = Math.round(turn), side = ((turn - near) * 2 * Math.PI * rq) / armCount;
			const w = armWidth(Math.min(1, Math.max(0, t))) * 2.1 + R * 0.012, a = Math.exp(-(side * side) / (w * w));
			const big = cloudAt(tile, wx * 0.3 + 57, wy * 0.3 + 201), fine = cloudAt(tile, wx * 0.92 + 11, wy * 0.92 + 343), hot = cloudAt(tile, wx * 0.55 + 271, wy * 0.55 + 19), cool = cloudAt(tile, wx * 0.42 + 97, wy * 0.42 + 451);
			const vein = 1 - Math.abs(2 * cloudAt(tile, wx * 0.7 + 171, wy * 0.7 + 391) - 1), rim = smooth(1.4, 0.92, d);
			const detail = Math.max(0.12, Math.min(2.4, 1 + (fine - 0.5) * 2.6 + (big - 0.5) * 1.6)), out = smooth(0.3, 0.8, d); // (out: 0 in the middle, 1 toward the edge)
			const cloud = smooth(0.36, 0.66, big * 0.55 + fine * 0.45), armLight = a * (0.16 + 0.9 * cloud) * smooth(1.32, 0.72, d) * (0.55 + 0.45 * Math.exp(-d / 0.55));
			const rough = detail + (detail * detail - detail) * out; // (the outer arms are more broken up)
			const disc = Math.exp(-d / 0.42) * rim * 0.42, j = Math.min(256, Math.max(0, Math.round(((d + (big - 0.5) * 0.2) / 1.4) * 256))) * 3, bulge = Math.exp(-Math.pow(d / 0.12, 1.35));
			// the broad haze: the disc's soft light, fading to a faint glow past the edge, with violet in the shadows between the arms
			const soft = disc * Math.max(0.2, 0.8 + (big - 0.5) * 1.6) + (1 - smooth(0.3, 1.35, d)) * 0.03, shade = (1 - a) * Math.exp(-Math.pow((d - 0.55) / 0.32, 2)) * 0.07 * detail;
			hazeR = ramp[j] * soft + shade * 0.5; hazeG = ramp[j + 1] * soft + shade * 0.26; hazeB = ramp[j + 2] * soft + shade * 0.86;
			// the clouds: the arms and the disc's mottling, in the same colours
			const lit = disc * Math.max(0, (fine - 0.5) * 2.6) + armLight * 0.86 * (0.5 + 0.5 * rough);
			let er = ramp[j] * lit + bulge * 0.27, eg = ramp[j + 1] * lit + bulge * 0.16, eb = ramp[j + 2] * lit + bulge * 0.05;
			// glowing gas: orange near the middle with white-gold hearts, pink further out; young blue stars toward the ends of the arms
			const gas = a * smooth(0.5, 0.74, hot) * smooth(1.2, 0.28, d) * (0.82 - 0.3 * out) * (0.7 + 0.5 * vein), heart = a * smooth(0.64, 0.82, hot) * smooth(0.85, 0.15, d) * 0.5;
			er += gas + heart; eg += gas * (0.44 - 0.12 * out) + heart * 0.84; eb += gas * (0.07 + 0.43 * out) + heart * 0.55;
			const blue = a * smooth(0.48, 0.72, cool) * out * smooth(1.34, 0.95, d) * 0.4 * rough;
			er += blue * 0.5; eg += blue * 0.68; eb += blue;
			// a touch of the arm's own colour, so you can still tell the arms apart
			const tint = tints[((near % armCount) + armCount) % armCount], lum = (er + eg + eb) / 3, mix = 0.2 * a * smooth(0.12, 0.4, d);
			glowR = er + (tint[0] * lum * 1.3 - er) * mix; glowG = eg + (tint[1] * lum * 1.3 - eg) * mix; glowB = eb + (tint[2] * lum * 1.3 - eb) * mix;
			// dark dust: torn lanes along the inside edge of each arm, big dark patches and thin veins across the bright middle.
			// It's thinner right at the centre so the core stays bright
			const inner = side + w * 0.82, lane = Math.exp(-(inner * inner) / (w * w * 0.5)) * smooth(0.28, 0.6, cloudAt(tile, wx * 0.5 + 333, wy * 0.5 + 111)) * (0.45 + 0.55 * detail);
			const patch = smooth(0.52, 0.68, cloudAt(tile, wx * 0.2 + 21, wy * 0.2 + 257)) * Math.exp(-Math.pow(d / 0.62, 2)) * smooth(0.02, 0.12, d) * 0.75;
			const veins = smooth(0.82, 0.98, vein) * Math.exp(-Math.pow(d / 0.75, 2)) * smooth(0.02, 0.1, d) * 0.45;
			dust = Math.min(0.92, (lane * 0.8 * smooth(1.15, 0.7, d) + patch + veins) * lanes) * (1 - 0.55 * Math.exp(-Math.pow(d / 0.1, 2))) * smooth(1.3, 0.7, d);
		};
		// each dot gets its own jelly spring: stiff near the core, floppy at the edge, and different from its neighbours
		const groupOf = d => {
			const t = 1 - Math.min(1, d), k = (K_EDGE + (K_CORE - K_EDGE) * t * t) * (1 - JELLY_VARY + 2 * JELLY_VARY * rnd());
			return Math.max(0, Math.min(GROUPS - 1, Math.round((Math.log(k / K_LOW) / Math.log(K_HIGH / K_LOW)) * (GROUPS - 1))));
		};
		const layer = (cap, kind, pow, wander) => ({ data: new Float32Array(cap * STRIDE), count: 0, kind, pow, wander });
		const put = (l, x, y, z, r, g, b, a, size, px, d) => {
			const o = l.count++ * STRIDE, D = l.data;
			D[o] = x; D[o + 1] = y; D[o + 2] = z; D[o + 3] = r; D[o + 4] = g; D[o + 5] = b; D[o + 6] = a; D[o + 7] = size; D[o + 8] = px; D[o + 9] = groupOf(d); D[o + 10] = rnd() * 6.2832;
		};
		const across = gap => Math.ceil((2 * reach) / gap), vary = () => 1 - DOT_VARY / 2 + DOT_VARY * rnd();
		// how bright a dot must be so that, overlapping its neighbours, the light adds up to the right amount
		const gainOf = (gap, size) => (4 * gap * gap) / (Math.PI * size * size);

		// the broad haze
		const hazeN = across(HAZE_GAP), hazeSize = HAZE_GAP * 1.6, hazeGain = gainOf(HAZE_GAP, hazeSize), haze = layer(hazeN * hazeN, 'add', 3, WANDER_HAZE);
		for (let gy = 0; gy < hazeN; gy++) for (let gx = 0; gx < hazeN; gx++) {
			const x = -reach + (gx + rnd()) * HAZE_GAP, y = -reach + (gy + rnd()) * HAZE_GAP;
			if (Math.hypot(x, y) > reach) continue;
			look(x, y);
			if (Math.max(hazeR, hazeG, hazeB) < 0.002) continue;
			const k = hazeGain * vary();
			put(haze, x, y, 0, hazeR * k, hazeG * k, hazeB * k, 0, hazeSize, 0, dist);
		}
		// the round glow at the very middle: dots in a ball, so the centre swells up out of the flat disc
		const core = layer(CORE_BLOBS, 'add', 3, WANDER_CLOUD), coreSpread = R * 0.075;
		for (let i = 0; i < CORE_BLOBS; i++) {
			const x = gauss(rnd) * coreSpread, y = gauss(rnd) * coreSpread, z = gauss(rnd) * coreSpread, k = 0.75 + 0.5 * rnd();
			put(core, x, y, z, 0.0098 * k, 0.0058 * k, 0.0019 * k, 0, R * 0.032, 0, Math.hypot(x, y) / R);
		}
		// the clouds and arms, plus each folder's own soft patch of light
		const cloudN = across(CLOUD_GAP), cloudSize = CLOUD_GAP * 1.75, cloudGain = gainOf(CLOUD_GAP, cloudSize), glow = layer(cloudN * cloudN + nebulae.length * 10, 'add', 3, WANDER_CLOUD);
		for (let gy = 0; gy < cloudN; gy++) {
			if (busy()) { await breathe(); if (stale()) return; last = performance.now(); }
			for (let gx = 0; gx < cloudN; gx++) {
				const x = -reach + (gx + rnd()) * CLOUD_GAP, y = -reach + (gy + rnd()) * CLOUD_GAP;
				if (Math.hypot(x, y) > reach) continue;
				look(x, y);
				if (Math.max(glowR, glowG, glowB) < 0.012) continue;
				const k = cloudGain * vary();
				put(glow, x, y, 0, glowR * k, glowG * k, glowB * k, 0, cloudSize * (0.75 + 0.5 * rnd()), 0, dist);
			}
		}
		for (const n of nebulae) {
			const tint = rgb01(n.color);
			for (let i = 0; i < 10; i++) { const x = n.x + gauss(rnd) * n.r * 0.42, y = n.y + gauss(rnd) * n.r * 0.42; put(glow, x, y, 0, tint[0] * 0.014, tint[1] * 0.014, tint[2] * 0.014, 0, n.r * 0.6, 0, Math.hypot(x, y) / R); }
		}
		// the dust: dark dots that cover what's behind them, brown where there's light to catch
		const dustN = across(DUST_GAP), dustSize = DUST_GAP * 1.9, dustGain = gainOf(DUST_GAP, dustSize), dustDots = layer(dustN * dustN, 'over', 3, WANDER_DUST), dustMap = new Float32Array(dustN * dustN);
		if (lanes > 0) for (let gy = 0; gy < dustN; gy++) {
			if (busy()) { await breathe(); if (stale()) return; last = performance.now(); }
			for (let gx = 0; gx < dustN; gx++) {
				const x = -reach + (gx + rnd()) * DUST_GAP, y = -reach + (gy + rnd()) * DUST_GAP;
				if (Math.hypot(x, y) > reach) continue;
				look(x, y);
				dustMap[gy * dustN + gx] = dust;
				if (dust < 0.03) continue;
				const a = Math.min(0.9, -Math.log(1 - dust) * dustGain * (0.75 + 0.5 * rnd()));
				put(dustDots, x, y, 0, a * (glowR * 0.16 + 0.012), a * (glowG * 0.08 + 0.007), a * (glowB * 0.03 + 0.004), a, dustSize, 0, dist);
			}
		}
		// the tiny stars: thickest in the arms and the middle, hidden where the dust is thick
		const WARM = ['#ffe2b4', '#ffd094', '#fff4e0', '#ffc47e'].map(rgb01), MID = ['#ffffff', '#f4efe6', '#e6ecff', '#ffe9d4'].map(rgb01), COOL = ['#ffffff', '#cfdcff', '#b4c8ff', '#e6ecff'].map(rgb01);
		const armStars = Math.round(ARM_STARS * amount), discStars = Math.round(DISC_STARS * amount), coreStars = Math.round(CORE_STARS * amount), moonStars = this.moonAt ? Math.round(MOON_STARS * amount) : 0;
		const total = armStars + discStars + coreStars + moonStars, stars = layer(total, 'add', 1.5, WANDER_STAR);
		const speck = (x, y, a, r, set) => {
			const d = Math.hypot(x, y) / R, c = (set || (d < 0.32 ? WARM : d < 0.68 ? MID : COOL))[Math.floor(rnd() * 4)];
			if (!set) {
				const i = Math.floor((y + reach) / DUST_GAP) * dustN + Math.floor((x + reach) / DUST_GAP);
				if (i < 0 || i >= dustMap.length || rnd() < dustMap[i] * 1.05) return;
			}
			const z = gauss(rnd) * R * (0.008 + 0.05 * Math.exp(-Math.pow(d / 0.12, 2)));
			put(stars, x, y, z, c[0] * a, c[1] * a, c[2] * a, 0, 0, r, d);
		};
		for (let i = 0; i < total; i++) {
			if (i % 1500 === 0 && busy()) { await breathe(); if (stale()) return; last = performance.now(); }
			const b = rnd(), a = 0.04 + b * b * b * b * 0.42, r = 0.8 + b * b * 0.55; // (most are faint, a few brighter, but none as bright as a note)
			if (i < armStars) {
				const f = Math.floor(rnd() * armCount), t = Math.pow(rnd(), 0.75), [ax, ay] = this.armPoint(f, t), w = armWidth(t) * 2.2 + R * 0.01;
				speck(ax + gauss(rnd) * w, ay + gauss(rnd) * w, a, r);
			} else if (i < armStars + discStars) {
				const ang = rnd() * 2 * Math.PI, dr = -Math.log(1 - rnd() * 0.97) * R * 0.36;
				speck(Math.cos(ang) * dr, Math.sin(ang) * dr, a * smooth(1.4, 0.85, dr / R), r);
			} else if (i < armStars + discStars + coreStars) {
				speck(gauss(rnd) * R * 0.1, gauss(rnd) * R * 0.1, a, r);
			} else {
				speck(this.moonAt[0] + gauss(rnd) * R * 0.05, this.moonAt[1] + gauss(rnd) * R * 0.05, a, r, COOL);
			}
		}
		await breathe(); if (stale()) return;
		if (!this.layers) this.fade = 0; // the first time, it fades in over the note stars
		this.layers = [haze, core, glow, dustDots, stars];
		if (this.dots) this.dots.setLayers(this.layers);
		this.dirty = true;
	}
	// deep space behind everything: dark blue and violet haze, a faint band running on behind the galaxy, and a lot of stars
	paintSky() {
		const W = Math.max(1, Math.round(this.w * SKY_MARGIN * this.dpr)), H = Math.max(1, Math.round(this.h * SKY_MARGIN * this.dpr));
		if (W === this.skyW && H === this.skyH) return;
		this.skyW = W; this.skyH = H;
		const c = this.sky; c.width = W; c.height = H;
		const g = c.getContext('2d'), tile = clouds(), rnd = seeded('sky');
		const sw = Math.ceil(W / 4), sh = Math.ceil(H / 4), low = document.createElement('canvas'); low.width = sw; low.height = sh;
		const lg = low.getContext('2d'), img = lg.createImageData(sw, sh), px = img.data, aspect = W / H;
		const bandAt = (nx, ny) => { const across = -nx * SIN_ROLL + ny * COS_ROLL; return Math.exp(-(across * across) / 0.075); };
		for (let y = 0, n = 0; y < sh; y++) {
			for (let x = 0; x < sw; x++, n += 4) {
				const nx = (x / sw - 0.5) * aspect, ny = y / sh - 0.5, band = bandAt(nx, ny), edge = 1 - 0.55 * smooth(0.25, 1, Math.hypot(nx / aspect, ny) * 1.6);
				const u = nx * 700, v = ny * 700, a = smooth(0.34, 0.8, cloudAt(tile, u * 0.5 + 311, v * 0.5 + 71)), b = smooth(0.42, 0.82, cloudAt(tile, u * 0.36 + 37, v * 0.36 + 417)), dark = smooth(0.5, 0.76, cloudAt(tile, u * 0.7 + 201, v * 0.7 + 223));
				const blue = (0.3 + 0.7 * band) * a, violet = (0.32 + 0.5 * band) * b, f = rnd() - 0.5, keep = 1 - dark * 0.45 * band;
				px[n] = (3 + (blue * 11 + violet * 26 + band * 5) * edge * keep) + f;
				px[n + 1] = (5 + (blue * 26 + violet * 9 + band * 9) * edge * keep) + f;
				px[n + 2] = (15 + (blue * 66 + violet * 46 + band * 22) * edge * keep) + f;
				px[n + 3] = 255;
			}
		}
		lg.putImageData(img, 0, 0);
		g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(low, 0, 0, W, H);
		// tiny stars, with more of them along the band
		const COLORS = ['#ffffff', '#ffffff', '#ffffff', '#dbe6ff', '#c2d4ff', '#a9c0ff', '#ffe6cc', '#ffd2a6'];
		const count = Math.round((W * H) / (70 * this.dpr * this.dpr));
		g.globalCompositeOperation = 'lighter';
		for (let i = 0; i < count; i++) {
			const x = rnd() * W, y = rnd() * H, band = bandAt((x / W - 0.5) * aspect, y / H - 0.5), b = rnd();
			if (rnd() > 0.38 + 0.62 * band) continue;
			g.globalAlpha = 0.1 + b * b * b * 0.85; g.fillStyle = COLORS[Math.floor(rnd() * COLORS.length)];
			const size = (0.7 + b * b * 1.1) * this.dpr; g.fillRect(x, y, size, size);
		}
		// a smaller number of bigger stars with a soft glow, then a few very bright blue-white ones
		const stamp = (x, y, r, color, a) => { g.globalAlpha = a; g.drawImage(this.skySprite(color), x - r, y - r, r * 2, r * 2); };
		const BIG = ['#a9c4ff', '#c8d8ff', '#ffffff', '#8fb2ff', '#ffd9b0'];
		for (let i = 0; i < Math.round((W * H) / (4200 * this.dpr * this.dpr)); i++) stamp(rnd() * W, rnd() * H, (2.4 + rnd() * rnd() * 5) * this.dpr, BIG[Math.floor(rnd() * BIG.length)], 0.55 + rnd() * 0.45);
		for (let i = 0; i < Math.max(6, Math.round((W * H) / (120000 * this.dpr * this.dpr))); i++) {
			const x = rnd() * W, y = rnd() * H, r = (6 + rnd() * 8) * this.dpr, color = rnd() < 0.82 ? '#8fb6ff' : '#ffb36b';
			stamp(x, y, r * 2.2, color, 0.24); stamp(x, y, r, color, 1);
		}
		g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
	}
	// from the galaxy to the screen: spin it, flatten it (its height z shows a little), then lean it
	toScreen(x, y, z = 0) {
		const s = this.base * this.zoom, ax = x * this.cs - y * this.sn, ay = (x * this.sn + y * this.cs) * TILT + z * LIFT;
		return [this.w / 2 + this.panX + (ax * COS_ROLL - ay * SIN_ROLL) * s, this.h / 2 + this.panY + (ax * SIN_ROLL + ay * COS_ROLL) * s];
	}
	pos(st) { const [x, y] = this.toScreen(st.x, st.y, st.z); return [x + st.ox, y + st.oy]; } // where a star is drawn (with its lag)
	starRadius(st) { return st.size * Math.sqrt(this.zoom) * Math.max(0.65, this.base * 1.22); }

	// one spring step for every star and the backdrop; returns whether anything is still moving
	step(dt) {
		let moving = false;
		const spring = (o, k) => {
			const c = 2 * BOUNCE * Math.sqrt(k);
			o.vx += (-k * o.ox - c * o.vx) * dt; o.vy += (-k * o.oy - c * o.vy) * dt;
			o.ox += o.vx * dt; o.oy += o.vy * dt;
			if (Math.abs(o.ox) + Math.abs(o.oy) + Math.abs(o.vx) * 0.05 + Math.abs(o.vy) * 0.05 > 0.05) moving = true;
			else o.ox = o.oy = o.vx = o.vy = 0;
		};
		for (const st of this.stars) if (st.k) spring(st, st.k);
		spring(this.bg, K_BACKDROP);
		for (const g of this.groups) spring(g, g.k);
		return moving || !!(this.drag && this.drag.home && this.drag.moved);
	}

	draw() {
		const c = this.ctx, W = this.w, H = this.h, s = this.base * this.zoom;
		this.cs = Math.cos(this.spin); this.sn = Math.sin(this.spin);
		c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
		c.clearRect(0, 0, W, H);
		const on = (x, y, m) => x > -m && y > -m && x < W + m && y < H + m;

		// the space background drifts a little when you drag (it's its own canvas, so only moved, never redrawn here)
		const mx = (W * (SKY_MARGIN - 1)) / 2, my = (H * (SKY_MARGIN - 1)) / 2, sx = Math.round(Math.max(-mx, Math.min(mx, this.panX * SKY_DRIFT))), sy = Math.round(Math.max(-my, Math.min(my, this.panY * SKY_DRIFT)));
		if (sx !== this.skyX || sy !== this.skyY) { this.skyX = sx; this.skyY = sy; this.sky.setCssProps({ '--spiral-galaxy-sky-x': sx + 'px', '--spiral-galaxy-sky-y': sy + 'px' }); }

		// the galaxy: one picture, turned, flattened, leaned and scaled, with the round glow of the middle on top
		// the galaxy's own dots, on the graphics card
		if (this.dots && this.layers) {
			this.groups.forEach((g, i) => { this.lag[i * 2] = g.ox; this.lag[i * 2 + 1] = g.oy; });
			this.dots.draw({ w: W, h: H, cx: W / 2 + this.panX, cy: H / 2 + this.panY, scale: s, cs: this.cs, sn: this.sn, lag: this.lag, time: this.time, fade: this.fade, zoom: this.zoom });
		} else if (this.layers) {
			// no WebGL2 on this computer: a much simpler galaxy, just some of the tiny stars and a warm glow in the middle
			const l = this.layers[4], [gx, gy] = this.toScreen(0, 0), gr = R * 0.34 * s;
			c.globalCompositeOperation = 'lighter'; c.globalAlpha = 0.5 * this.fade;
			c.drawImage(this.glow('#ffb868'), gx - gr, gy - gr, gr * 2, gr * 2);
			c.fillStyle = '#ffffff';
			for (let i = 0; i < l.count; i += 8) {
				const o = i * STRIDE, [x, y] = this.toScreen(l.data[o], l.data[o + 1], l.data[o + 2]);
				if (on(x, y, 2)) { c.globalAlpha = Math.min(1, l.data[o + 3]) * this.fade; c.fillRect(x, y, 1.2, 1.2); }
			}
			c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
		}
		// the hovered star's links
		const hov = this.hover, near = hov && this.adj.get(hov.file.path);
		if (near) {
			const [hx, hy] = this.pos(hov);
			c.lineWidth = 1; c.strokeStyle = rgba(hov.color, 1); c.globalAlpha = 0.35;
			c.beginPath();
			for (const p of near) { const o = this.byPath.get(p); if (!o) continue; const [x, y] = this.pos(o); c.moveTo(hx, hy); c.lineTo(x, y); }
			c.stroke();
		}
		// stars: one stamp each (glow + middle), dimmed when another star is hovered and they aren't linked
		for (const st of this.stars) {
			const [x, y] = this.pos(st), g = this.starRadius(st) * 3;
			if (!on(x, y, g)) continue;
			// a faded note lights up fully when it, or a note linked to it, is hovered
			c.globalAlpha = !hov ? st.fade : st === hov || (near && near.has(st.file.path)) ? 1 : 0.25 * st.fade;
			c.drawImage(st === this.home ? this.homeSprite() : this.starSprite(st.color), x - g, y - g, g * 2, g * 2);
		}
		// names: the home note always, the folders once zoomed in a bit, the hovered star on top
		c.globalAlpha = 1; c.textAlign = 'center'; c.textBaseline = 'bottom';
		if (this.home) {
			c.font = `700 15px ${this.font}`;
			const [x, y] = this.pos(this.home);
			this.text(this.home.file.basename, x, y - this.starRadius(this.home) - 6, this.plugin.settings.homeColor, 1);
		}
		if (this.zoom >= 1.5) {
			c.font = `600 11px ${this.font}`;
			const a = Math.min(0.85, (this.zoom - 1.5) * 1.5);
			for (const l of this.labels) { const [lx, ly] = this.toScreen(l.x, l.y), x = lx + this.bg.ox, y = ly + this.bg.oy; if (on(x, y, 100)) this.text(l.text, x, y - 10, l.color, a); }
		}
		if (hov) {
			const [x, y] = this.pos(hov);
			c.font = `700 13px ${this.font}`;
			this.text(`${hov.file.basename}  ·  ${hov.deg} links`, x, y - this.starRadius(hov) - 8, '#ffffff', 1);
		}
	}
	text(t, x, y, color, a) {
		const c = this.ctx;
		c.globalAlpha = a; c.lineWidth = 3; c.strokeStyle = 'rgba(3,6,18,0.85)'; c.strokeText(t, x, y);
		c.fillStyle = color; c.fillText(t, x, y); c.globalAlpha = 1;
	}
	setCursor(kind) {
		this.canvas.removeClass('is-pointer', 'is-grab', 'is-grabbing');
		this.canvas.addClass('is-' + kind);
	}

	onWheel(e) {
		e.preventDefault();
		const rect = this.canvas.getBoundingClientRect(), mx = e.clientX - rect.left - this.w / 2, my = e.clientY - rect.top - this.h / 2;
		const z = Math.min(14, Math.max(0.4, this.zoom * Math.exp(-e.deltaY * 0.0015))), f = z / this.zoom;
		this.panX = mx - (mx - this.panX) * f; this.panY = my - (my - this.panY) * f; this.zoom = z;
		this.dirty = true;
	}
	onMove(e) {
		const rect = this.canvas.getBoundingClientRect(), mx = e.clientX - rect.left, my = e.clientY - rect.top;
		if (this.drag) {
			const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
			if (Math.abs(dx) + Math.abs(dy) > 4) this.drag.moved = true;
			if (this.drag.moved && this.drag.home) {
				// the home star is the handle: the galaxy moves with it, but every other star (and the backdrop) is left
				// behind by the same amount and springs after it
				const sx = e.clientX - this.drag.lx, sy = e.clientY - this.drag.ly;
				this.drag.lx = e.clientX; this.drag.ly = e.clientY;
				this.panX += sx; this.panY += sy;
				for (const st of this.stars) if (st.k) { st.ox -= sx; st.oy -= sy; }
				this.bg.ox -= sx; this.bg.oy -= sy;
				for (const g of this.groups) { g.ox -= sx; g.oy -= sy; }
				this.hover = null; this.wobbling = true; this.dirty = true;
				this.setCursor('grabbing');
				return;
			}
			if (this.drag.moved) { this.panX = this.drag.px + dx; this.panY = this.drag.py + dy; this.hover = null; this.dirty = true; this.setCursor('grabbing'); return; }
		}
		let best = null, bd = Infinity;
		if (this.home) { // the bright middle is the handle: anywhere in its glow picks the home star
			const [x, y] = this.pos(this.home);
			if (Math.hypot(x - mx, y - my) < Math.max(24, this.starRadius(this.home) * 3)) best = this.home;
		}
		if (!best) for (const st of this.stars) {
			const [x, y] = this.pos(st), d = Math.hypot(x - mx, y - my), reach = Math.max(7, this.starRadius(st) + 3);
			if (d < reach && d < bd) { bd = d; best = st; }
		}
		if (best !== this.hover) { this.hover = best; this.dirty = true; }
		this.setCursor(best ? (best === this.home && this.plugin.settings.jelly ? 'grab' : 'pointer') : 'grab');
	}
	onUp(e) {
		const d = this.drag; this.drag = null;
		if (d && !d.moved && this.hover && e.target === this.canvas) this.app.workspace.getLeaf('tab').openFile(this.hover.file);
	}
}

class GalaxySettingTab extends PluginSettingTab {
	constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

	display() {
		const { containerEl } = this, s = this.plugin.settings;
		containerEl.empty();
		const save = debounce(() => this.plugin.saveSettings(), 400, true);
		const saveNow = async () => { await this.plugin.saveSettings(); this.display(); };

		new Setting(containerEl).setName('Arms').setHeading();
		new Setting(containerEl)
			.setDesc(s.arms.length
				? 'Each arm is a list of folders. Every folder becomes a glowing star cluster on that arm.'
				: 'Arms are picked automatically from your folders. Fill them in to choose the names, colours and folders yourself.')
			.addButton(b => b.setButtonText(s.arms.length ? 'Go back to automatic' : 'Fill in from my folders').onClick(async () => {
				if (s.arms.length) s.arms = [];
				else { const auto = this.plugin.autoArms(); s.arms = auto.arms; s.coreFolders = auto.coreFolders; }
				await saveNow();
			}));
		s.arms.forEach((arm, i) => {
			new Setting(containerEl).setName(`Arm ${i + 1}`)
				.addText(t => t.setPlaceholder('Name').setValue(arm.name).onChange(v => { arm.name = v; save(); }))
				.addColorPicker(c => c.setValue(arm.color).onChange(v => { arm.color = v; save(); }))
				.addExtraButton(b => b.setIcon('arrow-up').setTooltip('Move up').setDisabled(i === 0).onClick(async () => {
					if (i > 0) { [s.arms[i - 1], s.arms[i]] = [s.arms[i], s.arms[i - 1]]; await saveNow(); }
				}))
				.addExtraButton(b => b.setIcon('trash').setTooltip('Remove arm').onClick(async () => { s.arms.splice(i, 1); await saveNow(); }));
			new Setting(containerEl).setDesc('Folders on this arm, one per line')
				.addTextArea(t => {
					t.setValue(arm.folders.join('\n')).onChange(v => { arm.folders = lines(v); save(); });
					t.inputEl.rows = Math.min(10, Math.max(2, arm.folders.length));
					t.inputEl.addClass('spiral-galaxy-folders');
				});
		});
		if (s.arms.length) new Setting(containerEl).addButton(b => b.setButtonText('Add arm').onClick(async () => {
			s.arms.push({ name: 'New arm', color: PALETTE[s.arms.length % PALETTE.length], folders: [] });
			await saveNow();
		}));

		new Setting(containerEl).setName('Core').setHeading();
		new Setting(containerEl).setName('Core folders')
			.setDesc('Notes sitting directly inside these folders form the bright core. One per line; "/" is the vault root.')
			.addTextArea(t => t.setValue(s.coreFolders.map(f => f || '/').join('\n')).onChange(v => { s.coreFolders = lines(v).map(f => (f === '/' ? '' : cleanFolder(f))); save(); }));
		new Setting(containerEl).setName('Core name').setDesc('Shown in the legend.')
			.addText(t => t.setValue(s.coreName).onChange(v => { s.coreName = v || 'Core'; save(); }));
		new Setting(containerEl).setName('Core colours').setDesc('Notes in the vault root, then notes in the other core folders.')
			.addColorPicker(c => c.setValue(s.coreColor).onChange(v => { s.coreColor = v; save(); }))
			.addColorPicker(c => c.setValue(s.coreAltColor).onChange(v => { s.coreAltColor = v; save(); }));
		new Setting(containerEl).setName('Centre note')
			.setDesc('The note at the very centre, which you drag to swing the galaxy, e.g. "Home.md". Leave empty to pick it automatically.')
			.addText(t => t.setPlaceholder('Home.md').setValue(s.homeNote).onChange(v => { s.homeNote = v.trim(); save(); }))
			.addColorPicker(c => c.setValue(s.homeColor).onChange(v => { s.homeColor = v; save(); }));

		new Setting(containerEl).setName('Moon').setHeading();
		new Setting(containerEl).setName('Moon folders')
			.setDesc('These folders become a little satellite galaxy, e.g. references or archives. One per line.')
			.addTextArea(t => t.setValue(s.moonFolders.join('\n')).onChange(v => { s.moonFolders = lines(v).map(cleanFolder); save(); }));
		new Setting(containerEl).setName('Moon name and colour')
			.addText(t => t.setValue(s.moonName).onChange(v => { s.moonName = v || 'Moon'; save(); }))
			.addColorPicker(c => c.setValue(s.moonColor).onChange(v => { s.moonColor = v; save(); }));

		new Setting(containerEl).setName('Look and feel').setHeading();
		new Setting(containerEl).setName('Spin when opened')
			.addToggle(t => t.setValue(s.spinOnOpen).onChange(v => { s.spinOnOpen = v; save(); }));
		new Setting(containerEl).setName('Spin speed')
			.addSlider(sl => sl.setLimits(0.25, 4, 0.25).setValue(s.spinSpeed).setDynamicTooltip().onChange(v => { s.spinSpeed = v; save(); }));
		new Setting(containerEl).setName('Space dust')
			.addDropdown(d => d.addOptions({ none: 'None', light: 'Light', normal: 'Normal', rich: 'Rich' }).setValue(s.dust).onChange(v => { s.dust = v; save(); }));
		new Setting(containerEl).setName('Jelly drag').setDesc('Drag the bright middle and the arms trail behind and wobble into place.')
			.addToggle(t => t.setValue(s.jelly).onChange(v => { s.jelly = v; save(); }));
		new Setting(containerEl).setName('Show legend')
			.addToggle(t => t.setValue(s.showLegend).onChange(v => { s.showLegend = v; save(); }));
	}
}

module.exports = class SpiralGalaxyPlugin extends Plugin {
	async onload() {
		await this.loadSettings();
		this.registerView(VIEW_TYPE, leaf => new GalaxyView(leaf, this));
		this.addRibbonIcon('sparkles', 'Open galaxy', () => this.activateView());
		this.addCommand({ id: 'open', name: 'Open galaxy', callback: () => this.activateView() });
		this.addSettingTab(new GalaxySettingTab(this.app, this));
	}

	async loadSettings() { this.settings = Object.assign(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), await this.loadData()); }
	async saveSettings() {
		await this.saveData(this.settings);
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) if (leaf.view instanceof GalaxyView) leaf.view.build();
	}

	async activateView() {
		const ws = this.app.workspace, open = ws.getLeavesOfType(VIEW_TYPE);
		if (open.length) { ws.revealLeaf(open[0]); return; }
		const leaf = ws.getLeaf('tab');
		await leaf.setViewState({ type: VIEW_TYPE, active: true });
		ws.revealLeaf(leaf);
	}

	// Arms picked from your folders when you haven't chosen any: each top-level folder is a star cluster. If one folder
	// holds most of the vault, its subfolders are used instead (and its own loose notes join the core). Up to 9
	// clusters get an arm each; more are shared out over 8 arms. Big and small arms alternate round the circle.
	autoArms() {
		const moon = this.settings.moonFolders.map(cleanFolder).filter(Boolean);
		const counts = new Map();
		for (const f of this.app.vault.getMarkdownFiles()) {
			for (let p = f.parent; p && p.path !== '/'; p = p.parent) counts.set(p.path, (counts.get(p.path) || 0) + 1);
		}
		const count = folder => counts.get(folder.path) || 0;
		const kids = folder => folder.children.filter(c => c instanceof TFolder && !c.name.startsWith('.') && !moon.some(m => inFolder(c.path + '/', m) || c.path === m) && count(c) > 0);
		let clusters = kids(this.app.vault.getRoot());
		const coreFolders = [''];
		for (let guard = 0; guard < 4; guard++) {
			const total = clusters.reduce((a, c) => a + count(c), 0) || 1;
			const big = clusters.find(c => count(c) / total >= 0.6 && kids(c).length >= 3);
			if (!big) break;
			clusters = clusters.filter(c => c !== big).concat(kids(big));
			coreFolders.push(big.path);
		}
		clusters.sort((a, b) => a.path.localeCompare(b.path));
		const groups = clusters.length <= 9
			? clusters.map(c => [c])
			: Array.from({ length: 8 }, (_, i) => clusters.slice(Math.floor((i * clusters.length) / 8), Math.floor(((i + 1) * clusters.length) / 8)));
		const nice = n => n.replace(/^\d+[\s._-]*/, '') || n;
		const arms = groups.filter(g => g.length).map(g => ({
			name: g.length === 1 ? nice(g[0].name) : `${nice(g[0].name)} +${g.length - 1}`,
			folders: g.map(c => c.path),
			size: g.reduce((a, c) => a + count(c), 0),
		}));
		arms.sort((a, b) => b.size - a.size);
		const order = [];
		while (arms.length) { order.push(arms.shift()); if (arms.length) order.push(arms.pop()); }
		return { arms: order.map((a, i) => ({ name: a.name, color: PALETTE[i % PALETTE.length], folders: a.folders })), coreFolders };
	}
};
