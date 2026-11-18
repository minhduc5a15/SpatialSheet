import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import * as xb from 'xrblocks';
import type {
  DerivedSpatialDataset,
  SpatialChartMode,
  SpatialDataItem,
  SpatialEnvironmentMode,
} from '../types';
import {
  AxisSystem3D,
  PLOT_BOTTOM_Y,
  PLOT_DEPTH,
  PLOT_HEIGHT,
  PLOT_WIDTH,
  normXToWorld,
  normYToWorld,
  normZToWorld,
} from './AxisSystem3D';

export interface SpatialStageCallbacks {
  onItemSelect: (item: SpatialDataItem | null) => void;
  onItemHover: (
    item: SpatialDataItem | null,
    clientX: number,
    clientY: number
  ) => void;
  onSpatialModeChange: (mode: SpatialChartMode) => void;
}

interface BarNodeEntry {
  group: THREE.Group;
  bodyMesh: THREE.Mesh;
  capMesh: THREE.Mesh;
  bodyMat: THREE.MeshStandardMaterial;
  capMat: THREE.MeshStandardMaterial;
  itemIndex: number;
  baseColor: THREE.Color;
  zeroWorldY: number;
  targetSignedH: number;
  currentSignedH: number;
  barWidth: number;
  barDepth: number;
}

interface RingMeshEntry {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
  itemIndex: number;
  baseColor: THREE.Color;
}

const MAX_SCATTER_INSTANCES = 5000;
const BLACK_COLOR = new THREE.Color(0x000000);
const WHITE_COLOR = new THREE.Color(0xffffff);
const HOVER_COLOR = new THREE.Color(0x38bdf8);

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
  private axisSystem = new AxisSystem3D();

  // Bar pool
  private barPool: BarNodeEntry[] = [];
  private activeBarCount = 0;
  private barPickTargets: THREE.Object3D[] = [];

  // Scatter InstancedMesh (up to 5,000 points in 1 draw call)
  private scatterGeo = new THREE.SphereGeometry(0.022, 14, 10);
  private scatterMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.25,
    metalness: 0.15,
  });
  private scatterMesh: THREE.InstancedMesh;
  private scatterDummy = new THREE.Object3D();
  private scatterTempColor = new THREE.Color();

  // Selection / Hover indicator for Scatter points
  private haloGeo = new THREE.SphereGeometry(0.036, 16, 12);
  private haloMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    wireframe: true,
    transparent: true,
    opacity: 0.9,
  });
  private selectionHalo = new THREE.Mesh(this.haloGeo, this.haloMat);
  private dropLineGeo = new THREE.BufferGeometry();
  private dropLineMat = new THREE.LineBasicMaterial({
    color: 0x38bdf8,
    transparent: true,
    opacity: 0.75,
  });
  private dropLine: THREE.Line;

  // Ring sector meshes
  private ringEntries: RingMeshEntry[] = [];

  private sharedBarGeo = new THREE.BoxGeometry(1, 1, 1);
  private sharedCapGeo = new THREE.BoxGeometry(1.03, 0.014, 1.03);
  private pedestalGeos: THREE.BufferGeometry[] = [];
  private pedestalMats: THREE.Material[] = [];

  private gridTexture: THREE.CanvasTexture | null = null;
  private shadowTexture: THREE.CanvasTexture | null = null;
  private envTexture: THREE.Texture | null = null;
  private orbitControls: OrbitControls | null = null;

  private derived: DerivedSpatialDataset | null = null;
  private selectedItemId: number | null = null;
  private hoveredItemId: number | null = null;
  private highlightedRowIndex: number | null = null;
  private environmentMode: SpatialEnvironmentMode = 'clean';

  private embeddedVisible = false;
  private xrOrSimActive = false;
  private dirtyFrames = 15;
  private pendingMeshSync = false;
  private lastDerivedRef: DerivedSpatialDataset | null = null;

  // Built-in XR Blocks Spatial UI (used in XR / Simulator sessions)
  private spatialCard!: xb.UICard;
  private cardTitleText!: xb.UIText;
  private cardReadoutText!: xb.UIText;
  private modeButtons: Record<SpatialChartMode, xb.UIButton> = {} as Record<
    SpatialChartMode,
    xb.UIButton
  >;

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private pointerDownPos: {x: number; y: number} | null = null;
  private isOrbitDragging = false;
  private lastHoverCheckAt = 0;

  private onPointerDownBound = (e: PointerEvent) => this.handlePointerDown(e);
  private onPointerMoveBound = (e: PointerEvent) => this.handlePointerMove(e);
  private onPointerUpBound = (e: PointerEvent) => this.handlePointerUp(e);
  private onPointerLeaveBound = () => this.clearHover();

  constructor(callbacks: SpatialStageCallbacks) {
    super();
    this.callbacks = callbacks;

    this.scatterMesh = new THREE.InstancedMesh(
      this.scatterGeo,
      this.scatterMat,
      MAX_SCATTER_INSTANCES
    );
    this.scatterMesh.count = 0;
    this.scatterMesh.visible = false;
    this.scatterMesh.frustumCulled = false;
    this.scatterMesh.name = 'ScatterPointCloud';
    this.scatterMesh.xb = {interactionEnabled: true};

    this.selectionHalo.visible = false;
    this.selectionHalo.xb = {pointerEvents: 'none'};

    this.dropLineGeo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3)
    );
    this.dropLine = new THREE.Line(this.dropLineGeo, this.dropLineMat);
    this.dropLine.visible = false;
    this.dropLine.xb = {pointerEvents: 'none'};

    this.buildSpatialCard();
  }

  private buildSpatialCard(): void {
    this.cardTitleText = new xb.UIText({
      text: '3D Analytical Stage',
      style: {fontSize: 24, fontWeight: 'bold'},
    });

    this.cardReadoutText = new xb.UIText({
      text: 'Select a bar, scatter point, or ring slice to inspect values.',
      style: {
        fontSize: 15,
        lineHeight: 1.35,
        opacity: 0.9,
        whiteSpace: 'pre-line',
      },
    });

    this.modeButtons.bar3d = new xb.UIButton({
      label: '3D Bars',
      icon: 'bar_chart',
      style: {flexGrow: 1},
      onClick: () => this.callbacks.onSpatialModeChange('bar3d'),
    });

    this.modeButtons.scatter3d = new xb.UIButton({
      label: '3D Scatter',
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
      size: {width: 0.64, height: 'auto'},
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
      ],
    });
    this.spatialCard.name = 'Spatial Data Inspector Card';
    this.spatialCard.position.set(1.12, 1.36, -1.55);
    this.spatialCard.rotation.y = -0.32;
    this.spatialCard.visible = false;
  }

  init(): void {
    const renderer = xb.core.renderer;
    const scene = xb.core.scene;

    if (renderer instanceof THREE.WebGLRenderer) {
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.08;
      renderer.setPixelRatio(
        this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2)
      );
      renderer.shadowMap.enabled = !this.isSoftwareGl;

      const pmrem = new THREE.PMREMGenerator(renderer);
      this.envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environment = this.envTexture;
      pmrem.dispose();

      // Only render WebGL when 3D view is visible; pause idle draws on software WebGL
      xb.core.renderSceneOverride = (r, s, c) => {
        if (!this.embeddedVisible && !this.xrOrSimActive) return;
        if (this.isSoftwareGl && this.dirtyFrames <= 0) return;
        if (this.dirtyFrames > 0) this.dirtyFrames--;
        if (r instanceof THREE.WebGLRenderer) {
          r.render(s, c);
        }
      };
    }

    const hemiLight = new THREE.HemisphereLight(0xe2e8f0, 0x1e293b, 1.65);
    this.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xfff7ed, 2.0);
    keyLight.position.set(3.2, 5.0, 2.8);
    if (!this.isSoftwareGl) {
      keyLight.castShadow = true;
      keyLight.shadow.mapSize.set(1024, 1024);
      keyLight.shadow.bias = -0.0005;
    }
    this.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x60a5fa, 0.85);
    rimLight.position.set(-3.0, 2.5, -3.5);
    this.add(rimLight);

    this.stageRoot.position.set(0, 0.84, -1.55);
    this.add(this.stageRoot);
    this.stageRoot.add(this.pedestalGroup);
    this.stageRoot.add(this.axisSystem);
    this.stageRoot.add(this.dataGroup);
    this.dataGroup.add(this.scatterMesh, this.selectionHalo, this.dropLine);

    this.buildPedestal();
    this.applyEnvironmentMode();
    this.setupEmbeddedCameraAndControls();
    this.markDirty(12);
  }

  private setupEmbeddedCameraAndControls(): void {
    const renderer = xb.core.renderer;
    const camera = xb.core.camera;
    if (!(renderer instanceof THREE.WebGLRenderer) || !camera) return;

    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';

    camera.fov = 46;
    this.orbitControls = new OrbitControls(camera, renderer.domElement);
    this.orbitControls.enableDamping = !this.isSoftwareGl;
    this.orbitControls.dampingFactor = 0.08;
    this.orbitControls.minDistance = 1.05;
    this.orbitControls.maxDistance = 5.2;
    this.orbitControls.maxPolarAngle = Math.PI * 0.52;
    this.orbitControls.addEventListener('change', () => this.markDirty(4));

    this.resetCamera();

    const dom = renderer.domElement;
    dom.addEventListener('pointerdown', this.onPointerDownBound);
    dom.addEventListener('pointermove', this.onPointerMoveBound);
    dom.addEventListener('pointerup', this.onPointerUpBound);
    dom.addEventListener('pointerleave', this.onPointerLeaveBound);
  }

  public resetCamera(): void {
    const camera = xb.core.camera;
    if (!camera) return;
    camera.position.set(1.92, 2.28, 0.86);
    if (this.orbitControls) {
      this.orbitControls.target.set(0, 1.3, -1.55);
      this.orbitControls.update();
    } else {
      camera.lookAt(0, 1.3, -1.55);
    }
    camera.updateProjectionMatrix();
    this.markDirty(8);
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

    const shadowGeo = new THREE.CircleGeometry(1.48, 36);
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

    const plinthGeo = new THREE.BoxGeometry(1.96, 0.09, 1.44);
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

    const deckCanvas = document.createElement('canvas');
    deckCanvas.width = 512;
    deckCanvas.height = 512;
    const gctx = deckCanvas.getContext('2d');
    if (gctx) {
      gctx.fillStyle = '#0f172a';
      gctx.fillRect(0, 0, 512, 512);
      gctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
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
    }
    this.gridTexture = new THREE.CanvasTexture(deckCanvas);
    this.gridTexture.colorSpace = THREE.SRGBColorSpace;
    this.gridTexture.anisotropy = maxAniso;

    const deckGeo = new THREE.BoxGeometry(1.88, 0.014, 1.36);
    const deckMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: this.gridTexture,
      roughness: 0.48,
      metalness: 0.1,
    });
    this.pedestalGeos.push(deckGeo);
    this.pedestalMats.push(deckMat);

    const deck = new THREE.Mesh(deckGeo, deckMat);
    deck.position.y = 0.004;
    deck.receiveShadow = !this.isSoftwareGl;
    deck.xb = {pointerEvents: 'none'};

    this.pedestalGroup.add(contactShadow, plinth, deck);
  }

  private applyEnvironmentMode(): void {
    const scene = xb.core.scene;
    if (!scene) return;
    if (this.environmentMode === 'studio') {
      scene.background = new THREE.Color(0x0f172a);
      scene.fog = new THREE.FogExp2(0x0f172a, 0.075);
      this.pedestalGroup.visible = true;
    } else {
      scene.background = new THREE.Color(0x0b1120);
      scene.fog = null;
      this.pedestalGroup.visible = false;
    }
    this.markDirty(6);
  }

  public setEnvironmentMode(mode: SpatialEnvironmentMode): void {
    if (this.environmentMode === mode) return;
    this.environmentMode = mode;
    this.applyEnvironmentMode();
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

  public setDerivedData(params: {
    derived: DerivedSpatialDataset;
    selectedItem: SpatialDataItem | null;
    highlightedRowIndex: number | null;
    environmentMode: SpatialEnvironmentMode;
  }): void {
    const dataChanged = this.lastDerivedRef !== params.derived;
    this.derived = params.derived;
    this.selectedItemId = params.selectedItem?.id ?? null;
    this.highlightedRowIndex = params.highlightedRowIndex;

    if (this.environmentMode !== params.environmentMode) {
      this.environmentMode = params.environmentMode;
      this.applyEnvironmentMode();
    }

    this.updateSpatialReadout();

    if (dataChanged) {
      this.lastDerivedRef = params.derived;
      this.hoveredItemId = null;
      this.requestMeshSync();
    } else {
      this.applySelectionAndHoverStyles();
      this.markDirty(6);
    }
  }

  public setHighlight(
    selectedItem: SpatialDataItem | null,
    highlightedRowIndex: number | null
  ): void {
    const nextId = selectedItem?.id ?? null;
    if (
      this.selectedItemId === nextId &&
      this.highlightedRowIndex === highlightedRowIndex
    ) {
      return;
    }
    this.selectedItemId = nextId;
    this.highlightedRowIndex = highlightedRowIndex;
    this.updateSpatialReadout();
    if (this.embeddedVisible || this.xrOrSimActive) {
      this.applySelectionAndHoverStyles();
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
    this.syncVisualization();
    this.markDirty(30);
  }

  private updateSpatialReadout(): void {
    if (!this.derived) return;
    const d = this.derived;
    this.cardTitleText.text = `${d.axes.y.title} · ${d.mode.toUpperCase()}`;

    const selected =
      (this.selectedItemId !== null
        ? d.items.find((it) => it.id === this.selectedItemId)
        : null) ??
      (this.highlightedRowIndex !== null
        ? d.items.find(
            (it) =>
              it.firstRowIndex === this.highlightedRowIndex ||
              it.rowIndices.includes(this.highlightedRowIndex!)
          )
        : null);

    if (selected) {
      const unitSuffix = selected.yUnit ? ` ${selected.yUnit}` : '';
      this.cardReadoutText.text = `${selected.label} (${selected.seriesLabel})\nValue: ${selected.yValue.toLocaleString('en-US', {maximumFractionDigits: 3})}${unitSuffix} · Records: ${selected.recordCount.toLocaleString('en-US')}`;
    } else if (!d.isValid && d.validationMessage) {
      this.cardReadoutText.text = d.validationMessage;
    } else {
      this.cardReadoutText.text = d.dataStateSummary;
    }
  }

  private syncVisualization(): void {
    const derived = this.derived;
    if (!derived) return;

    this.axisSystem.updateFromDerived(derived);

    if (!derived.isValid || derived.items.length === 0) {
      this.hideAllDataVisuals();
      return;
    }

    if (derived.mode === 'scatter3d') {
      this.hideUnusedBars(0);
      this.disposeRingEntries();
      this.syncScatterInstances(derived);
    } else if (derived.mode === 'ring3d') {
      this.hideUnusedBars(0);
      this.scatterMesh.visible = false;
      this.scatterMesh.count = 0;
      this.selectionHalo.visible = false;
      this.dropLine.visible = false;
      this.syncRingSectors(derived);
    } else {
      this.scatterMesh.visible = false;
      this.scatterMesh.count = 0;
      this.selectionHalo.visible = false;
      this.dropLine.visible = false;
      this.disposeRingEntries();
      this.syncBars(derived);
    }

    this.applySelectionAndHoverStyles();
  }

  private hideAllDataVisuals(): void {
    this.hideUnusedBars(0);
    this.scatterMesh.visible = false;
    this.scatterMesh.count = 0;
    this.selectionHalo.visible = false;
    this.dropLine.visible = false;
    this.disposeRingEntries();
  }

  private getOrAcquireBarEntry(index: number): BarNodeEntry {
    if (index < this.barPool.length) {
      const existing = this.barPool[index];
      existing.group.visible = true;
      return existing;
    }

    const group = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x2563eb,
      roughness: 0.34,
      metalness: 0.16,
      emissive: 0x000000,
      emissiveIntensity: 0,
    });
    const capMat = new THREE.MeshStandardMaterial({
      color: 0x60a5fa,
      roughness: 0.18,
      metalness: 0.35,
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
      itemIndex: 0,
      baseColor: new THREE.Color(0x2563eb),
      zeroWorldY: PLOT_BOTTOM_Y,
      targetSignedH: 0.02,
      currentSignedH: 0.02,
      barWidth: 0.08,
      barDepth: 0.08,
    };
    this.barPool.push(entry);
    return entry;
  }

  private syncBars(derived: DerivedSpatialDataset): void {
    const items = derived.items;
    const xCount = Math.max(1, items[0]?.xBucketCount ?? items.length);
    const zCount = Math.max(1, items[0]?.zBucketCount ?? 1);
    const cellW = PLOT_WIDTH / xCount;
    const cellD = PLOT_DEPTH / zCount;
    const barW = Math.max(0.028, Math.min(0.15, cellW * 0.68));
    const barD = Math.max(0.04, Math.min(0.18, cellD * 0.64));

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const entry = this.getOrAcquireBarEntry(i);
      const px = normXToWorld(item.xNorm);
      const pz = normZToWorld(item.zNorm);
      const zeroY = normYToWorld(item.yZeroNorm);
      const valY = normYToWorld(item.yNorm);
      const signedH = valY - zeroY;
      // Preserve tiny visible nub for exact 0 values so zero bars remain clickable/inspectable
      const targetSignedH =
        Math.abs(signedH) < 0.01 ? (signedH < 0 ? -0.01 : 0.01) : signedH;

      entry.itemIndex = i;
      entry.baseColor.set(item.colorHex);
      entry.zeroWorldY = zeroY;
      entry.targetSignedH = targetSignedH;
      entry.barWidth = barW;
      entry.barDepth = barD;

      // Snap near-zero / inverted bars smoothly toward baseline
      if (Math.sign(entry.currentSignedH) !== Math.sign(targetSignedH)) {
        entry.currentSignedH = targetSignedH >= 0 ? 0.01 : -0.01;
      }

      entry.group.position.set(px, zeroY, pz);
      entry.bodyMesh.userData.itemId = item.id;
      entry.capMesh.userData.itemId = item.id;
      entry.group.userData.itemId = item.id;
      this.positionBarGeometry(entry);
    }

    this.hideUnusedBars(items.length);
  }

  private positionBarGeometry(entry: BarNodeEntry): void {
    const absH = Math.max(0.008, Math.abs(entry.currentSignedH));
    const sign = entry.currentSignedH >= 0 ? 1 : -1;

    entry.bodyMesh.scale.set(entry.barWidth, absH, entry.barDepth);
    entry.bodyMesh.position.y = sign * (absH * 0.5);

    entry.capMesh.scale.set(entry.barWidth, 1, entry.barDepth);
    entry.capMesh.position.y = sign * (absH + 0.008);
  }

  private hideUnusedBars(activeCount: number): void {
    this.activeBarCount = activeCount;
    this.barPickTargets.length = 0;
    for (let i = 0; i < this.barPool.length; i++) {
      const entry = this.barPool[i];
      if (i < activeCount) {
        entry.group.visible = true;
        this.barPickTargets.push(entry.bodyMesh, entry.capMesh);
      } else {
        entry.group.visible = false;
      }
    }
  }

  private syncScatterInstances(derived: DerivedSpatialDataset): void {
    const items = derived.items;
    const count = Math.min(items.length, MAX_SCATTER_INSTANCES);
    this.scatterMesh.count = count;
    this.scatterMesh.visible = count > 0;

    // Scale sphere radius slightly inversely with density so sparse clouds stay clear and dense clouds don't clump
    const scaleFactor = count > 1500 ? 0.58 : count > 400 ? 0.78 : 1.05;

    for (let i = 0; i < count; i++) {
      const item = items[i];
      this.scatterDummy.position.set(
        normXToWorld(item.xNorm),
        normYToWorld(item.yNorm),
        normZToWorld(item.zNorm)
      );
      this.scatterDummy.scale.setScalar(scaleFactor);
      this.scatterDummy.updateMatrix();
      this.scatterMesh.setMatrixAt(i, this.scatterDummy.matrix);

      this.scatterTempColor.set(item.colorHex);
      this.scatterMesh.setColorAt(i, this.scatterTempColor);
    }

    this.scatterMesh.instanceMatrix.needsUpdate = true;
    if (this.scatterMesh.instanceColor) {
      this.scatterMesh.instanceColor.needsUpdate = true;
    }
    this.scatterMesh.computeBoundingSphere();
  }

  private syncRingSectors(derived: DerivedSpatialDataset): void {
    this.disposeRingEntries();
    const innerR = 0.28;
    const outerR = 0.6;
    const gapAngle = derived.items.length > 1 ? 0.022 : 0;

    for (let i = 0; i < derived.items.length; i++) {
      const item = derived.items[i];
      if (item.angleStart === undefined || item.angleEnd === undefined) continue;

      const span = item.angleEnd - item.angleStart;
      const effectiveGap = Math.min(gapAngle, span * 0.25);
      const a0 = item.angleStart + effectiveGap * 0.5;
      const a1 = item.angleEnd - effectiveGap * 0.5;
      if (a1 <= a0) continue;

      const shape = new THREE.Shape();
      // Shape XY maps onto XZ when rotated -PI/2 around X (negate angle for right-handed XZ match)
      shape.absarc(0, 0, outerR, -a0, -a1, true);
      shape.lineTo(Math.cos(-a1) * innerR, Math.sin(-a1) * innerR);
      shape.absarc(0, 0, innerR, -a1, -a0, false);
      shape.closePath();

      const extrudeDepth = 0.06 + item.yNorm * 0.18;
      const geometry = new THREE.ExtrudeGeometry(shape, {
        depth: extrudeDepth,
        bevelEnabled: true,
        bevelThickness: 0.008,
        bevelSize: 0.008,
        bevelSegments: 2,
        curveSegments: 28,
      });
      geometry.rotateX(-Math.PI / 2);

      const baseColor = new THREE.Color(item.colorHex);
      const material = new THREE.MeshStandardMaterial({
        color: baseColor,
        roughness: 0.3,
        metalness: 0.18,
        emissive: 0x000000,
        emissiveIntensity: 0,
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.y = PLOT_BOTTOM_Y;
      mesh.castShadow = !this.isSoftwareGl;
      mesh.receiveShadow = !this.isSoftwareGl;
      mesh.userData.itemId = item.id;
      mesh.xb = {interactionEnabled: true};

      this.dataGroup.add(mesh);
      this.ringEntries.push({
        mesh,
        geometry,
        material,
        itemIndex: i,
        baseColor,
      });
    }
  }

  private disposeRingEntries(): void {
    for (const r of this.ringEntries) {
      r.mesh.removeFromParent();
      r.geometry.dispose();
      r.material.dispose();
    }
    this.ringEntries = [];
  }

  private isItemSelectedOrHighlighted(item: SpatialDataItem): boolean {
    if (this.selectedItemId !== null && item.id === this.selectedItemId) {
      return true;
    }
    if (
      this.highlightedRowIndex !== null &&
      (item.firstRowIndex === this.highlightedRowIndex ||
        item.rowIndices.includes(this.highlightedRowIndex))
    ) {
      return true;
    }
    return false;
  }

  private applySelectionAndHoverStyles(): void {
    const derived = this.derived;
    if (!derived) return;

    if (derived.mode === 'bar3d') {
      for (let i = 0; i < this.activeBarCount; i++) {
        const entry = this.barPool[i];
        const item = derived.items[entry.itemIndex];
        if (!item) continue;
        const isSel = this.isItemSelectedOrHighlighted(item);
        const isHover = this.hoveredItemId === item.id;

        entry.bodyMat.color.copy(entry.baseColor);
        entry.bodyMat.roughness = isSel || isHover ? 0.16 : 0.34;
        if (isSel) {
          entry.bodyMat.emissive.copy(entry.baseColor);
          entry.bodyMat.emissiveIntensity = 0.42;
          entry.capMat.color.copy(WHITE_COLOR);
        } else if (isHover) {
          entry.bodyMat.emissive.copy(HOVER_COLOR);
          entry.bodyMat.emissiveIntensity = 0.28;
          entry.capMat.color.copy(HOVER_COLOR);
        } else {
          entry.bodyMat.emissive.copy(BLACK_COLOR);
          entry.bodyMat.emissiveIntensity = 0;
          entry.capMat.color.copy(entry.baseColor).offsetHSL(0, 0, 0.14);
        }
      }
      return;
    }

    if (derived.mode === 'ring3d') {
      for (const r of this.ringEntries) {
        const item = derived.items[r.itemIndex];
        if (!item) continue;
        const isSel = this.isItemSelectedOrHighlighted(item);
        const isHover = this.hoveredItemId === item.id;
        r.material.emissive.copy(
          isSel ? r.baseColor : isHover ? HOVER_COLOR : BLACK_COLOR
        );
        r.material.emissiveIntensity = isSel ? 0.42 : isHover ? 0.25 : 0;
        r.mesh.position.y = PLOT_BOTTOM_Y + (isSel ? 0.032 : isHover ? 0.015 : 0);
      }
      return;
    }

    if (derived.mode === 'scatter3d') {
      const targetId = this.hoveredItemId ?? this.selectedItemId;
      const targetItem =
        (targetId !== null
          ? derived.items.find((it) => it.id === targetId)
          : null) ??
        (this.highlightedRowIndex !== null
          ? derived.items.find((it) => it.firstRowIndex === this.highlightedRowIndex)
          : null);

      if (targetItem) {
        const px = normXToWorld(targetItem.xNorm);
        const py = normYToWorld(targetItem.yNorm);
        const pz = normZToWorld(targetItem.zNorm);

        this.selectionHalo.position.set(px, py, pz);
        this.selectionHalo.visible = true;
        this.haloMat.color.set(
          this.hoveredItemId === targetItem.id ? 0x38bdf8 : 0xffffff
        );

        const posAttr = this.dropLineGeo.getAttribute(
          'position'
        ) as THREE.BufferAttribute;
        posAttr.setXYZ(0, px, PLOT_BOTTOM_Y, pz);
        posAttr.setXYZ(1, px, py, pz);
        posAttr.needsUpdate = true;
        this.dropLine.visible = true;
      } else {
        this.selectionHalo.visible = false;
        this.dropLine.visible = false;
      }
    }
  }

  private pickItemAtClientPos(
    clientX: number,
    clientY: number
  ): SpatialDataItem | null {
    const renderer = xb.core.renderer;
    const camera = xb.core.camera;
    const derived = this.derived;
    if (
      !(renderer instanceof THREE.WebGLRenderer) ||
      !camera ||
      !derived ||
      !derived.isValid
    ) {
      return null;
    }

    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, camera);

    if (derived.mode === 'scatter3d' && this.scatterMesh.visible) {
      const hits = this.raycaster.intersectObject(this.scatterMesh, false);
      if (hits.length > 0 && hits[0].instanceId !== undefined) {
        return derived.items[hits[0].instanceId] ?? null;
      }
      return null;
    }

    if (derived.mode === 'ring3d' && this.ringEntries.length > 0) {
      const meshes = this.ringEntries.map((r) => r.mesh);
      const hits = this.raycaster.intersectObjects(meshes, false);
      if (hits.length > 0) {
        const id = hits[0].object.userData?.itemId;
        if (typeof id === 'number') {
          return derived.items.find((it) => it.id === id) ?? null;
        }
      }
      return null;
    }

    if (this.barPickTargets.length > 0) {
      const hits = this.raycaster.intersectObjects(this.barPickTargets, false);
      if (hits.length > 0) {
        const id = hits[0].object.userData?.itemId;
        if (typeof id === 'number') {
          return derived.items.find((it) => it.id === id) ?? null;
        }
      }
    }

    return null;
  }

  private handlePointerDown(event: PointerEvent): void {
    if (this.xrOrSimActive) return;
    this.pointerDownPos = {x: event.clientX, y: event.clientY};
    this.isOrbitDragging = true;
  }

  private handlePointerMove(event: PointerEvent): void {
    if (this.xrOrSimActive || this.isOrbitDragging) return;
    const now = performance.now();
    if (now - this.lastHoverCheckAt < 28) return;
    this.lastHoverCheckAt = now;

    const item = this.pickItemAtClientPos(event.clientX, event.clientY);
    const nextHoverId = item?.id ?? null;
    if (nextHoverId !== this.hoveredItemId) {
      this.hoveredItemId = nextHoverId;
      this.applySelectionAndHoverStyles();
      this.markDirty(4);
    }

    const renderer = xb.core.renderer;
    if (renderer instanceof THREE.WebGLRenderer) {
      renderer.domElement.style.cursor = item ? 'pointer' : 'grab';
    }
    this.callbacks.onItemHover(item, event.clientX, event.clientY);
  }

  private handlePointerUp(event: PointerEvent): void {
    this.isOrbitDragging = false;
    if (this.xrOrSimActive || !this.pointerDownPos) return;
    const dx = event.clientX - this.pointerDownPos.x;
    const dy = event.clientY - this.pointerDownPos.y;
    this.pointerDownPos = null;

    // Ignore orbit camera drags (> 6px pointer travel)
    if (dx * dx + dy * dy > 36) return;

    const item = this.pickItemAtClientPos(event.clientX, event.clientY);
    this.callbacks.onItemSelect(item);
  }

  private clearHover(): void {
    this.isOrbitDragging = false;
    if (this.hoveredItemId !== null) {
      this.hoveredItemId = null;
      this.applySelectionAndHoverStyles();
      this.markDirty(4);
    }
    this.callbacks.onItemHover(null, 0, 0);
  }

  onObjectSelectStart(event: xb.SelectEvent): void {
    const derived = this.derived;
    if (!derived || !derived.isValid) return;

    const intersection = event.intersection;
    if (
      event.target === this.scatterMesh &&
      intersection?.instanceId !== undefined
    ) {
      const item = derived.items[intersection.instanceId] ?? null;
      if (item) {
        this.callbacks.onItemSelect(item);
        event.stopPropagation();
      }
      return;
    }

    const target = event.target as THREE.Object3D | undefined;
    const itemId = target?.userData?.itemId;
    if (typeof itemId === 'number') {
      const item = derived.items.find((it) => it.id === itemId) ?? null;
      if (item) {
        this.callbacks.onItemSelect(item);
        event.stopPropagation();
      }
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
      const diff = Math.abs(entry.currentSignedH - entry.targetSignedH);
      if (diff > 0.001) {
        entry.currentSignedH = THREE.MathUtils.damp(
          entry.currentSignedH,
          entry.targetSignedH,
          12,
          dt
        );
        this.positionBarGeometry(entry);
        moving = true;
      } else if (entry.currentSignedH !== entry.targetSignedH) {
        entry.currentSignedH = entry.targetSignedH;
        this.positionBarGeometry(entry);
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
    this.axisSystem.dispose();
    this.disposeRingEntries();

    for (const entry of this.barPool) {
      entry.bodyMat.dispose();
      entry.capMat.dispose();
    }
    this.barPool = [];
    this.barPickTargets = [];
    this.activeBarCount = 0;

    for (const g of this.pedestalGeos) g.dispose();
    for (const m of this.pedestalMats) m.dispose();
    this.pedestalGeos = [];
    this.pedestalMats = [];

    this.sharedBarGeo.dispose();
    this.sharedCapGeo.dispose();
    this.scatterGeo.dispose();
    this.scatterMat.dispose();
    this.haloGeo.dispose();
    this.haloMat.dispose();
    this.dropLineGeo.dispose();
    this.dropLineMat.dispose();
    this.gridTexture?.dispose();
    this.shadowTexture?.dispose();
    this.envTexture?.dispose();
    this.orbitControls?.dispose();

    const renderer = xb.core.renderer;
    if (renderer instanceof THREE.WebGLRenderer) {
      const dom = renderer.domElement;
      dom.removeEventListener('pointerdown', this.onPointerDownBound);
      dom.removeEventListener('pointermove', this.onPointerMoveBound);
      dom.removeEventListener('pointerup', this.onPointerUpBound);
      dom.removeEventListener('pointerleave', this.onPointerLeaveBound);
    }
  }
}
