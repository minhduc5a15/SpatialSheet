import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import * as xb from 'xrblocks';
import type {
  ChartConfig,
  SheetData,
  SpatialChartMode,
  VisibleRowsSource,
} from '../types';
import {
  CHART_PALETTE,
  formatDisplayNumber,
  parseNumericValue,
} from '../core/tabular';
import {sampleChartIndices} from '../core/virtualWindow';

export interface SpatialStageCallbacks {
  onRowSelect: (rowIndex: number) => void;
  onSpatialModeChange: (mode: SpatialChartMode) => void;
}

interface BarNodeEntry {
  group: THREE.Group;
  bodyMesh: THREE.Mesh;
  capMesh: THREE.Mesh;
  bodyMat: THREE.MeshStandardMaterial;
  capMat: THREE.MeshStandardMaterial;
  rowIndex: number;
  seriesIndex: number;
  targetHeight: number;
  currentHeight: number;
  baseColor: THREE.Color;
  isSphere: boolean;
}

const BLACK_COLOR = new THREE.Color(0x000000);
const WHITE_COLOR = new THREE.Color(0xffffff);

export function detectSoftwareWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param) ?? '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

export class SpatialDataStage extends xb.Script {
  private callbacks: SpatialStageCallbacks;
  private isSoftwareGl = detectSoftwareWebGL();
  private stageRoot = new THREE.Group();
  private dataGroup = new THREE.Group();
  private pedestalGroup = new THREE.Group();

  // Reusable object/material pool (eliminates per-update GPU material allocation)
  private barPool: BarNodeEntry[] = [];
  private activeBarCount = 0;
  private pickTargetsCache: THREE.Object3D[] = [];

  private sharedBarGeo = new THREE.BoxGeometry(1, 1, 1);
  private sharedCapGeo = new THREE.BoxGeometry(1.04, 0.06, 1.04);
  private sharedSphereGeo = new THREE.SphereGeometry(0.5, 20, 14);
  private sharedStemGeo = new THREE.CylinderGeometry(0.08, 0.08, 1, 10);
  private pedestalGeos: THREE.BufferGeometry[] = [];
  private pedestalMats: THREE.Material[] = [];

  private gridTexture: THREE.CanvasTexture | null = null;
  private shadowTexture: THREE.CanvasTexture | null = null;
  private envTexture: THREE.Texture | null = null;
  private orbitControls: OrbitControls | null = null;

  private sheet: SheetData | null = null;
  private visibleRowIndices: VisibleRowsSource = [];
  private config: ChartConfig = {
    type: 'bar',
    xColIndex: 0,
    yColIndices: [1],
    spatialMode: 'bar3d',
  };
  private highlightedRowIndex: number | null = null;
  private heightScale = 1.0;
  private embeddedVisible = false;
  private xrOrSimActive = false;
  private dirtyFrames = 15;
  private pendingMeshSync = false;
  private lastMeshKey = '';

  // Built-in XR Blocks Spatial UI
  private spatialCard!: xb.UICard;
  private cardTitleText!: xb.UIText;
  private cardReadoutText!: xb.UIText;
  private scaleLabelText!: xb.UIText;
  private modeButtons: Record<SpatialChartMode, xb.UIButton> = {} as Record<
    SpatialChartMode,
    xb.UIButton
  >;

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private onPointerClickBound = (e: PointerEvent) => this.handleCanvasClick(e);

  constructor(callbacks: SpatialStageCallbacks) {
    super();
    this.callbacks = callbacks;
    this.buildSpatialCard();
  }

  private buildSpatialCard(): void {
    this.cardTitleText = new xb.UIText({
      text: '3D Data Stage',
      style: {fontSize: 26, fontWeight: 'bold'},
    });

    this.cardReadoutText = new xb.UIText({
      text: 'Tap or click a 3D bar to inspect row details.',
      style: {
        fontSize: 16,
        lineHeight: 1.35,
        opacity: 0.85,
        whiteSpace: 'pre-line',
      },
    });

    this.scaleLabelText = new xb.UIText({
      text: 'Height Scale: 1.0x',
      style: {fontSize: 16, fontWeight: 'bold'},
    });

    const scaleSlider = new xb.UISlider({
      ariaLabel: 'Adjust 3D chart height scale',
      min: 0.5,
      max: 1.8,
      step: 0.1,
      value: 1.0,
      style: {width: '100%', height: 36},
      onInput: (val: number) => {
        this.heightScale = val;
        this.scaleLabelText.text = `Height Scale: ${val.toFixed(1)}x`;
        this.lastMeshKey = '';
        this.requestMeshSync();
      },
    });

    this.modeButtons.bar3d = new xb.UIButton({
      label: '3D Bars',
      icon: 'bar_chart',
      style: {flexGrow: 1},
      onClick: () => this.callbacks.onSpatialModeChange('bar3d'),
    });

    this.modeButtons.scatter3d = new xb.UIButton({
      label: 'Scatter',
      icon: 'scatter_plot',
      style: {flexGrow: 1},
      onClick: () => this.callbacks.onSpatialModeChange('scatter3d'),
    });

    this.modeButtons.ring3d = new xb.UIButton({
      label: '3D Ring',
      icon: 'donut_large',
      style: {flexGrow: 1},
      onClick: () => this.callbacks.onSpatialModeChange('ring3d'),
    });

    this.spatialCard = new xb.UICard({
      size: {width: 0.62, height: 'auto'},
      manipulation: true,
      edge: true,
      style: {
        flexDirection: 'column',
        gap: 12,
        padding: 18,
      },
      children: [
        this.cardTitleText,
        this.cardReadoutText,
        new xb.UIPanel({
          style: {width: '100%', flexDirection: 'row', gap: 8},
          children: [
            this.modeButtons.bar3d,
            this.modeButtons.scatter3d,
            this.modeButtons.ring3d,
          ],
        }),
        this.scaleLabelText,
        scaleSlider,
      ],
    });
    this.spatialCard.name = 'Spatial Data Inspector Card';
    this.spatialCard.position.set(1.05, 1.32, -1.55);
    this.spatialCard.rotation.y = -0.32;
    this.spatialCard.visible = false;
  }

  init(): void {
    const renderer = xb.core.renderer;
    const scene = xb.core.scene;

    if (renderer instanceof THREE.WebGLRenderer) {
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.1;
      renderer.setPixelRatio(
        this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2)
      );
      renderer.shadowMap.enabled = !this.isSoftwareGl;

      const pmrem = new THREE.PMREMGenerator(renderer);
      this.envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environment = this.envTexture;
      pmrem.dispose();

      // Skip all WebGL rendering when 3D view is hidden; throttle idle draws on software WebGL
      xb.core.renderSceneOverride = (r, s, c) => {
        if (!this.embeddedVisible && !this.xrOrSimActive) return;
        if (this.isSoftwareGl && this.dirtyFrames <= 0) return;
        if (this.dirtyFrames > 0) this.dirtyFrames--;
        if (r instanceof THREE.WebGLRenderer) {
          r.render(s, c);
        }
      };
    }

    scene.background = new THREE.Color(0x0f172a);
    scene.fog = new THREE.FogExp2(0x0f172a, 0.08);

    const hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x1e293b, 1.6);
    this.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xfff4e6, 2.2);
    keyLight.position.set(3.2, 5.0, 2.8);
    if (!this.isSoftwareGl) {
      keyLight.castShadow = true;
      keyLight.shadow.mapSize.set(1024, 1024);
      keyLight.shadow.bias = -0.0005;
    }
    this.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x60a5fa, 0.9);
    rimLight.position.set(-3.0, 2.5, -3.5);
    this.add(rimLight);

    this.stageRoot.position.set(0, 0.85, -1.55);
    this.add(this.stageRoot);
    this.stageRoot.add(this.pedestalGroup);
    this.stageRoot.add(this.dataGroup);

    this.buildPedestal();
    this.setupEmbeddedCameraAndControls();
    this.markDirty(8);
  }

  private setupEmbeddedCameraAndControls(): void {
    const renderer = xb.core.renderer;
    const camera = xb.core.camera;
    if (!(renderer instanceof THREE.WebGLRenderer) || !camera) return;

    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';

    camera.fov = 46;
    camera.position.set(1.88, 2.38, 0.72);
    camera.lookAt(0, 1.12, -1.55);
    camera.updateProjectionMatrix();

    this.orbitControls = new OrbitControls(camera, renderer.domElement);
    this.orbitControls.target.set(0, 1.12, -1.55);
    this.orbitControls.enableDamping = !this.isSoftwareGl;
    this.orbitControls.dampingFactor = 0.08;
    this.orbitControls.minDistance = 1.1;
    this.orbitControls.maxDistance = 4.8;
    this.orbitControls.maxPolarAngle = Math.PI * 0.48;
    this.orbitControls.addEventListener('change', () => this.markDirty(4));
    this.orbitControls.update();

    renderer.domElement.addEventListener('pointerdown', this.onPointerClickBound);
  }

  private buildPedestal(): void {
    const renderer = xb.core.renderer;
    const maxAniso =
      renderer instanceof THREE.WebGLRenderer
        ? renderer.capabilities.getMaxAnisotropy()
        : 4;

    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = 256;
    shadowCanvas.height = 256;
    const sctx = shadowCanvas.getContext('2d');
    if (sctx) {
      const grad = sctx.createRadialGradient(128, 128, 20, 128, 128, 126);
      grad.addColorStop(0, 'rgba(2, 6, 23, 0.65)');
      grad.addColorStop(0.65, 'rgba(2, 6, 23, 0.25)');
      grad.addColorStop(1, 'rgba(2, 6, 23, 0)');
      sctx.fillStyle = grad;
      sctx.fillRect(0, 0, 256, 256);
    }
    this.shadowTexture = new THREE.CanvasTexture(shadowCanvas);

    const shadowGeo = new THREE.CircleGeometry(1.45, 36);
    const shadowMat = new THREE.MeshBasicMaterial({
      map: this.shadowTexture,
      transparent: true,
      depthWrite: false,
    });
    this.pedestalGeos.push(shadowGeo);
    this.pedestalMats.push(shadowMat);

    const contactShadow = new THREE.Mesh(shadowGeo, shadowMat);
    contactShadow.rotation.x = -Math.PI / 2;
    contactShadow.position.y = -0.095;
    contactShadow.xb = {pointerEvents: 'none'};

    const plinthGeo = new THREE.BoxGeometry(1.86, 0.09, 1.36);
    const plinthMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.78,
      metalness: 0.12,
    });
    this.pedestalGeos.push(plinthGeo);
    this.pedestalMats.push(plinthMat);

    const plinth = new THREE.Mesh(plinthGeo, plinthMat);
    plinth.position.y = -0.05;
    plinth.receiveShadow = !this.isSoftwareGl;
    plinth.xb = {pointerEvents: 'none'};

    const trimGeo = new THREE.BoxGeometry(1.9, 0.024, 1.4);
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0x64748b,
      roughness: 0.28,
      metalness: 0.78,
    });
    this.pedestalGeos.push(trimGeo);
    this.pedestalMats.push(trimMat);

    const trim = new THREE.Mesh(trimGeo, trimMat);
    trim.position.y = -0.008;
    trim.xb = {pointerEvents: 'none'};

    const gridCanvas = document.createElement('canvas');
    gridCanvas.width = 512;
    gridCanvas.height = 512;
    const gctx = gridCanvas.getContext('2d');
    if (gctx) {
      gctx.fillStyle = '#0f172a';
      gctx.fillRect(0, 0, 512, 512);

      gctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
      gctx.lineWidth = 1;
      for (let i = 0; i <= 16; i++) {
        const p = (i / 16) * 512;
        gctx.beginPath();
        gctx.moveTo(p, 0);
        gctx.lineTo(p, 512);
        gctx.stroke();

        gctx.beginPath();
        gctx.moveTo(0, p);
        gctx.lineTo(512, p);
        gctx.stroke();
      }

      gctx.strokeStyle = 'rgba(59, 130, 246, 0.55)';
      gctx.lineWidth = 2;
      gctx.strokeRect(4, 4, 504, 504);
    }

    this.gridTexture = new THREE.CanvasTexture(gridCanvas);
    this.gridTexture.colorSpace = THREE.SRGBColorSpace;
    this.gridTexture.anisotropy = maxAniso;

    const deckGeo = new THREE.BoxGeometry(1.76, 0.014, 1.26);
    const deckMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: this.gridTexture,
      roughness: 0.42,
      metalness: 0.15,
    });
    this.pedestalGeos.push(deckGeo);
    this.pedestalMats.push(deckMat);

    const deck = new THREE.Mesh(deckGeo, deckMat);
    deck.position.y = 0.008;
    deck.receiveShadow = !this.isSoftwareGl;
    deck.xb = {pointerEvents: 'none'};

    const postGeo = new THREE.CylinderGeometry(0.012, 0.015, 0.09, 12);
    const postMat = new THREE.MeshStandardMaterial({
      color: 0x94a3b8,
      roughness: 0.22,
      metalness: 0.82,
    });
    this.pedestalGeos.push(postGeo);
    this.pedestalMats.push(postMat);

    const corners: [number, number][] = [
      [-0.86, -0.61],
      [0.86, -0.61],
      [-0.86, 0.61],
      [0.86, 0.61],
    ];
    for (const [cx, cz] of corners) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(cx, 0.04, cz);
      post.xb = {pointerEvents: 'none'};
      this.pedestalGroup.add(post);
    }

    this.pedestalGroup.add(contactShadow, plinth, trim, deck);
  }

  public setEmbeddedVisible(visible: boolean): void {
    const becameVisible = !this.embeddedVisible && visible;
    this.embeddedVisible = visible;
    if (visible) {
      if (this.pendingMeshSync || becameVisible) {
        this.flushPendingSync();
      }
      this.markDirty(12);
    }
  }

  public resizeToContainer(width: number, height: number): void {
    const renderer = xb.core.renderer;
    const camera = xb.core.camera;
    if (!renderer || !camera || width <= 0 || height <= 0) return;

    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    if (renderer instanceof THREE.WebGLRenderer) {
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
    }
    this.markDirty(8);
  }

  public setData(params: {
    sheet: SheetData;
    visibleRowIndices: VisibleRowsSource;
    config: ChartConfig;
    highlightedRowIndex: number | null;
  }): void {
    const meshKey = `${params.sheet.id}|${params.sheet.rows.length}|${params.visibleRowIndices.length}|${params.config.xColIndex}|${params.config.yColIndices.join(',')}|${params.config.spatialMode}|${this.heightScale.toFixed(2)}`;
    const dataChanged =
      this.sheet !== params.sheet ||
      this.visibleRowIndices !== params.visibleRowIndices ||
      meshKey !== this.lastMeshKey;

    this.sheet = params.sheet;
    this.visibleRowIndices = params.visibleRowIndices;
    this.config = params.config;
    this.highlightedRowIndex = params.highlightedRowIndex;

    this.cardTitleText.text = params.sheet.name;
    this.updateSpatialReadout();

    if (dataChanged) {
      this.lastMeshKey = meshKey;
      this.requestMeshSync();
    } else {
      this.applyHighlightStyles();
    }
  }

  /** Fast highlight-only update (zero mesh rebuild or height reset). */
  public setHighlight(highlightedRowIndex: number | null): void {
    if (this.highlightedRowIndex === highlightedRowIndex) return;
    this.highlightedRowIndex = highlightedRowIndex;
    this.updateSpatialReadout();
    if (this.embeddedVisible || this.xrOrSimActive) {
      this.applyHighlightStyles();
      this.markDirty(6);
    }
  }

  private requestMeshSync(): void {
    if (!this.embeddedVisible && !this.xrOrSimActive) {
      this.pendingMeshSync = true;
      return;
    }
    this.flushPendingSync();
  }

  private flushPendingSync(): void {
    this.pendingMeshSync = false;
    this.syncChartNodes();
    this.markDirty(30);
  }

  private updateSpatialReadout(): void {
    if (!this.sheet) return;
    if (this.highlightedRowIndex !== null) {
      const row = this.sheet.rows[this.highlightedRowIndex] ?? [];
      const xLabel =
        row[this.config.xColIndex] ?? `Row ${this.highlightedRowIndex + 1}`;
      const metrics = this.config.yColIndices
        .map((cIdx) => {
          const name = this.sheet!.columns[cIdx] ?? '';
          const val = row[cIdx] ?? '0';
          return `${name}: ${val}`;
        })
        .join('\n');
      this.cardReadoutText.text = `Selected: ${xLabel}\n${metrics}`;
    } else {
      this.cardReadoutText.text = `${this.visibleRowIndices.length.toLocaleString('en-US')} rows · Tap a 3D bar for details.`;
    }
  }

  private getOrAcquirePoolEntry(index: number): BarNodeEntry {
    if (index < this.barPool.length) {
      const existing = this.barPool[index];
      existing.group.visible = true;
      return existing;
    }

    const group = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x2563eb,
      roughness: 0.32,
      metalness: 0.2,
      emissive: 0x000000,
      emissiveIntensity: 0,
    });
    const capMat = new THREE.MeshStandardMaterial({
      color: 0x60a5fa,
      roughness: 0.15,
      metalness: 0.45,
    });

    const bodyMesh = new THREE.Mesh(this.sharedBarGeo, bodyMat);
    bodyMesh.castShadow = !this.isSoftwareGl;
    bodyMesh.receiveShadow = !this.isSoftwareGl;

    const capMesh = new THREE.Mesh(this.sharedCapGeo, capMat);
    capMesh.castShadow = !this.isSoftwareGl;

    group.xb = {interactionEnabled: true};
    group.add(bodyMesh, capMesh);
    this.dataGroup.add(group);

    const entry: BarNodeEntry = {
      group,
      bodyMesh,
      capMesh,
      bodyMat,
      capMat,
      rowIndex: 0,
      seriesIndex: 0,
      targetHeight: 0.02,
      currentHeight: 0.02,
      baseColor: new THREE.Color(0x2563eb),
      isSphere: false,
    };
    this.barPool.push(entry);
    return entry;
  }

  private configurePoolEntry(
    idx: number,
    opts: {
      rowIndex: number;
      seriesIndex: number;
      height: number;
      width: number;
      depth: number;
      px: number;
      py: number;
      pz: number;
      colorHex: string;
      isSphere: boolean;
    }
  ): void {
    const entry = this.getOrAcquirePoolEntry(idx);
    const prevSphere = entry.isSphere;
    entry.isSphere = opts.isSphere;
    entry.rowIndex = opts.rowIndex;
    entry.seriesIndex = opts.seriesIndex;
    entry.targetHeight = opts.height;
    entry.baseColor.set(opts.colorHex);

    if (prevSphere !== opts.isSphere) {
      entry.bodyMesh.geometry = opts.isSphere
        ? this.sharedStemGeo
        : this.sharedBarGeo;
      entry.capMesh.geometry = opts.isSphere
        ? this.sharedSphereGeo
        : this.sharedCapGeo;
    }

    entry.group.position.set(opts.px, opts.py, opts.pz);
    entry.bodyMesh.scale.set(
      opts.isSphere ? 0.14 : opts.width,
      entry.currentHeight,
      opts.isSphere ? 0.14 : opts.depth
    );
    entry.capMesh.scale.set(
      opts.width,
      opts.isSphere ? opts.width : 0.02,
      opts.depth
    );

    entry.bodyMesh.userData.rowIndex = opts.rowIndex;
    entry.capMesh.userData.rowIndex = opts.rowIndex;
    entry.group.userData.rowIndex = opts.rowIndex;
  }

  private syncChartNodes(): void {
    if (!this.sheet) {
      this.hideUnusedPoolEntries(0);
      return;
    }

    const rows = sampleChartIndices(this.visibleRowIndices, 16);
    const yCols = this.config.yColIndices;
    if (rows.length === 0 || yCols.length === 0) {
      this.hideUnusedPoolEntries(0);
      return;
    }

    let maxVal = 1;
    const matrix: number[][] = rows.map((rowIndex) =>
      yCols.map((colIdx) => {
        const v = Math.max(
          0,
          parseNumericValue(this.sheet!.rows[rowIndex]?.[colIdx] ?? '').value ?? 0
        );
        if (v > maxVal) maxVal = v;
        return v;
      })
    );

    const mode = this.config.spatialMode;
    const deckW = 1.56;
    const deckD = 1.04;
    const maxBarHeight = 0.85 * this.heightScale;
    let poolIdx = 0;

    if (mode === 'ring3d') {
      const radius = 0.44;
      const totalItems = rows.length;
      const arcStep = (Math.PI * 2) / Math.max(1, totalItems);
      const colSize = Math.min(
        0.11,
        (Math.PI * 2 * radius) / (totalItems * 2.2)
      );

      for (let rIdx = 0; rIdx < rows.length; rIdx++) {
        const rowIndex = rows[rIdx];
        const angle = rIdx * arcStep - Math.PI / 2;
        const val = matrix[rIdx][0] ?? 0;
        const h = Math.max(0.04, (val / maxVal) * maxBarHeight);
        this.configurePoolEntry(poolIdx++, {
          rowIndex,
          seriesIndex: 0,
          height: h,
          width: colSize,
          depth: colSize,
          px: Math.cos(angle) * radius,
          py: 0.015,
          pz: Math.sin(angle) * radius,
          colorHex: CHART_PALETTE[rIdx % CHART_PALETTE.length],
          isSphere: false,
        });
      }
    } else if (mode === 'scatter3d') {
      const xStep = rows.length > 1 ? deckW / (rows.length - 1) : 0;
      const zStep = yCols.length > 1 ? (deckD * 0.65) / (yCols.length - 1) : 0;

      for (let rIdx = 0; rIdx < rows.length; rIdx++) {
        const rowIndex = rows[rIdx];
        const px = rows.length > 1 ? -deckW / 2 + rIdx * xStep : 0;
        for (let sIdx = 0; sIdx < yCols.length; sIdx++) {
          const val = matrix[rIdx][sIdx] ?? 0;
          const h = Math.max(0.08, (val / maxVal) * maxBarHeight);
          const pz = yCols.length > 1 ? -deckD * 0.32 + sIdx * zStep : 0;
          this.configurePoolEntry(poolIdx++, {
            rowIndex,
            seriesIndex: sIdx,
            height: h,
            width: 0.085,
            depth: 0.085,
            px,
            py: 0.015,
            pz,
            colorHex: CHART_PALETTE[sIdx % CHART_PALETTE.length],
            isSphere: true,
          });
        }
      }
    } else {
      const xStep = deckW / Math.max(1, rows.length);
      const zStep = deckD / Math.max(1, yCols.length);
      const barW = Math.min(0.14, xStep * 0.64);
      const barD = Math.min(0.18, zStep * 0.64);

      for (let rIdx = 0; rIdx < rows.length; rIdx++) {
        const rowIndex = rows[rIdx];
        const px = -deckW / 2 + (rIdx + 0.5) * xStep;
        for (let sIdx = 0; sIdx < yCols.length; sIdx++) {
          const val = matrix[rIdx][sIdx] ?? 0;
          const h = Math.max(0.035, (val / maxVal) * maxBarHeight);
          const pz = -deckD / 2 + (sIdx + 0.5) * zStep;
          this.configurePoolEntry(poolIdx++, {
            rowIndex,
            seriesIndex: sIdx,
            height: h,
            width: barW,
            depth: barD,
            px,
            py: 0.015,
            pz,
            colorHex: CHART_PALETTE[sIdx % CHART_PALETTE.length],
            isSphere: false,
          });
        }
      }
    }

    this.hideUnusedPoolEntries(poolIdx);
    this.applyHighlightStyles();
  }

  private hideUnusedPoolEntries(activeCount: number): void {
    this.activeBarCount = activeCount;
    this.pickTargetsCache.length = 0;
    for (let i = 0; i < this.barPool.length; i++) {
      const entry = this.barPool[i];
      if (i < activeCount) {
        entry.group.visible = true;
        this.pickTargetsCache.push(entry.bodyMesh, entry.capMesh);
      } else {
        entry.group.visible = false;
      }
    }
  }

  private applyHighlightStyles(): void {
    for (let i = 0; i < this.activeBarCount; i++) {
      const entry = this.barPool[i];
      const isSel = this.highlightedRowIndex === entry.rowIndex;

      entry.bodyMat.color.copy(entry.baseColor);
      entry.bodyMat.roughness = isSel ? 0.18 : 0.32;
      entry.bodyMat.emissive.copy(isSel ? entry.baseColor : BLACK_COLOR);
      entry.bodyMat.emissiveIntensity = isSel ? 0.35 : 0;

      if (isSel) {
        entry.capMat.color.copy(WHITE_COLOR);
      } else {
        entry.capMat.color.copy(entry.baseColor).offsetHSL(0, 0, 0.14);
      }
    }
  }

  private handleCanvasClick(event: PointerEvent): void {
    if (this.xrOrSimActive) return;
    const renderer = xb.core.renderer;
    const camera = xb.core.camera;
    if (!(renderer instanceof THREE.WebGLRenderer) || !camera) return;

    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, camera);
    const hits = this.raycaster.intersectObjects(this.pickTargetsCache, false);
    if (hits.length > 0) {
      const rowIndex = hits[0].object.userData?.rowIndex;
      if (typeof rowIndex === 'number') {
        this.callbacks.onRowSelect(rowIndex);
      }
    }
  }

  onObjectSelectStart(event: xb.SelectEvent): void {
    const target = event.target as THREE.Object3D | undefined;
    const rowIndex = target?.userData?.rowIndex;
    if (typeof rowIndex === 'number') {
      this.callbacks.onRowSelect(rowIndex);
      event.stopPropagation();
    }
  }

  onSimulatorStarted(): void {
    this.xrOrSimActive = true;
    this.spatialCard.visible = true;
    if (!this.spatialCard.parent) {
      this.add(this.spatialCard);
    }
    if (this.orbitControls) {
      this.orbitControls.enabled = false;
    }
    if (this.pendingMeshSync) {
      this.flushPendingSync();
    }
    this.markDirty(20);
  }

  onXRSessionStarted(): void {
    this.xrOrSimActive = true;
    this.spatialCard.visible = true;
    if (!this.spatialCard.parent) {
      this.add(this.spatialCard);
    }
    if (this.orbitControls) {
      this.orbitControls.enabled = false;
    }
    if (this.pendingMeshSync) {
      this.flushPendingSync();
    }
    this.markDirty(20);
  }

  onXRSessionEnded(): void {
    this.xrOrSimActive = false;
    this.spatialCard.visible = false;
    this.spatialCard.removeFromParent();
    if (this.orbitControls) {
      this.orbitControls.enabled = true;
    }
    this.markDirty(10);
  }

  update(): void {
    if (!this.embeddedVisible && !this.xrOrSimActive) return;

    const dt = Math.min(0.05, Math.max(0.001, xb.getDeltaTime()));
    let moving = false;

    for (let i = 0; i < this.activeBarCount; i++) {
      const entry = this.barPool[i];
      const diff = Math.abs(entry.currentHeight - entry.targetHeight);
      if (diff > 0.001) {
        entry.currentHeight = THREE.MathUtils.damp(
          entry.currentHeight,
          entry.targetHeight,
          10,
          dt
        );
        moving = true;
      } else {
        entry.currentHeight = entry.targetHeight;
      }

      if (entry.isSphere) {
        entry.bodyMesh.scale.y = entry.currentHeight;
        entry.bodyMesh.position.y = entry.currentHeight * 0.5;
        entry.capMesh.position.y = entry.currentHeight;
      } else {
        entry.bodyMesh.scale.y = entry.currentHeight;
        entry.bodyMesh.position.y = entry.currentHeight * 0.5;
        entry.capMesh.position.y = entry.currentHeight + 0.01;
      }
    }

    if (this.orbitControls && this.orbitControls.enabled) {
      this.orbitControls.update();
    }

    if (moving) {
      this.markDirty(2);
    }
  }

  private markDirty(frames: number): void {
    this.dirtyFrames = Math.max(this.dirtyFrames, frames);
  }

  dispose(): void {
    for (const entry of this.barPool) {
      entry.bodyMat.dispose();
      entry.capMat.dispose();
    }
    this.barPool = [];
    this.pickTargetsCache = [];
    this.activeBarCount = 0;

    for (const g of this.pedestalGeos) g.dispose();
    for (const m of this.pedestalMats) m.dispose();
    this.pedestalGeos = [];
    this.pedestalMats = [];

    this.sharedBarGeo.dispose();
    this.sharedCapGeo.dispose();
    this.sharedSphereGeo.dispose();
    this.sharedStemGeo.dispose();
    this.gridTexture?.dispose();
    this.shadowTexture?.dispose();
    this.envTexture?.dispose();
    this.orbitControls?.dispose();

    const renderer = xb.core.renderer;
    if (renderer instanceof THREE.WebGLRenderer) {
      renderer.domElement.removeEventListener(
        'pointerdown',
        this.onPointerClickBound
      );
    }
  }
}
