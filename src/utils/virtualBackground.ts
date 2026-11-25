import { SelfieSegmentation, Results } from '@mediapipe/selfie_segmentation';
import techugoImgUrl from '../assets/techugoImg.jpg';

export type BackgroundMode = 'none' | 'blur-light' | 'blur-heavy' | 'image-techugo' | 'image-custom';

export class VirtualBackgroundProcessor {
  private segmenter: SelfieSegmentation | null = null;
  private isModelLoaded = false;
  private videoEl: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private blurCanvas: HTMLCanvasElement;
  private blurCtx: CanvasRenderingContext2D | null;
  private animId: number | null = null;
  private currentMode: BackgroundMode = 'none';
  private customImage: HTMLImageElement | null = null;
  private techugoImage: HTMLImageElement | null = null;
  private outputStream: MediaStream | null = null;
  private isProcessing = false;
  private isBusy = false;
  private lastProcessTime = 0;
  private hasReceivedFirstResult = false;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1280;
    this.canvas.height = 720;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

    // Dedicated offscreen canvas for instantaneous 60fps GPU-assisted blur
    this.blurCanvas = document.createElement('canvas');
    this.blurCanvas.width = 160;
    this.blurCanvas.height = 90;
    this.blurCtx = this.blurCanvas.getContext('2d');

    // Preload default Techugo background image
    this.techugoImage = new Image();
    this.techugoImage.crossOrigin = 'anonymous';
    this.techugoImage.src = techugoImgUrl || '/assets/techugoImg.jpg';
  }

  private async initModel(): Promise<void> {
    if (this.segmenter && this.isModelLoaded) return;

    return new Promise((resolve, reject) => {
      try {
        const segmenter = new SelfieSegmentation({
          locateFile: (file) => {
            return `/mediapipe/selfie_segmentation/${file}`;
          },
        });

        // modelSelection: 0 is the fast general model (256x256), optimized for real-time video calls with near-zero latency
        segmenter.setOptions({
          modelSelection: 0,
          selfieMode: false,
        });

        segmenter.onResults((results: Results) => {
          this.renderFrame(results);
        });

        this.segmenter = segmenter;
        this.isModelLoaded = true;
        resolve();
      } catch (err) {
        console.warn('[VirtualBackground] Model init failed, trying CDN fallback:', err);
        try {
          const fallbackSegmenter = new SelfieSegmentation({
            locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`,
          });
          fallbackSegmenter.setOptions({ modelSelection: 0, selfieMode: false });
          fallbackSegmenter.onResults((results) => this.renderFrame(results));
          this.segmenter = fallbackSegmenter;
          this.isModelLoaded = true;
          resolve();
        } catch (e) {
          reject(e);
        }
      }
    });
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
    if (customImageUrl) {
      await this.setCustomImage(customImageUrl);
    }
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
    this.hasReceivedFirstResult = false;

    if (customImageUrl) {
      await this.setCustomImage(customImageUrl);
    }

    if (mode === 'none') {
      this.stop();
      return cameraStream.getVideoTracks()[0] || null;
    }

    // Set up video element to read frames from camera
    if (!this.videoEl) {
      this.videoEl = document.createElement('video');
      this.videoEl.autoplay = true;
      this.videoEl.playsInline = true;
      this.videoEl.muted = true;
    }

    this.videoEl.srcObject = cameraStream;
    await this.videoEl.play().catch(() => {});

    // Match canvas dimensions to video (cap to 1280x720 for silky smooth 30fps)
    let width = this.videoEl.videoWidth || 1280;
    let height = this.videoEl.videoHeight || 720;
    if (width > 1280) {
      height = Math.round((height * 1280) / width);
      width = 1280;
    }
    this.canvas.width = width;
    this.canvas.height = height;

    // Immediately blit the camera frame to canvas so captureStream is never black from frame 0
    if (this.ctx && this.videoEl.readyState >= 2) {
      this.ctx.drawImage(this.videoEl, 0, 0, width, height);
    }

    // Start single processing loop if not already running
    if (!this.isProcessing) {
      this.isProcessing = true;
      this.processLoop();
    }

    // Capture processed 30fps track
    if (!this.outputStream) {
      this.outputStream = this.canvas.captureStream(30);
    }

    // Initialize segmentation model in background without blocking stream output
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

  private processLoop = async () => {
    if (!this.isProcessing || !this.videoEl) return;

    if (this.currentMode === 'none') {
      return;
    }

    // If model hasn't produced its first segmented frame yet, keep passing through camera feed
    if (!this.hasReceivedFirstResult && this.ctx && this.videoEl.readyState >= 2 && !this.videoEl.paused) {
      this.ctx.drawImage(this.videoEl, 0, 0, this.canvas.width, this.canvas.height);
    }

    const now = performance.now();
    // Cap inference to ~30 FPS (every 32ms) and guard against concurrent in-flight executions
    if (
      this.segmenter &&
      now - this.lastProcessTime >= 32 &&
      !this.isBusy &&
      this.videoEl.readyState >= 2 &&
      !this.videoEl.paused
    ) {
      this.isBusy = true;
      this.lastProcessTime = now;
      try {
        await this.segmenter.send({ image: this.videoEl });
      } catch (e) {
        // Skip frame if dropped
      } finally {
        this.isBusy = false;
      }
    }

    if (this.isProcessing) {
      this.animId = requestAnimationFrame(this.processLoop);
    }
  };

  private renderFrame(results: Results): void {
    if (!this.ctx) return;
    this.hasReceivedFirstResult = true;

    const { width, height } = this.canvas;
    const ctx = this.ctx;

    ctx.save();
    ctx.clearRect(0, 0, width, height);

    // 1. Draw segmentation mask & person in standard camera orientation (unflipped).
    // Local self-view is mirrored via CSS `transform: scaleX(-1)` so the user's face
    // orientation remains 100% stable and never jumps or flips when changing effects.
    ctx.drawImage(results.segmentationMask, 0, 0, width, height);
    ctx.globalCompositeOperation = 'source-in';
    ctx.drawImage(results.image, 0, 0, width, height);

    // 2. Draw background behind the segmented person
    ctx.globalCompositeOperation = 'destination-over';

    if (this.currentMode === 'blur-light') {
      // High-performance downscale-upscale bokeh blur: 0.1ms render time, zero UI freeze
      if (this.blurCtx) {
        this.blurCanvas.width = 160;
        this.blurCanvas.height = 90;
        this.blurCtx.filter = 'none';
        this.blurCtx.drawImage(results.image, 0, 0, 160, 90);
        this.blurCtx.filter = 'blur(1.5px)';
        this.blurCtx.drawImage(this.blurCanvas, 0, 0, 160, 90);

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'medium';
        ctx.drawImage(this.blurCanvas, 0, 0, width, height);
      }
    } else if (this.currentMode === 'blur-heavy') {
      // High-performance heavy bokeh blur: downscale to 80x45 + light filter
      if (this.blurCtx) {
        this.blurCanvas.width = 80;
        this.blurCanvas.height = 45;
        this.blurCtx.filter = 'none';
        this.blurCtx.drawImage(results.image, 0, 0, 80, 45);
        this.blurCtx.filter = 'blur(2.5px)';
        this.blurCtx.drawImage(this.blurCanvas, 0, 0, 80, 45);

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'medium';
        ctx.drawImage(this.blurCanvas, 0, 0, width, height);
      }
    } else if (this.currentMode === 'image-techugo' && this.techugoImage) {
      // Horizontally pre-flip the background image so that the local CSS mirror renders
      // the Techugo logo forward and readable ("techugo").
      ctx.save();
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(this.techugoImage, 0, 0, width, height);
      ctx.restore();
    } else if (this.currentMode === 'image-custom' && this.customImage) {
      // Horizontally pre-flip custom background image so local CSS mirror renders it forward
      ctx.save();
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(this.customImage, 0, 0, width, height);
      ctx.restore();
    } else {
      // Default fallback: subtle dark background
      ctx.fillStyle = '#202124';
      ctx.fillRect(0, 0, width, height);
    }

    ctx.restore();
  }

  public stop(): void {
    this.isProcessing = false;
    this.isBusy = false;
    this.hasReceivedFirstResult = false;
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
    if (this.segmenter) {
      try {
        this.segmenter.close();
      } catch {}
      this.segmenter = null;
    }
    this.outputStream = null;
  }
}
