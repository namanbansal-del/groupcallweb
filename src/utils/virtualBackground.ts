import { SelfieSegmentation, Results } from '@mediapipe/selfie_segmentation';
import techugoImgUrl from '../assets/techugoImg.jpg';

export type BackgroundMode = 'none' | 'blur-light' | 'blur-heavy' | 'image-techugo' | 'image-custom';

// ── Tuning knobs ────────────────────────────────────────────────────────
const MASK_W = 256;
const MASK_H = 144;
// Mask confidence below EDGE_LOW is 100% background, above EDGE_HIGH is 100% person.
// Raise both if the old room still leaks through; lower them if hair/shoulders get eaten.
const EDGE_LOW = 0.45;
const EDGE_HIGH = 0.72;
// Weight of the newest mask vs. the previous one (temporal smoothing, reduces flicker).
const NEW_MASK_WEIGHT = 0.6;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class VirtualBackgroundProcessor {
  private segmenter: SelfieSegmentation | null = null;
  private isModelLoaded = false;
  private videoEl: HTMLVideoElement | null = null;

  // Output canvas. No `willReadFrequently`: that forces CPU rendering and makes
  // filters + captureStream very slow.
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;

  private inputCanvas: HTMLCanvasElement;
  private inputCtx: CanvasRenderingContext2D | null;

  // rawMask: raw model output (read back with getImageData). maskCanvas: cleaned mask.
  private rawMaskCanvas: HTMLCanvasElement;
  private rawMaskCtx: CanvasRenderingContext2D | null;
  private maskCanvas: HTMLCanvasElement;
  private maskCtx: CanvasRenderingContext2D | null;
  private prevMask = new Float32Array(MASK_W * MASK_H);
  private hasValidMask = false;

  private blurCanvas: HTMLCanvasElement;
  private blurCtx: CanvasRenderingContext2D | null;

  private animId: number | null = null;
  private currentMode: BackgroundMode = 'none';
  private customImage: HTMLImageElement | null = null;
  private techugoImage: HTMLImageElement | null = null;
  private outputStream: MediaStream | null = null;
  private isProcessing = false;
  private isInferring = false;
  private lastInferTime = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1280;
    this.canvas.height = 720;
    this.ctx = this.canvas.getContext('2d');

    this.inputCanvas = document.createElement('canvas');
    this.inputCanvas.width = 480;
    this.inputCanvas.height = 270;
    this.inputCtx = this.inputCanvas.getContext('2d');

    this.rawMaskCanvas = document.createElement('canvas');
    this.rawMaskCanvas.width = MASK_W;
    this.rawMaskCanvas.height = MASK_H;
    this.rawMaskCtx = this.rawMaskCanvas.getContext('2d', { willReadFrequently: true });

    this.maskCanvas = document.createElement('canvas');
    this.maskCanvas.width = MASK_W;
    this.maskCanvas.height = MASK_H;
    this.maskCtx = this.maskCanvas.getContext('2d');

    this.blurCanvas = document.createElement('canvas');
    this.blurCanvas.width = 320;
    this.blurCanvas.height = 180;
    this.blurCtx = this.blurCanvas.getContext('2d');

    this.techugoImage = new Image();
    this.techugoImage.crossOrigin = 'anonymous';
    this.techugoImage.src = techugoImgUrl || '/assets/techugoImg.jpg';
  }

  private createSegmenter(locate: (file: string) => string): SelfieSegmentation {
    const s = new SelfieSegmentation({ locateFile: locate });
    s.setOptions({ modelSelection: 1, selfieMode: false });
    s.onResults((r: Results) => this.handleResults(r));
    return s;
  }

  private async initModel(): Promise<void> {
    if (this.segmenter && this.isModelLoaded) return;
    try {
      this.segmenter = this.createSegmenter((f) => `/mediapipe/selfie_segmentation/${f}`);
      await this.segmenter.initialize();
    } catch (err) {
      console.warn('[VirtualBackground] Local model failed, using CDN:', err);
      this.segmenter = this.createSegmenter(
        (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${f}`
      );
      await this.segmenter.initialize();
    }
    this.isModelLoaded = true;
  }

  /**
   * The model returns a SOFT mask (confidence 0..1). Using it directly lets the real
   * room bleed through wherever confidence is ~0.3-0.7 (the pale "halo" around the
   * body). We sharpen it with a smoothstep and blend with the previous mask.
   */
  private handleResults(results: Results): void {
    const src = results.segmentationMask as CanvasImageSource | undefined;
    if (src && this.rawMaskCtx && this.maskCtx) {
      this.rawMaskCtx.clearRect(0, 0, MASK_W, MASK_H);
      this.rawMaskCtx.drawImage(src, 0, 0, MASK_W, MASK_H);
      const img = this.rawMaskCtx.getImageData(0, 0, MASK_W, MASK_H);
      const d = img.data;
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        // Confidence is carried in alpha. If you ever get NO background replacement
        // at all, swap `d[i + 3]` for `d[i]` (red channel).
        const conf = d[i + 3] / 255;
        const t = this.hasValidMask
          ? NEW_MASK_WEIGHT * conf + (1 - NEW_MASK_WEIGHT) * this.prevMask[p]
          : conf;
        this.prevMask[p] = t;
        d[i + 3] = Math.round(smoothstep(EDGE_LOW, EDGE_HIGH, t) * 255);
      }
      this.maskCtx.putImageData(img, 0, 0);
      this.hasValidMask = true;
    }
    this.isInferring = false;
  }

  public async setCustomImage(imageUrl: string): Promise<void> {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        this.customImage = img;
        resolve();
      };
      img.onerror = () => {
        console.warn('[VirtualBackground] Failed to load custom image');
        resolve();
      };
      img.src = imageUrl;
    });
  }

  public isStarted(): boolean {
    return this.isProcessing && this.outputStream !== null;
  }

  public async setMode(mode: BackgroundMode, customImageUrl?: string): Promise<void> {
    this.currentMode = mode;
    if (customImageUrl) await this.setCustomImage(customImageUrl);
    if (mode !== 'none' && !this.isProcessing && this.videoEl) {
      this.isProcessing = true;
      this.processLoop();
    }
  }

  public async start(
    cameraStream: MediaStream,
    mode: BackgroundMode,
    customImageUrl?: string
  ): Promise<MediaStreamTrack | null> {
    this.currentMode = mode;
    this.hasValidMask = false;
    this.isInferring = false;
    this.prevMask.fill(0);

    if (customImageUrl) await this.setCustomImage(customImageUrl);

    if (mode === 'none') {
      this.stop();
      return cameraStream.getVideoTracks()[0] || null;
    }

    if (!this.videoEl) {
      this.videoEl = document.createElement('video');
      this.videoEl.autoplay = true;
      this.videoEl.playsInline = true;
      this.videoEl.muted = true;
    }
    this.videoEl.srcObject = cameraStream;
    await this.videoEl.play().catch(() => {});

    let width = this.videoEl.videoWidth || 1280;
    let height = this.videoEl.videoHeight || 720;
    if (width > 1280) {
      height = Math.round((height * 1280) / width);
      width = 1280;
    }
    this.canvas.width = width;
    this.canvas.height = height;
    // Keep the model input at the camera's real aspect ratio (no squashed faces).
    this.inputCanvas.height = Math.round((this.inputCanvas.width * height) / width);

    if (this.ctx && this.videoEl.readyState >= 2) {
      this.ctx.drawImage(this.videoEl, 0, 0, width, height);
    }

    if (!this.isProcessing) {
      this.isProcessing = true;
      this.processLoop();
    }
    if (!this.outputStream) {
      this.outputStream = this.canvas.captureStream(30);
    }

    try {
      await this.initModel();
    } catch (err) {
      console.warn('[VirtualBackground] Could not initialize segmentation:', err);
    }

    return this.outputStream.getVideoTracks()[0] || null;
  }

  public changeMode(mode: BackgroundMode, customImageUrl?: string): void {
    this.setMode(mode, customImageUrl);
  }

  /** Draw an image so it fills the frame without stretching (like CSS object-fit: cover). */
  private drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, w: number, h: number) {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    const s = Math.max(w / iw, h / ih);
    const dw = iw * s;
    const dh = ih * s;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }

  private processLoop = () => {
    if (!this.isProcessing || !this.videoEl) return;
    if (this.currentMode === 'none') return;

    const video = this.videoEl;
    const ctx = this.ctx;
    const { width, height } = this.canvas;

    if (video.readyState >= 2 && !video.paused && ctx) {
      if (!this.hasValidMask) {
        ctx.drawImage(video, 0, 0, width, height);
      } else {
        ctx.save();
        ctx.clearRect(0, 0, width, height);

        // 1) Live camera frame (zero latency)
        ctx.drawImage(video, 0, 0, width, height);

        // 2) Keep only the person: sharpened mask, 1px feather for natural edges
        ctx.globalCompositeOperation = 'destination-in';
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.filter = 'blur(1px)';
        ctx.drawImage(this.maskCanvas, 0, 0, width, height);
        ctx.filter = 'none';

        // 3) New background behind the person
        ctx.globalCompositeOperation = 'destination-over';

        if (this.currentMode === 'blur-light' || this.currentMode === 'blur-heavy') {
          if (this.blurCtx) {
            this.blurCtx.drawImage(video, 0, 0, this.blurCanvas.width, this.blurCanvas.height);
            ctx.filter = this.currentMode === 'blur-light' ? 'blur(8px)' : 'blur(20px)';
            // Oversize slightly so blur doesn't leave transparent borders
            ctx.drawImage(this.blurCanvas, -24, -24, width + 48, height + 48);
            ctx.filter = 'none';
          }
        } else if (this.currentMode === 'image-techugo' && this.techugoImage) {
          this.drawCover(ctx, this.techugoImage, width, height);
        } else if (this.currentMode === 'image-custom' && this.customImage) {
          this.drawCover(ctx, this.customImage, width, height);
        } else {
          ctx.fillStyle = '#202124';
          ctx.fillRect(0, 0, width, height);
        }
        ctx.restore();
      }

      // Dispatch next inference: one frame in flight, ~30 FPS max
      const now = performance.now();
      if (this.isInferring && now - this.lastInferTime > 400) this.isInferring = false;

      if (!this.isInferring && this.segmenter && this.isModelLoaded && now - this.lastInferTime >= 33) {
        this.isInferring = true;
        this.lastInferTime = now;
        if (this.inputCtx) {
          this.inputCtx.drawImage(video, 0, 0, this.inputCanvas.width, this.inputCanvas.height);
          this.segmenter.send({ image: this.inputCanvas }).catch(() => {
            this.isInferring = false;
          });
        }
      }
    }

    this.animId = requestAnimationFrame(this.processLoop);
  };

  public stop(): void {
    this.isProcessing = false;
    this.isInferring = false;
    this.hasValidMask = false;
    if (this.animId) {
      cancelAnimationFrame(this.animId);
      this.animId = null;
    }
    if (this.videoEl) {
      this.videoEl.pause();
      this.videoEl.srcObject = null;
    }
    this.currentMode = 'none';
  }

  public destroy(): void {
    this.stop();
    if (this.outputStream) {
      this.outputStream.getTracks().forEach((t) => t.stop());
      this.outputStream = null;
    }
    if (this.segmenter) {
      try {
        this.segmenter.close();
      } catch {}
      this.segmenter = null;
      this.isModelLoaded = false;
    }
  }
}