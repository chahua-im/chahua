interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  lifetime: number;
  radius: number;
}

/** One continuous field per spoiler; fragments only clip it, never restart it. */
export class SpoilerParticles {
  private readonly context: CanvasRenderingContext2D | null;
  private readonly intersection: IntersectionObserver;
  private readonly resize: ResizeObserver;
  private visible = false;
  private disposed = false;
  private frame = 0;
  private previousTime = 0;
  private dirty = true;
  private rects: Rect[] = [];
  private area = 0;
  private particles: Particle[] = [];
  private width = 0;
  private height = 0;
  private dpr = 1;

  constructor(
    private readonly element: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    host: HTMLElement,
  ) {
    this.context = canvas.getContext('2d');
    this.intersection = new IntersectionObserver(([entry]) => {
      this.visible = entry.isIntersecting;
      this.sync();
    });
    this.resize = new ResizeObserver(() => {
      this.dirty = true;
      this.sync();
    });
    this.intersection.observe(element);
    // Inline spans themselves do not receive resize notifications.
    this.resize.observe(host.closest('.bubble') ?? host.parentElement!);
    this.resize.observe(element.ownerDocument.documentElement);
    element.ownerDocument.addEventListener('visibilitychange', this.sync);
    element.ownerDocument.fonts?.addEventListener('loadingdone', this.invalidate);
  }

  reveal(): void {
    this.element.classList.add('revealed');
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  hide(): void {
    this.element.classList.remove('revealed');
    this.sync();
  }

  destroy(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.intersection.disconnect();
    this.resize.disconnect();
    this.element.ownerDocument.removeEventListener('visibilitychange', this.sync);
    this.element.ownerDocument.fonts?.removeEventListener('loadingdone', this.invalidate);
  }

  private readonly invalidate = () => {
    this.dirty = true;
    this.sync();
  };

  private readonly sync = () => {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.previousTime = 0;
    if (this.disposed || !this.visible || this.element.ownerDocument.hidden) {
      return;
    }
    if (this.context && !this.element.classList.contains('revealed')) {
      this.frame = requestAnimationFrame(this.draw);
    }
  };

  private measure(): void {
    this.dirty = false;
    const fragments = Array.from(this.element.getClientRects()).filter((rect) => rect.width && rect.height);
    if (!fragments.length) return;
    // Measure a CSS-pixel probe so menu scale animations do not get baked into
    // the canvas dimensions or applied a second time to its placement.
    this.canvas.style.left = '0px';
    this.canvas.style.top = '0px';
    this.canvas.style.width = '1px';
    this.canvas.style.height = '1px';
    const origin = this.canvas.getBoundingClientRect();
    const scaleX = origin.width;
    const scaleY = origin.height;
    const left = Math.min(...fragments.map((r) => r.left));
    const top = Math.min(...fragments.map((r) => r.top));
    this.width = (Math.max(...fragments.map((r) => r.right)) - left) / scaleX;
    this.height = (Math.max(...fragments.map((r) => r.bottom)) - top) / scaleY;
    this.rects = fragments.map((r) => ({
      x: (r.left - left) / scaleX,
      y: (r.top - top) / scaleY,
      width: r.width / scaleX,
      height: r.height / scaleY,
    }));
    // Bridge only overlapping portions of adjacent lines. Leading/trailing plain
    // text remains outside the mask, and a union clip avoids darker overlap seams.
    const lines = [...this.rects].sort((a, b) => a.y - b.y);
    const lineHeight = parseFloat(getComputedStyle(this.element).lineHeight);
    for (let i = 1; i < lines.length; i++) {
      const previous = lines[i - 1];
      const next = lines[i];
      const gap = next.y - previous.y - previous.height;
      const x = Math.max(previous.x, next.x);
      const right = Math.min(previous.x + previous.width, next.x + next.width);
      if (gap > 0 && gap < lineHeight && right > x) {
        this.rects.push({ x, y: previous.y + previous.height - 0.5, width: right - x, height: gap + 1 });
      }
    }
    this.canvas.style.left = `${(left - origin.left) / scaleX}px`;
    this.canvas.style.top = `${(top - origin.top) / scaleY}px`;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.dpr = window.devicePixelRatio;
    this.canvas.width = Math.ceil(this.width * this.dpr);
    this.canvas.height = Math.ceil(this.height * this.dpr);
    // Resizing resets canvas state. Install the union clip once for this layout,
    // instead of rebuilding and saving/restoring it on every animation frame.
    const ctx = this.context!;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.beginPath();
    for (const r of this.rects) ctx.rect(r.x, r.y, r.width, r.height);
    ctx.clip();
    this.area = this.rects.reduce((sum, r) => sum + r.width * r.height, 0);
    const count = Math.min(2500, Math.ceil(this.area / 9));
    this.particles = Array.from({ length: count }, () => {
      const particle = this.createParticle();
      particle.age = Math.random() * particle.lifetime;
      return particle;
    });
    this.element.classList.add('particles-ready');
  }

  private createParticle(particle: Particle = { x: 0, y: 0, vx: 0, vy: 0, age: 0, lifetime: 0, radius: 0 }): Particle {
    // Weighted sampling keeps narrow and wide line fragments equally dense.
    let sample = Math.random() * this.area;
    const rect = this.rects.find((r) => (sample -= r.width * r.height) <= 0)!;
    const angle = Math.random() * Math.PI * 2;
    const speed = 2 + Math.random() * 5;
    particle.x = rect.x + Math.random() * rect.width;
    particle.y = rect.y + Math.random() * rect.height;
    particle.vx = Math.cos(angle) * speed;
    particle.vy = Math.sin(angle) * speed;
    particle.age = 0;
    particle.lifetime = 1.5 + Math.random() * 2;
    particle.radius = 0.45 + Math.random() * 0.4;
    return particle;
  }

  private readonly draw = (time: number) => {
    this.frame = 0;
    if (this.previousTime && time - this.previousTime < 1000 / 30) {
      this.frame = requestAnimationFrame(this.draw);
      return;
    }
    const dt = this.previousTime ? Math.min((time - this.previousTime) / 1000, 0.05) : 0;
    this.previousTime = time;
    if (this.dirty || this.dpr !== window.devicePixelRatio) this.measure();
    const ctx = this.context!;
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = getComputedStyle(this.element).color;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      p.age += dt;
      if (p.age >= p.lifetime) this.createParticle(p);
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      ctx.globalAlpha = Math.sin((p.age / p.lifetime) * Math.PI) * 0.75;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!this.element.classList.contains('revealed')) this.frame = requestAnimationFrame(this.draw);
  };
}
