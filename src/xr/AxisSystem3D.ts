import * as THREE from 'three';
import type {DerivedSpatialDataset} from '../types';

export const PLOT_WIDTH = 1.68;
export const PLOT_HEIGHT = 0.96;
export const PLOT_DEPTH = 1.12;
export const PLOT_BOTTOM_Y = 0.04;

const MAX_X_LABELS = 10;
const MAX_Z_LABELS = 7;

export function normXToWorld(xNorm: number): number {
  return (xNorm - 0.5) * PLOT_WIDTH;
}

export function normYToWorld(yNorm: number): number {
  return PLOT_BOTTOM_Y + yNorm * PLOT_HEIGHT;
}

export function normZToWorld(zNorm: number): number {
  return (zNorm - 0.5) * PLOT_DEPTH;
}

function truncateText(text: string, maxLen: number): string {
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

export class AxisSystem3D extends THREE.Group {
  private lineObjects: THREE.LineSegments[] = [];
  private helperMeshes: THREE.Mesh[] = [];
  private sprites: THREE.Sprite[] = [];
  private textures: THREE.CanvasTexture[] = [];
  private geometries: THREE.BufferGeometry[] = [];
  private materials: THREE.Material[] = [];

  constructor() {
    super();
    this.name = 'AnalyticalAxisSystem3D';
    this.xb = {pointerEvents: 'none'};
  }

  public updateFromDerived(derived: DerivedSpatialDataset): void {
    this.clearVisuals();

    if (!derived.isValid) {
      return;
    }

    if (derived.mode === 'ring3d') {
      this.buildRingGuides(derived);
      return;
    }

    this.buildCartesianAxesAndGrid(derived);
  }

  private buildCartesianAxesAndGrid(derived: DerivedSpatialDataset): void {
    const halfW = PLOT_WIDTH / 2;
    const halfD = PLOT_DEPTH / 2;
    const bottomY = PLOT_BOTTOM_Y;
    const topY = PLOT_BOTTOM_Y + PLOT_HEIGHT;
    const yAxis = derived.axes.y;
    const xAxis = derived.axes.x;
    const zAxis = derived.axes.z;

    const zeroWorldY =
      yAxis.zeroNormalized !== null
        ? normYToWorld(yAxis.zeroNormalized)
        : bottomY;

    // 1. Subtle back & side grid lines aligned to Y ticks and X/Z ticks
    const gridVerts: number[] = [];

    // Floor outline
    gridVerts.push(
      -halfW, bottomY, -halfD, halfW, bottomY, -halfD,
      halfW, bottomY, -halfD, halfW, bottomY, halfD,
      halfW, bottomY, halfD, -halfW, bottomY, halfD,
      -halfW, bottomY, halfD, -halfW, bottomY, -halfD
    );

    // Y gridlines across back wall (z = -halfD) and left wall (x = -halfW)
    for (const tick of yAxis.numericTicks) {
      const y = normYToWorld(tick.normalized);
      gridVerts.push(-halfW, y, -halfD, halfW, y, -halfD);
      gridVerts.push(-halfW, y, -halfD, -halfW, y, halfD);
    }

    // X vertical gridlines across back wall & floor
    if (xAxis.kind === 'categorical' && xAxis.categoryTicks.length > 0) {
      const count = xAxis.categoryTicks.length;
      const step = count > 16 ? Math.ceil(count / 12) : 1;
      for (let i = 0; i < count; i += step) {
        const x = normXToWorld(xAxis.categoryTicks[i].normalized);
        gridVerts.push(x, bottomY, -halfD, x, topY, -halfD);
        gridVerts.push(x, bottomY, -halfD, x, bottomY, halfD);
      }
    } else {
      for (const tick of xAxis.numericTicks) {
        const x = normXToWorld(tick.normalized);
        gridVerts.push(x, bottomY, -halfD, x, topY, -halfD);
        gridVerts.push(x, bottomY, -halfD, x, bottomY, halfD);
      }
    }

    // Z gridlines across floor & left wall
    if (zAxis) {
      if (zAxis.kind === 'categorical' && zAxis.categoryTicks.length > 0) {
        for (const tick of zAxis.categoryTicks) {
          const z = normZToWorld(tick.normalized);
          gridVerts.push(-halfW, bottomY, z, halfW, bottomY, z);
          gridVerts.push(-halfW, bottomY, z, -halfW, topY, z);
        }
      } else {
        for (const tick of zAxis.numericTicks) {
          const z = normZToWorld(tick.normalized);
          gridVerts.push(-halfW, bottomY, z, halfW, bottomY, z);
          gridVerts.push(-halfW, bottomY, z, -halfW, topY, z);
        }
      }
    }

    this.addLineSegments(gridVerts, 0x334155, 0.52);

    // 2. Crisp primary X, Y, Z axis spines
    const spineVerts: number[] = [
      // X spine along front edge at zero baseline (or bottom)
      -halfW, zeroWorldY, halfD, halfW, zeroWorldY, halfD,
      // Y spine along front-left vertical corner
      -halfW, bottomY, halfD, -halfW, topY, halfD,
      // Back-left vertical edge
      -halfW, bottomY, -halfD, -halfW, topY, -halfD,
    ];
    if (zAxis) {
      // Z spine along right-bottom (or left-bottom) edge
      spineVerts.push(halfW, zeroWorldY, -halfD, halfW, zeroWorldY, halfD);
      spineVerts.push(-halfW, zeroWorldY, -halfD, -halfW, zeroWorldY, halfD);
    }
    this.addLineSegments(spineVerts, 0x64748b, 0.9);

    // 3. Zero baseline highlight when dataset spans negative & positive values
    if (
      yAxis.zeroNormalized !== null &&
      yAxis.zeroNormalized > 0.01 &&
      yAxis.zeroNormalized < 0.99
    ) {
      const zeroBorderVerts = [
        -halfW, zeroWorldY, -halfD, halfW, zeroWorldY, -halfD,
        halfW, zeroWorldY, -halfD, halfW, zeroWorldY, halfD,
        halfW, zeroWorldY, halfD, -halfW, zeroWorldY, halfD,
        -halfW, zeroWorldY, halfD, -halfW, zeroWorldY, -halfD,
      ];
      this.addLineSegments(zeroBorderVerts, 0x38bdf8, 0.85);

      const zeroPlaneGeo = new THREE.PlaneGeometry(PLOT_WIDTH, PLOT_DEPTH);
      const zeroPlaneMat = new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.08,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      this.geometries.push(zeroPlaneGeo);
      this.materials.push(zeroPlaneMat);
      const zeroPlane = new THREE.Mesh(zeroPlaneGeo, zeroPlaneMat);
      zeroPlane.rotation.x = -Math.PI / 2;
      zeroPlane.position.set(0, zeroWorldY, 0);
      zeroPlane.xb = {pointerEvents: 'none'};
      this.helperMeshes.push(zeroPlane);
      this.add(zeroPlane);
    }

    // 4. Y Axis Ticks + Title
    for (const tick of yAxis.numericTicks) {
      const y = normYToWorld(tick.normalized);
      const isZero = Math.abs(tick.value) < 1e-9;
      this.addSpriteLabel(
        tick.label,
        new THREE.Vector3(-halfW - 0.13, y, halfD),
        {
          fontSize: 24,
          color: isZero ? '#38bdf8' : '#cbd5e1',
          scale: 0.19,
          align: 'right',
        }
      );
    }
    const yTitle =
      yAxis.unit && !yAxis.title.includes(`(${yAxis.unit})`)
        ? `${yAxis.title} (${yAxis.unit})`
        : yAxis.title;
    this.addSpriteLabel(
      truncateText(yTitle, 26),
      new THREE.Vector3(-halfW - 0.12, topY + 0.13, halfD),
      {
        fontSize: 26,
        fontWeight: 'bold',
        color: '#f8fafc',
        bgColor: 'rgba(15, 23, 42, 0.88)',
        borderColor: 'rgba(59, 130, 246, 0.55)',
        scale: 0.28,
      }
    );

    // 5. X Axis Ticks + Title
    if (xAxis.kind === 'categorical') {
      const cats = xAxis.categoryTicks;
      const stride =
        cats.length > MAX_X_LABELS
          ? Math.ceil(cats.length / MAX_X_LABELS)
          : 1;
      for (let i = 0; i < cats.length; i += stride) {
        const tick = cats[i];
        this.addSpriteLabel(
          truncateText(tick.label, 12),
          new THREE.Vector3(
            normXToWorld(tick.normalized),
            bottomY - 0.03,
            halfD + 0.13
          ),
          {
            fontSize: 22,
            color: '#e2e8f0',
            scale: 0.2,
          }
        );
      }
    } else {
      for (const tick of xAxis.numericTicks) {
        this.addSpriteLabel(
          tick.label,
          new THREE.Vector3(
            normXToWorld(tick.normalized),
            bottomY - 0.03,
            halfD + 0.12
          ),
          {
            fontSize: 22,
            color: '#e2e8f0',
            scale: 0.18,
          }
        );
      }
    }

    const xTitle =
      xAxis.unit && !xAxis.title.includes(`(${xAxis.unit})`)
        ? `${xAxis.title} (${xAxis.unit})`
        : xAxis.title;
    this.addSpriteLabel(
      truncateText(`X: ${xTitle}`, 28),
      new THREE.Vector3(0, bottomY - 0.16, halfD + 0.42),
      {
        fontSize: 24,
        fontWeight: 'bold',
        color: '#93c5fd',
        bgColor: 'rgba(15, 23, 42, 0.88)',
        scale: 0.27,
      }
    );

    // 6. Z Axis Ticks + Title (when active in Grouped Bars or 3D Scatter)
    if (zAxis) {
      if (zAxis.kind === 'categorical') {
        const zCats = zAxis.categoryTicks;
        const zStride =
          zCats.length > MAX_Z_LABELS
            ? Math.ceil(zCats.length / MAX_Z_LABELS)
            : 1;
        for (let i = 0; i < zCats.length; i += zStride) {
          const tick = zCats[i];
          this.addSpriteLabel(
            truncateText(tick.label, 12),
            new THREE.Vector3(
              halfW + 0.14,
              bottomY - 0.02,
              normZToWorld(tick.normalized)
            ),
            {
              fontSize: 22,
              color: '#cbd5e1',
              scale: 0.19,
            }
          );
        }
      } else {
        for (const tick of zAxis.numericTicks) {
          this.addSpriteLabel(
            tick.label,
            new THREE.Vector3(
              halfW + 0.14,
              bottomY - 0.02,
              normZToWorld(tick.normalized)
            ),
            {
              fontSize: 22,
              color: '#cbd5e1',
              scale: 0.18,
            }
          );
        }
      }

      const zTitle =
        zAxis.unit && !zAxis.title.includes(`(${zAxis.unit})`)
          ? `${zAxis.title} (${zAxis.unit})`
          : zAxis.title;
      this.addSpriteLabel(
        truncateText(`Z: ${zTitle}`, 26),
        new THREE.Vector3(halfW + 0.38, bottomY - 0.15, 0),
        {
          fontSize: 24,
          fontWeight: 'bold',
          color: '#6ee7b7',
          bgColor: 'rgba(15, 23, 42, 0.88)',
          scale: 0.26,
        }
      );
    }
  }

  private buildRingGuides(derived: DerivedSpatialDataset): void {
    const outerRadius = 0.62;
    const innerRadius = 0.26;
    const baseY = PLOT_BOTTOM_Y;

    // Circular reference guide rings
    const circleVerts: number[] = [];
    const segs = 64;
    for (const r of [innerRadius, outerRadius, 0.72]) {
      for (let i = 0; i < segs; i++) {
        const a0 = (i / segs) * Math.PI * 2;
        const a1 = ((i + 1) / segs) * Math.PI * 2;
        circleVerts.push(
          Math.cos(a0) * r, baseY, Math.sin(a0) * r,
          Math.cos(a1) * r, baseY, Math.sin(a1) * r
        );
      }
    }
    this.addLineSegments(circleVerts, 0x334155, 0.65);

    // Center title positioned clearly above ring slices & back perimeter labels
    const rawRingTitle = derived.axes.y.title;
    const ringUnit = derived.axes.y.unit;
    const title =
      ringUnit && !rawRingTitle.includes(`(${ringUnit})`)
        ? `${rawRingTitle} (${ringUnit})`
        : rawRingTitle;
    this.addSpriteLabel(
      truncateText(title, 28),
      new THREE.Vector3(0, baseY + 0.54, -0.05),
      {
        fontSize: 24,
        fontWeight: 'bold',
        color: '#f8fafc',
        bgColor: 'rgba(15, 23, 42, 0.9)',
        borderColor: 'rgba(59, 130, 246, 0.55)',
        scale: 0.28,
      }
    );

    // Sector perimeter labels (bounded by MAX_RING_SLICES <= 10)
    for (const item of derived.items) {
      if (item.angleStart === undefined || item.angleEnd === undefined) continue;
      const pct = ((item.proportion ?? 0) * 100).toFixed(1);
      if (item.proportion !== undefined && item.proportion < 0.035 && derived.items.length > 6) {
        continue;
      }
      const mid = (item.angleStart + item.angleEnd) * 0.5;
      const labelR = 0.86;
      const isBackArc = Math.sin(mid) < -0.15;
      this.addSpriteLabel(
        `${truncateText(item.label, 12)} · ${pct}%`,
        new THREE.Vector3(
          Math.cos(mid) * labelR,
          baseY + (isBackArc ? 0.14 : 0.06) + item.yNorm * 0.1,
          Math.sin(mid) * labelR
        ),
        {
          fontSize: 21,
          color: '#f1f5f9',
          bgColor: 'rgba(15, 23, 42, 0.86)',
          borderColor: item.colorHex,
          scale: 0.23,
        }
      );
    }
  }

  private addLineSegments(
    vertices: number[],
    color: number,
    opacity: number
  ): void {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    const mat = new THREE.LineBasicMaterial({
      color,
      transparent: opacity < 1,
      opacity,
    });
    this.geometries.push(geo);
    this.materials.push(mat);

    const lines = new THREE.LineSegments(geo, mat);
    lines.xb = {pointerEvents: 'none'};
    this.lineObjects.push(lines);
    this.add(lines);
  }

  private addSpriteLabel(
    text: string,
    position: THREE.Vector3,
    opts: {
      fontSize?: number;
      fontWeight?: 'normal' | 'bold';
      color?: string;
      bgColor?: string;
      borderColor?: string;
      scale?: number;
      align?: 'center' | 'right';
    } = {}
  ): void {
    const fontSize = opts.fontSize ?? 22;
    const fontWeight = opts.fontWeight ?? 'normal';
    const textColor = opts.color ?? '#e2e8f0';
    const scaleH = opts.scale ?? 0.2;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const font = `${fontWeight} ${fontSize}px "Google Sans", "Segoe UI", Roboto, sans-serif`;
    ctx.font = font;
    const metrics = ctx.measureText(text);
    const padX = 16;
    const padY = 10;
    const w = Math.max(64, Math.ceil(metrics.width + padX * 2));
    const h = Math.max(40, Math.ceil(fontSize * 1.4 + padY * 2));

    canvas.width = w;
    canvas.height = h;

    ctx.font = font;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    if (opts.bgColor) {
      ctx.fillStyle = opts.bgColor;
      this.roundRect(ctx, 2, 2, w - 4, h - 4, 10);
      ctx.fill();
      if (opts.borderColor) {
        ctx.strokeStyle = opts.borderColor;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    ctx.fillStyle = textColor;
    ctx.fillText(text, w / 2, h / 2);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    this.textures.push(tex);

    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });
    this.materials.push(mat);

    const sprite = new THREE.Sprite(mat);
    sprite.renderOrder = 10;
    const aspect = w / h;
    sprite.scale.set(scaleH * aspect * 0.55, scaleH * 0.55, 1);
    sprite.position.copy(position);
    if (opts.align === 'right') {
      sprite.position.x -= sprite.scale.x * 0.22;
    }
    sprite.xb = {pointerEvents: 'none'};
    this.sprites.push(sprite);
    this.add(sprite);
  }

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number
  ): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  private clearVisuals(): void {
    for (const l of this.lineObjects) this.remove(l);
    for (const m of this.helperMeshes) this.remove(m);
    for (const s of this.sprites) this.remove(s);
    for (const t of this.textures) t.dispose();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();

    this.lineObjects = [];
    this.helperMeshes = [];
    this.sprites = [];
    this.textures = [];
    this.geometries = [];
    this.materials = [];
  }

  public dispose(): void {
    this.clearVisuals();
  }
}
