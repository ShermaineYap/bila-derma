// Donor poster: MediaPipe selfie segmentation runs in the browser; the photo never leaves the device.

const MP_VERSION = "1.2.3";
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODEL = new URL("../models/selfie_segmenter.tflite", import.meta.url).href;
export const POSTER_W = 1080;
export const POSTER_H = 1350;

let segmenterPromise = null;

/** Load MediaPipe Tasks Vision and the selfie segmenter once, on demand. */
export function loadSegmenter() {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const { FilesetResolver, ImageSegmenter } = await import(`${MP_BASE}/vision_bundle.mjs`);
      const fileset = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
      return ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL, delegate: "CPU" },
        runningMode: "IMAGE",
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
    })().catch((e) => { segmenterPromise = null; throw e; });
  }
  return segmenterPromise;
}

/** Read a File into an <img>, downscaled so the longer side is at most `max`, as a canvas. */
export async function fileToCanvas(file, max = 1024) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bitmap.width * scale);
  c.height = Math.round(bitmap.height * scale);
  c.getContext("2d").drawImage(bitmap, 0, 0, c.width, c.height);
  bitmap.close?.();
  return c;
}

/**
 * Cut the person out of `src` (a canvas). Returns { canvas, bbox, coverage } where canvas has
 * a transparent background, bbox is the person's bounding box, and coverage is the share of
 * pixels classed as person.
 */
export async function cutOut(src) {
  const seg = await loadSegmenter();
  const result = seg.segment(src);
  try {
    const mask = result.confidenceMasks[0];
    const conf = mask.getAsFloat32Array();
    const mw = mask.width, mh = mask.height;
    const out = document.createElement("canvas");
    out.width = src.width; out.height = src.height;
    const ctx = out.getContext("2d");
    ctx.drawImage(src, 0, 0);
    const img = ctx.getImageData(0, 0, out.width, out.height);
    let minX = out.width, minY = out.height, maxX = -1, maxY = -1, person = 0;
    for (let y = 0; y < out.height; y++) {
      const my = Math.min(mh - 1, Math.floor(y * mh / out.height));
      for (let x = 0; x < out.width; x++) {
        const mx = Math.min(mw - 1, Math.floor(x * mw / out.width));
        const v = conf[my * mw + mx];
        const a = smoothstep(0.45, 0.85, v);
        img.data[(y * out.width + x) * 4 + 3] = Math.round(a * 255);
        if (v > 0.5) {
          person++;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    const coverage = person / (out.width * out.height);
    const bbox = maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    return { canvas: out, bbox, coverage };
  } finally {
    result.close?.();
  }
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function wrap(ctx, text, maxWidth) {
  // Split on spaces; for CJK text without spaces, split per character.
  const tokens = /\s/.test(text) ? text.split(/(\s+)/) : [...text];
  const lines = [];
  let line = "";
  for (const tk of tokens) {
    const test = line + tk;
    if (ctx.measureText(test).width > maxWidth && line.trim()) { lines.push(line.trim()); line = tk.trimStart(); }
    else line = test;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

/**
 * Draw the poster. opts:
 *  head, week, why, cta, url, brand, bars: [{pct, pick}], cut (from cutOut) or null, fontDisplay, fontBody
 */
export function drawPoster(canvas, o) {
  canvas.width = POSTER_W; canvas.height = POSTER_H;
  const ctx = canvas.getContext("2d");
  const W = POSTER_W, H = POSTER_H, pad = 80;
  // Background
  ctx.fillStyle = "#8E1B2E";
  ctx.fillRect(0, 0, W, H);
  const g = ctx.createRadialGradient(W * 0.75, H * 0.62, 50, W * 0.75, H * 0.62, H * 0.75);
  g.addColorStop(0, "rgba(255,255,255,0.10)");
  g.addColorStop(1, "rgba(0,0,0,0.18)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const barsTop = H - 380, base = H - 250, n = o.bars.length || 1;
  // Person cut-out (or a drop when there is no photo), standing on the bars
  if (o.cut?.bbox) {
    const { canvas: c, bbox } = o.cut;
    const targetH = H * 0.58;
    const s = Math.min(targetH / bbox.h, (W * 0.56) / bbox.w);
    const dw = c.width * s, dh = c.height * s;
    const dx = W * 0.72 - (bbox.x + bbox.w / 2) * s;
    const bottom = Math.min(H - 40, base + 40);
    const dy = bottom - (bbox.y + bbox.h) * s;
    // Draw on a layer, then fade the lowest part so the photo's crop line melts into the background.
    const layer = document.createElement("canvas");
    layer.width = W; layer.height = H;
    const lc = layer.getContext("2d");
    lc.drawImage(c, dx, dy, dw, dh);
    lc.globalCompositeOperation = "destination-out";
    const fade = lc.createLinearGradient(0, bottom - 170, 0, bottom);
    fade.addColorStop(0, "rgba(0,0,0,0)");
    fade.addColorStop(1, "rgba(0,0,0,1)");
    lc.fillStyle = fade;
    lc.fillRect(0, bottom - 170, W, H - (bottom - 170));
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = 40;
    ctx.drawImage(layer, 0, 0);
    ctx.restore();
  } else {
    ctx.save();
    ctx.translate(W * 0.70, barsTop - 250);
    ctx.scale(7.5, 7.5);
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.beginPath();
    ctx.moveTo(16, 3);
    ctx.bezierCurveTo(16, 3, 6, 15, 6, 21);
    ctx.arc(16, 21, 10, Math.PI, 0, true);
    ctx.bezierCurveTo(26, 15, 16, 3, 16, 3);
    ctx.fill();
    ctx.restore();
  }

  // Tide bars along the bottom: the user's 16-week forecast
  const step = (W - pad * 2) / n, bw = step * 0.62;
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(pad, base); ctx.lineTo(W - pad, base); ctx.stroke();
  o.bars.forEach((b, i) => {
    const h = Math.max(6, Math.min(105, Math.abs(b.pct) * 4));
    const x = pad + i * step + (step - bw) / 2;
    const y = b.pct < 0 ? base : base - h;
    ctx.fillStyle = b.pick ? "#E9BE4C" : b.pct <= -5 ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.38)";
    roundRect(ctx, x, y, bw, h, 6);
    ctx.fill();
  });

  // Text
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#FFFFFF";
  ctx.font = `800 40px ${o.fontDisplay}`;
  ctx.fillText(o.brand, pad, pad + 20);
  let y = pad + 150;
  ctx.font = `800 104px ${o.fontDisplay}`;
  for (const line of wrap(ctx, o.head, W - pad * 2)) { ctx.fillText(line, pad, y); y += 104; }
  y += 6;
  ctx.fillStyle = "#F2CF6B";
  ctx.font = `700 60px ${o.fontDisplay}`;
  for (const line of wrap(ctx, o.week, W * 0.62)) { ctx.fillText(line, pad, y); y += 70; }
  y += 18;
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = `400 34px ${o.fontBody}`;
  for (const line of wrap(ctx, o.why, W * 0.42)) { ctx.fillText(line, pad, y); y += 46; }

  ctx.fillStyle = "#FFFFFF";
  ctx.font = `600 32px ${o.fontBody}`;
  ctx.fillText(o.cta, pad, H - 92);
  ctx.font = `700 34px ${o.fontBody}`;
  ctx.fillText(o.url, pad, H - 46);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
