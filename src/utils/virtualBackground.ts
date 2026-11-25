import { SelfieSegmentation, Results } from '@mediapipe/selfie_segmentation';
import techugoImgUrl from '../assets/techugoImg.jpg';

export type BackgroundMode = 'none' | 'blur-light' | 'blur-heavy' | 'image-techugo' | 'image-custom';

export class VirtualBackgroundProcessor {
  private segmenter: SelfieSegmentation | null = null;
  private isModelLoaded = false;
  private videoEl: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private animId: number | null = null;
  private currentMode: BackgroundMode = 'none';
  private customImage: HTMLImageElement | null = null;
  private techugoImage: HTMLImageElement | null = null;
  private outputStream: MediaStream | null = null;
  private isProcessing = false;
  private isBusy = false;
  private lastProcessTime = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1280;
    this.canvas.height = 720;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

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
  }

  public async start(
    cameraStream: MediaStream,
    mode: BackgroundMode,
    customImageUrl?: string
  ): Promise<MediaStreamTrack | null> {
    this.currentMode = mode;

    if (customImageUrl) {
      await this.setCustomImage(customImageUrl);
    }

    if (mode === 'none') {
      this.stop();
      return cameraStream.getVideoTracks()[0] || null;
    }

    try {
      await this.initModel();
    } catch (err) {
      console.warn('[VirtualBackground] Could not initialize segmentation:', err);
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

    // Start single processing loop if not already running
    if (!this.isProcessing) {
      this.isProcessing = true;
      this.processLoop();
    }

    // Capture processed 30fps track
    if (!this.outputStream) {
      this.outputStream = this.canvas.captureStream(30);
    }

    return this.outputStream.getVideoTracks()[0] || null;
  }

  public changeMode(mode: BackgroundMode, customImageUrl?: string): void {
    this.setMode(mode, customImageUrl);
  }

  private processLoop = async () => {
    if (!this.isProcessing || !this.videoEl || !this.segmenter) return;

    if (this.currentMode === 'none') {
      return;
    }

    const now = performance.now();
    // Cap inference to ~30 FPS (every 32ms) and guard against concurrent in-flight executions
    if (now - this.lastProcessTime >= 32 && !this.isBusy && this.videoEl.readyState >= 2 && !this.videoEl.paused) {
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
    const { width, height } = this.canvas;
    const ctx = this.ctx;

    ctx.save();
    ctx.clearRect(0, 0, width, height);

    // 1. Draw the segmentation mask & person horizontally mirrored so user movements feel natural like a mirror
    ctx.save();
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(results.segmentationMask, 0, 0, width, height);
    ctx.globalCompositeOperation = 'source-in';
    ctx.drawImage(results.image, 0, 0, width, height);
    ctx.restore();

    // 2. Draw background behind the segmented person
    ctx.globalCompositeOperation = 'destination-over';

    if (this.currentMode === 'blur-light') {
      ctx.save();
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
      ctx.filter = 'blur(6px)';
      ctx.drawImage(results.image, 0, 0, width, height);
      ctx.restore();
    } else if (this.currentMode === 'blur-heavy') {
      ctx.save();
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
      ctx.filter = 'blur(12px)';
      ctx.drawImage(results.image, 0, 0, width, height);
      ctx.restore();
    } else if (this.currentMode === 'image-techugo' && this.techugoImage) {
      // Draw background image in original, non-reversed orientation (never flipped)
      ctx.drawImage(this.techugoImage, 0, 0, width, height);
    } else if (this.currentMode === 'image-custom' && this.customImage) {
      // Draw custom background image in original, non-reversed orientation (never flipped)
      ctx.drawImage(this.customImage, 0, 0, width, height);
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
