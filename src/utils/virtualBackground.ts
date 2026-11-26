import { SelfieSegmentation, Results } from '@mediapipe/selfie_segmentation';
import techugoImgUrl from '../assets/techugoImg.jpg';

export type BackgroundMode = 'none' | 'blur-light' | 'blur-heavy' | 'image-techugo' | 'image-custom';

export class VirtualBackgroundProcessor {
  private segmenter: SelfieSegmentation | null = null;
  private isModelLoaded = false;
  private videoEl: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;

  // Offscreen input canvas to downsample camera frames before feeding MediaPipe.
  // Model 0 uses 256x256 tensors; feeding a 256x144 canvas reduces CPU/WASM copy by 16x!
  private inputCanvas: HTMLCanvasElement;
  private inputCtx: CanvasRenderingContext2D | null;

  // Offscreen canvas storing the most recent segmentation mask
  private maskCanvas: HTMLCanvasElement;
  private maskCtx: CanvasRenderingContext2D | null;
  private hasValidMask = false;

  // Dedicated offscreen canvas for instantaneous 60fps GPU-assisted blur
  private blurCanvas: HTMLCanvasElement;
  private blurCtx: CanvasRenderingContext2D | null;

  private animId: number | null = null;
  private currentMode: BackgroundMode = 'none';
  private customImage: HTMLImageElement | null = null;
  private techugoImage: HTMLImageElement | null = null;
  private outputStream: MediaStream | null = null;
  private isProcessing = false;

  // Inference state gating: strictly prevent frame accumulation queuing in MediaPipe C++ graph
  private isInferring = false;
  private lastInferTime = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1280;
    this.canvas.height = 720;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

    // 480x270 downscaled canvas for fast model inference with high edge fidelity
    this.inputCanvas = document.createElement('canvas');
    this.inputCanvas.width = 480;
    this.inputCanvas.height = 270;
    this.inputCtx = this.inputCanvas.getContext('2d', { willReadFrequently: true });

    // 640x360 mask cache for smooth edge interpolation
    this.maskCanvas = document.createElement('canvas');
    this.maskCanvas.width = 640;
    this.maskCanvas.height = 360;
    this.maskCtx = this.maskCanvas.getContext('2d');

    // Offscreen blur canvas
    this.blurCanvas = document.createElement('canvas');
    this.blurCanvas.width = 320;
    this.blurCanvas.height = 180;
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

        // modelSelection: 1 is the high-fidelity landscape model (16:9), optimized for webcam video calls with accurate head/body contours
        segmenter.setOptions({
          modelSelection: 1,
          selfieMode: false,
        });

        segmenter.onResults((results: Results) => {
          this.handleResults(results);
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
          fallbackSegmenter.setOptions({ modelSelection: 1, selfieMode: false });
          fallbackSegmenter.onResults((results) => this.handleResults(results));
          this.segmenter = fallbackSegmenter;
          this.isModelLoaded = true;
          resolve();
        } catch (e) {
          reject(e);
        }
      }
    });
  }

  private handleResults(results: Results): void {
    // Cache latest segmentation mask into offscreen mask canvas
    if (this.maskCtx && results.segmentationMask) {
      this.maskCtx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
      this.maskCtx.imageSmoothingEnabled = true;
      this.maskCtx.imageSmoothingQuality = 'high';
      this.maskCtx.drawImage(
        results.segmentationMask,
        0,
        0,
        this.maskCanvas.width,
        this.maskCanvas.height
      );
      this.hasValidMask = true;
    }
    // Gating release: MediaPipe has finished computing this frame.
    // Setting isInferring to false here ensures zero frames ever build up in the internal packet queue!
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
    this.hasValidMask = false;
    this.isInferring = false;

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

  /**
   * Continuous rendering loop running on requestAnimationFrame (30-60 FPS).
   * Key Architecture:
   * 1. Decoupled rendering: the user's movements are drawn directly from the live `videoEl`
   *    on EVERY animation frame, meaning latency is 0ms (instant real-time movement).
   * 2. Zero-queue inference: MediaPipe is only fed the next frame after the previous one
   *    completely finishes, preventing internal queue build-up and the multi-second/minute lag.
   */
  private processLoop = () => {
    if (!this.isProcessing || !this.videoEl) return;

    if (this.currentMode === 'none') {
      return;
    }

    const video = this.videoEl;
    const ctx = this.ctx;
    const { width, height } = this.canvas;

    if (video.readyState >= 2 && !video.paused && ctx) {
      if (!this.hasValidMask) {
        // While segmentation mask is loading, display the live camera feed directly (0 latency)
        ctx.drawImage(video, 0, 0, width, height);
      } else {
        // Full composite render:
        ctx.save();
        ctx.clearRect(0, 0, width, height);

        // Step 1: Draw the full-color, sharp video frame first
        ctx.drawImage(video, 0, 0, width, height);

        // Step 2: Crop out background using 'destination-in' with soft edge feathering.
        // 'destination-in' keeps ONLY the real camera video pixels of the person.
        // The mask's own color is completely discarded, completely eliminating
        // any white, cyan, or halo artifacts around the silhouette!
        ctx.globalCompositeOperation = 'destination-in';
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.filter = 'blur(2px)';
        ctx.drawImage(this.maskCanvas, 0, 0, width, height);
        ctx.filter = 'none';

        // Step 3: Draw background behind the segmented person
        ctx.globalCompositeOperation = 'destination-over';

        if (this.currentMode === 'blur-light') {
          // Instant GPU-assisted downscale-upscale bokeh blur
          if (this.blurCtx) {
            this.blurCanvas.width = 320;
            this.blurCanvas.height = 180;
            this.blurCtx.filter = 'none';
            this.blurCtx.drawImage(video, 0, 0, 320, 180);
            this.blurCtx.filter = 'blur(3px)';
            this.blurCtx.drawImage(this.blurCanvas, 0, 0, 320, 180);

            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(this.blurCanvas, 0, 0, width, height);
          }
        } else if (this.currentMode === 'blur-heavy') {
          // Instant heavy bokeh blur
          if (this.blurCtx) {
            this.blurCanvas.width = 160;
            this.blurCanvas.height = 90;
            this.blurCtx.filter = 'none';
            this.blurCtx.drawImage(video, 0, 0, 160, 90);
            this.blurCtx.filter = 'blur(5px)';
            this.blurCtx.drawImage(this.blurCanvas, 0, 0, 160, 90);

            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(this.blurCanvas, 0, 0, width, height);
          }
        } else if (this.currentMode === 'image-techugo' && this.techugoImage) {
          // Pre-flip background image so local CSS mirror displays Techugo logo forward ("techugo")
          ctx.save();
          ctx.translate(width, 0);
          ctx.scale(-1, 1);
          ctx.drawImage(this.techugoImage, 0, 0, width, height);
          ctx.restore();
        } else if (this.currentMode === 'image-custom' && this.customImage) {
          // Pre-flip custom image so local CSS mirror displays it forward
          ctx.save();
          ctx.translate(width, 0);
          ctx.scale(-1, 1);
          ctx.drawImage(this.customImage, 0, 0, width, height);
          ctx.restore();
        } else {
          ctx.fillStyle = '#202124';
          ctx.fillRect(0, 0, width, height);
        }

        ctx.restore();
      }

      // ── Dispatch Next Inference (Strictly 1 frame in flight, capped to ~30 FPS) ──
      const now = performance.now();

      // Watchdog: If an inference took longer than 400ms (e.g. dropped frame), unblock gating
      if (this.isInferring && now - this.lastInferTime > 400) {
        this.isInferring = false;
      }

      if (!this.isInferring && this.segmenter && now - this.lastInferTime >= 33) {
        this.isInferring = true;
        this.lastInferTime = now;

        // Downscale camera frame into 256x144 canvas for fast GPU tensor preparation
        if (this.inputCtx) {
          this.inputCtx.drawImage(video, 0, 0, this.inputCanvas.width, this.inputCanvas.height);
          this.segmenter
            .send({ image: this.inputCanvas })
            .catch(() => {
              this.isInferring = false;
            });
        }
      }
    }

    if (this.isProcessing) {
      this.animId = requestAnimationFrame(this.processLoop);
    }
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
    }
  }
}
