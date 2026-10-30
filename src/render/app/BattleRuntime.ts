import { UnitMarkers } from './unit-markers';
import { BattleRenderer3D } from '../BattleRenderer3D';
import type { GameController } from '../../game/controller';
import type { Vec2 } from '../../simulation/types';

/** Browser lifetime: one canvas, one RAF loop, one resize observer and input boundary. */
export class BattleRuntime {
  readonly renderer: BattleRenderer3D;
  private readonly canvas: HTMLCanvasElement;
  private readonly observer: ResizeObserver | null;
  private readonly markers: UnitMarkers;
  private raf = 0;
  private lastFrame = 0;
  private activePointer: number | null = null;
  private activeButton: number | null = null;
  private panDragging = false;
  private lastPanPoint: { x: number; y: number } | null = null;
  private lastRightPress: { x: number; y: number; time: number; selection: string } | null = null;
  private stopped = false;
  private lost = false;
  private hoverPoint: { x: number; y: number } | null = null;

  private cameraBlocked(): boolean {
    return document.querySelector('.overlay:not([hidden]):not(.map-review-overlay)') !== null;
  }

  constructor(private readonly controller: GameController, private readonly container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('aria-label', 'European campaign battlefield');
    this.canvas.setAttribute('role', 'img');
    this.canvas.tabIndex = 0;
    this.canvas.style.display = 'block';
    this.canvas.style.touchAction = 'none';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.container.replaceChildren(this.canvas);
    const bounds = this.container.getBoundingClientRect();
    this.renderer = new BattleRenderer3D(this.canvas, Math.max(1, bounds.width), Math.max(1, bounds.height));
    this.controller.attachRenderer(this.renderer);
    this.markers = new UnitMarkers(container, controller, (pos, height) => this.worldToClient(pos, height));
    this.installInput();
    this.installContextLifecycle();
    this.observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.resize()) : null;
    this.observer?.observe(this.container);
    window.addEventListener('resize', this.resize);
    this.raf = requestAnimationFrame(this.onFrame);
  }

  private resize = (): void => {
    const bounds = this.container.getBoundingClientRect();
    if (bounds.width > 0 && bounds.height > 0) this.renderer.resize(bounds.width, bounds.height);
  };

  private onFrame = (time: number): void => {
    if (this.stopped || this.lost) return;
    const elapsed = this.lastFrame === 0 ? 0 : Math.max(0, time - this.lastFrame);
    const delta = Math.min(250, elapsed);
    this.lastFrame = time;
    if (!document.hidden) this.renderer.updateFrameTime(elapsed);
    this.controller.frame(delta);
    this.markers.update();
    if (!this.cameraBlocked() && this.renderer.getZoom() > 1 && this.controller.prefs.edgeScrolling && this.hoverPoint && this.activePointer === null) {
      const bounds = this.canvas.getBoundingClientRect(), edge = 24;
      const x = this.hoverPoint.x - bounds.left, y = this.hoverPoint.y - bounds.top;
      const dx = x < edge ? 1 - x / edge : x > bounds.width - edge ? -(x - bounds.width + edge) / edge : 0;
      const dy = y < edge ? 1 - y / edge : y > bounds.height - edge ? -(y - bounds.height + edge) / edge : 0;
      const speed = delta * .6 * this.controller.prefs.panSpeed;
      this.renderer.panByScreenPixels(dx * speed, dy * speed, bounds.width, bounds.height);
    }
    this.raf = requestAnimationFrame(this.onFrame);
  };

  private installContextLifecycle(): void {
    this.canvas.addEventListener('webglcontextlost', this.onContextLost, false);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);
  }

  private onContextLost = (event: Event): void => {
    event.preventDefault();
    this.lost = true;
    cancelAnimationFrame(this.raf);
    this.lastFrame = 0;
    if (!this.controller.isPaused) this.controller.togglePause();
    this.message('Graphics paused. Restore the battlefield, then press Resume.');
  };

  private onContextRestored = (): void => {
    this.lost = false;
    this.lastFrame = 0;
    this.controller.refreshRenderer();
    this.message('');
    this.raf = requestAnimationFrame(this.onFrame);
  };

  private message(text: string): void {
    let node = this.container.parentElement?.querySelector<HTMLElement>('[data-renderer-message]') ?? null;
    if (!node) {
      node = document.createElement('div');
      node.dataset.rendererMessage = 'true';
      node.setAttribute('role', 'status');
      node.style.cssText = 'position:absolute;inset:auto 8px 8px;z-index:12;padding:.5rem .7rem;background:#211f19;color:#eee0bd;border:1px solid #80714d;border-radius:4px;font:13px sans-serif;pointer-events:none';
      this.container.parentElement?.append(node);
    }
    node.textContent = text;
    node.hidden = !text;
  }

  private groundPoint(event: PointerEvent, clamp = false): Vec2 | null {
    return this.renderer.clientToSimulation(event.clientX, event.clientY, clamp);
  }

  private installInput(): void {
    this.canvas.addEventListener('contextmenu', this.preventContextMenu);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('keydown', this.onZoomKey);
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerCancel);
    this.canvas.addEventListener('lostpointercapture', this.onLostCapture);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);
    window.addEventListener('blur', this.onBlur);
  }

  private preventContextMenu = (event: Event): void => event.preventDefault();
  private onWheel = (event: WheelEvent): void => {
    if (this.cameraBlocked()) return;
    event.preventDefault();
    this.applyZoom(this.renderer.getZoom() * Math.exp(-event.deltaY * 0.001 * this.controller.prefs.zoomSensitivity));
  };
  private onZoomKey = (event: KeyboardEvent): void => {
    if (this.cameraBlocked()) return;
    const keys = this.controller.prefs.keys;
    if (event.code === keys.zoomIn) {
      event.preventDefault();
      this.applyZoom(this.renderer.getZoom() * 1.2);
    } else if (event.code === keys.zoomOut) {
      event.preventDefault();
      this.applyZoom(this.renderer.getZoom() / 1.2);
    } else if (event.code === keys.resetCamera) {
      event.preventDefault();
      this.renderer.resetCamera();
    }
  };
  private applyZoom(zoom: number): void {
    this.lastRightPress = null;
    this.renderer.setZoom(zoom);
  }
  private onPointerDown = (event: PointerEvent): void => {
    if (this.cameraBlocked()) return;
    if (event.button !== 0 && event.button !== 2) return;
    if (event.button === 0) this.lastRightPress = null;
    if (event.ctrlKey && event.button === 0) {
      event.preventDefault();
      this.activePointer = event.pointerId;
      this.activeButton = event.button;
      this.panDragging = true;
      this.lastPanPoint = { x: event.clientX, y: event.clientY };
      this.canvas.classList.add('pan-active');
      this.canvas.setPointerCapture(event.pointerId);
      return;
    }
    const point = this.groundPoint(event);
    if (!point) return;
    event.preventDefault();
    this.controller.unlockAudio();
    this.activePointer = event.pointerId;
    this.activeButton = event.button;
    this.lastPanPoint = { x: event.clientX, y: event.clientY };
    this.canvas.setPointerCapture(event.pointerId);
    if (event.button === 2) {
      const destination = this.renderer.buildingAt(event.clientX, event.clientY) ?? point;
      const selection = this.controller.selectionIds.join(',');
      const previous = this.lastRightPress;
      const moveOrder = selection.length > 0 && this.controller.mode.kind === 'none' && !this.controller.isPaused;
      const doubleClick = moveOrder && previous !== null && previous.selection === selection
        && event.timeStamp - previous.time >= 0 && event.timeStamp - previous.time <= 400
        && Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= 10;
      this.lastRightPress = moveOrder && !doubleClick
        ? { x: event.clientX, y: event.clientY, time: event.timeStamp, selection } : null;
      this.controller.pointerRight(destination.x, destination.y, doubleClick);
    }
    else this.controller.pointerLeft(point.x, point.y, event.shiftKey, this.renderer.friendlyUnitAt(event.clientX, event.clientY) ?? undefined);
  };
  private onPointerMove = (event: PointerEvent): void => {
    this.hoverPoint = { x: event.clientX, y: event.clientY };
    if (this.cameraBlocked()) return;
    if (this.activePointer === event.pointerId && this.activeButton === 0) {
      // Allow Ctrl to be pressed after the mouse button, too. Cancel the
      // selection gesture before moving the camera so release cannot select.
      if (!this.panDragging && event.ctrlKey) {
        this.controller.pointerCancel();
        this.panDragging = true;
        this.canvas.classList.add('pan-active');
      }
      if (this.panDragging && this.lastPanPoint !== null) {
        event.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        this.renderer.panByScreenPixels((event.clientX - this.lastPanPoint.x) * this.controller.prefs.panSpeed, (event.clientY - this.lastPanPoint.y) * this.controller.prefs.panSpeed, rect.width, rect.height);
        this.lastPanPoint = { x: event.clientX, y: event.clientY };
        return;
      }
      const point = this.groundPoint(event, true);
      if (point) this.controller.pointerMove(point.x, point.y);
      this.lastPanPoint = { x: event.clientX, y: event.clientY };
      return;
    }
    const point = this.groundPoint(event);
    if (point) this.controller.pointerMove(point.x, point.y);
  };
  private onPointerUp = (event: PointerEvent): void => {
    if (this.activePointer !== event.pointerId) return;
    const button = this.activeButton;
    this.activePointer = null;
    this.activeButton = null;
    if (button === 0) {
      if (this.panDragging) {
        this.panDragging = false;
        this.lastPanPoint = null;
        this.canvas.classList.remove('pan-active');
        if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
        return;
      }
      const point = this.groundPoint(event, true);
      if (point) this.controller.pointerUp(point.x, point.y, event.shiftKey);
      else this.controller.pointerCancel();
    }
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
  };
  private onPointerCancel = (event: PointerEvent): void => { if (this.activePointer === event.pointerId) this.clearGesture(); };
  private onLostCapture = (event: PointerEvent): void => { if (this.activePointer === event.pointerId) this.clearGesture(); };
  private onPointerLeave = (): void => { this.hoverPoint = null; this.controller.pointerLeave(); };
  private onBlur = (): void => { this.hoverPoint = null; this.clearGesture(); };
  private clearGesture(): void { this.activePointer = null; this.activeButton = null; this.panDragging = false; this.lastPanPoint = null; this.lastRightPress = null; this.canvas.classList.remove('pan-active'); this.controller.pointerCancel(); }

  worldToClient(pos: Vec2, height = 0): { x: number; y: number } | null { return this.renderer.simulationToClient(pos, height); }
  clientToWorld(x: number, y: number): Vec2 | null { return this.renderer.clientToSimulation(x, y); }
  get ready(): boolean { return !this.stopped && !this.lost; }
  diagnostics(): { geometries: number; textures: number; calls: number; triangles: number } { return this.renderer.rendererDiagnostics(); }

  destroy(): void {
    if (this.stopped) return;
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    this.observer?.disconnect();
    window.removeEventListener('resize', this.resize);
    window.removeEventListener('blur', this.onBlur);
    this.canvas.removeEventListener('contextmenu', this.preventContextMenu);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('keydown', this.onZoomKey);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerCancel);
    this.canvas.removeEventListener('lostpointercapture', this.onLostCapture);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.clearGesture();
    this.markers.destroy();
    this.renderer.destroy();
  }
}
