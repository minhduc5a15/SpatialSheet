import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import * as xb from 'xrblocks';
import type {ChartConfig, SheetData, SpatialChartMode} from '../types';
import {
  CHART_PALETTE,
  formatDisplayNumber,
  parseNumericValue,
} from '../core/tabular';

export interface SpatialStageCallbacks {
  onRowSelect: (rowIndex: number) => void;
  onSpatialModeChange: (mode: SpatialChartMode) => void;
}

interface BarNodeEntry {
  group: THREE.Group;
  bodyMesh: THREE.Mesh;
  capMesh: THREE.Mesh;
  hitMesh: THREE.Mesh;
  rowIndex: number;
  seriesIndex: number;
  label: string;
  seriesName: string;
  formattedValue: string;
  targetHeight: number;
  currentHeight: number;
  targetPos: THREE.Vector3;
  baseColor: THREE.Color;
}

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
  private bars: BarNodeEntry[] = [];
  private sharedBarGeo = new THREE.BoxGeometry(1, 1, 1);
  private sharedCapGeo = new THREE.BoxGeometry(1.04, 0.06, 1.04);
  private sharedSphereGeo = new THREE.SphereGeometry(0.5, 20, 14);
  private sharedStemGeo = new THREE.CylinderGeometry(0.08, 0.08, 1, 10);
  private gridTexture: THREE.CanvasTexture | null = null;
  private shadowTexture: THREE.CanvasTexture | null = null;
  private envTexture: THREE.Texture | null = null;
  private orbitControls: OrbitControls | null = null;

  private sheet: SheetData | null = null;
  private visibleRowIndices: number[] = [];
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
        this.rebuildChartMeshes();
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
    this.spatialCard.visible = false; // Shown inside XR / Simulator mode
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

      // Throttle software WebGL renders when idle or hidden
      if (this.isSoftwareGl) {
        xb.core.renderSceneOverride = (r, s, c) => {
          if (!this.embeddedVisible && !this.xrOrSimActive) return;
          if (this.dirtyFrames <= 0) return;
          this.dirtyFrames--;
          if (r instanceof THREE.WebGLRenderer) {
            r.render(s, c);
          }
        };
      }
    }

    scene.background = new THREE.Color(0x0f172a);
    scene.fog = new THREE.FogExp2(0x0f172a, 0.08);

    // Three-point studio lighting (warm key + cool hemisphere fill + rim)
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

    // Stage diorama positioning in front of XR user
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
    camera.position.set(1.55, 2.22, 0.32);
    camera.lookAt(0, 1.16, -1.55);
    camera.updateProjectionMatrix();

    this.orbitControls = new OrbitControls(camera, renderer.domElement);
    this.orbitControls.target.set(0, 1.16, -1.55);
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

    // 1. Soft radial contact shadow beneath plinth
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
    const contactShadow = new THREE.Mesh(
      new THREE.CircleGeometry(1.45, 36),
      new THREE.MeshBasicMaterial({
        map: this.shadowTexture,
        transparent: true,
        depthWrite: false,
      })
    );
    contactShadow.rotation.x = -Math.PI / 2;
    contactShadow.position.y = -0.095;
    contactShadow.xb = {pointerEvents: 'none'};

    // 2. Primary dark slate plinth (matte)
    const plinth = new THREE.Mesh(
      new THREE.BoxGeometry(1.86, 0.09, 1.36),
      new THREE.MeshStandardMaterial({
        color: 0x1e293b,
        roughness: 0.78,
        metalness: 0.12,
      })
    );
    plinth.position.y = -0.05;
    plinth.receiveShadow = !this.isSoftwareGl;
    plinth.xb = {pointerEvents: 'none'};

    // 3. Brushed metallic bevel trim rim
    const trim = new THREE.Mesh(
      new THREE.BoxGeometry(1.9, 0.024, 1.4),
      new THREE.MeshStandardMaterial({
        color: 0x64748b,
        roughness: 0.28,
        metalness: 0.78,
      })
    );
    trim.position.y = -0.008;
    trim.xb = {pointerEvents: 'none'};

    // 4. Procedural calibrated grid deck
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

    const deck = new THREE.Mesh(
      new THREE.BoxGeometry(1.76, 0.014, 1.26),
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: this.gridTexture,
        roughness: 0.42,
        metalness: 0.15,
      })
    );
    deck.position.y = 0.008;
    deck.receiveShadow = !this.isSoftwareGl;
    deck.xb = {pointerEvents: 'none'};

    // 5. Four corner calibration posts
    const postGeo = new THREE.CylinderGeometry(0.012, 0.015, 0.09, 12);
    const postMat = new THREE.MeshStandardMaterial({
      color: 0x94a3b8,
      roughness: 0.22,
      metalness: 0.82,
    });
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
    this.embeddedVisible = visible;
    if (visible) {
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
    visibleRowIndices: number[];
    config: ChartConfig;
    highlightedRowIndex: number | null;
  }): void {
    this.sheet = params.sheet;
    this.visibleRowIndices = params.visibleRowIndices;
    this.config = params.config;
    this.highlightedRowIndex = params.highlightedRowIndex;

    this.cardTitleText.text = params.sheet.name;
    this.updateSpatialReadout();
    this.rebuildChartMeshes();
    this.markDirty(35);
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
      this.cardReadoutText.text = `${this.visibleRowIndices.length} rows · Tap a 3D bar for details.`;
    }
  }

  private clearDataGroup(): void {
    for (const entry of this.bars) {
      if (entry.bodyMesh.material instanceof THREE.Material) {
        entry.bodyMesh.material.dispose();
      }
      if (entry.capMesh.material instanceof THREE.Material) {
        entry.capMesh.material.dispose();
      }
    }
    this.bars = [];
    while (this.dataGroup.children.length > 0) {
      this.dataGroup.remove(this.dataGroup.children[0]);
    }
  }

  private rebuildChartMeshes(): void {
    this.clearDataGroup();
    if (!this.sheet) return;

    const rows = this.visibleRowIndices.slice(0, 16);
    const yCols = this.config.yColIndices;
    if (rows.length === 0 || yCols.length === 0) return;

    // Collect numeric values & global max
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

    if (mode === 'ring3d') {
      const radius = 0.44;
      const totalItems = rows.length;
      const arcStep = (Math.PI * 2) / Math.max(1, totalItems);
      const colSize = Math.min(0.11, (Math.PI * 2 * radius) / (totalItems * 2.2));

      rows.forEach((rowIndex, rIdx) => {
        const angle = rIdx * arcStep - Math.PI / 2;
        const val = matrix[rIdx][0] ?? 0;
        const h = Math.max(0.04, (val / maxVal) * maxBarHeight);
        const px = Math.cos(angle) * radius;
        const pz = Math.sin(angle) * radius;
        const colorHex = CHART_PALETTE[rIdx % CHART_PALETTE.length];
        const yColIdx = yCols[0];

        this.createNode({
          rowIndex,
          seriesIndex: 0,
          colIdx: yColIdx,
          val,
          height: h,
          width: colSize,
          depth: colSize,
          pos: new THREE.Vector3(px, 0.015, pz),
          colorHex,
          isSphere: false,
        });
      });
    } else if (mode === 'scatter3d') {
      const xStep = rows.length > 1 ? deckW / (rows.length - 1) : 0;
      const zStep = yCols.length > 1 ? (deckD * 0.65) / (yCols.length - 1) : 0;

      rows.forEach((rowIndex, rIdx) => {
        const px = rows.length > 1 ? -deckW / 2 + rIdx * xStep : 0;
        yCols.forEach((yColIdx, sIdx) => {
          const val = matrix[rIdx][sIdx] ?? 0;
          const h = Math.max(0.08, (val / maxVal) * maxBarHeight);
          const pz = yCols.length > 1 ? -deckD * 0.32 + sIdx * zStep : 0;
          const colorHex = CHART_PALETTE[sIdx % CHART_PALETTE.length];

          this.createNode({
            rowIndex,
            seriesIndex: sIdx,
            colIdx: yColIdx,
            val,
            height: h,
            width: 0.085,
            depth: 0.085,
            pos: new THREE.Vector3(px, 0.015, pz),
            colorHex,
            isSphere: true,
          });
        });
      });
    } else {
      // bar3d
      const xStep = deckW / Math.max(1, rows.length);
      const zStep = deckD / Math.max(1, yCols.length);
      const barW = Math.min(0.14, xStep * 0.64);
      const barD = Math.min(0.18, zStep * 0.64);

      rows.forEach((rowIndex, rIdx) => {
        const px = -deckW / 2 + (rIdx + 0.5) * xStep;
        yCols.forEach((yColIdx, sIdx) => {
          const val = matrix[rIdx][sIdx] ?? 0;
          const h = Math.max(0.035, (val / maxVal) * maxBarHeight);
          const pz = -deckD / 2 + (sIdx + 0.5) * zStep;
          const colorHex = CHART_PALETTE[sIdx % CHART_PALETTE.length];

          this.createNode({
            rowIndex,
            seriesIndex: sIdx,
            colIdx: yColIdx,
            val,
            height: h,
            width: barW,
            depth: barD,
            pos: new THREE.Vector3(px, 0.015, pz),
            colorHex,
            isSphere: false,
          });
        });
      });
    }
  }

  private createNode(opts: {
    rowIndex: number;
    seriesIndex: number;
    colIdx: number;
    val: number;
    height: number;
    width: number;
    depth: number;
    pos: THREE.Vector3;
    colorHex: string;
    isSphere: boolean;
  }): void {
    const isSel = this.highlightedRowIndex === opts.rowIndex;
    const baseColor = new THREE.Color(opts.colorHex);
    const label =
      this.sheet?.rows[opts.rowIndex]?.[this.config.xColIndex] ??
      `Row ${opts.rowIndex + 1}`;
    const seriesName = this.sheet?.columns[opts.colIdx] ?? '';
    const colType = this.sheet?.types[opts.colIdx] ?? 'number';
    const formattedValue = formatDisplayNumber(opts.val, colType);

    const group = new THREE.Group();
    group.position.copy(opts.pos);

    const bodyMat = new THREE.MeshStandardMaterial({
      color: baseColor,
      roughness: isSel ? 0.18 : 0.32,
      metalness: 0.2,
      emissive: isSel ? baseColor : new THREE.Color(0x000000),
      emissiveIntensity: isSel ? 0.35 : 0,
    });

    const capMat = new THREE.MeshStandardMaterial({
      color: isSel ? 0xffffff : baseColor.clone().offsetHSL(0, 0, 0.14),
      roughness: 0.15,
      metalness: 0.45,
    });

    const bodyMesh = new THREE.Mesh(
      opts.isSphere ? this.sharedStemGeo : this.sharedBarGeo,
      bodyMat
    );
    bodyMesh.scale.set(
      opts.isSphere ? 0.14 : opts.width,
      0.02,
      opts.isSphere ? 0.14 : opts.depth
    );
    bodyMesh.position.y = 0.01;
    bodyMesh.castShadow = !this.isSoftwareGl;
    bodyMesh.receiveShadow = !this.isSoftwareGl;

    const capMesh = new THREE.Mesh(
      opts.isSphere ? this.sharedSphereGeo : this.sharedCapGeo,
      capMat
    );
    capMesh.scale.set(opts.width, opts.isSphere ? opts.width : 0.02, opts.depth);
    capMesh.position.y = 0.02;
    capMesh.castShadow = !this.isSoftwareGl;

    // Attach metadata for XR & desktop picking
    bodyMesh.userData = {rowIndex: opts.rowIndex};
    capMesh.userData = {rowIndex: opts.rowIndex};
    group.userData = {rowIndex: opts.rowIndex};
    group.xb = {interactionEnabled: true};

    group.add(bodyMesh, capMesh);
    this.dataGroup.add(group);

    this.bars.push({
      group,
      bodyMesh,
      capMesh,
      hitMesh: opts.isSphere ? capMesh : bodyMesh,
      rowIndex: opts.rowIndex,
      seriesIndex: opts.seriesIndex,
      label,
      seriesName,
      formattedValue,
      targetHeight: opts.height,
      currentHeight: 0.02,
      targetPos: opts.pos.clone(),
      baseColor,
    });
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
    const pickTargets = this.bars.flatMap((b) => [b.bodyMesh, b.capMesh]);
    const hits = this.raycaster.intersectObjects(pickTargets, false);
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
    const dt = Math.min(0.05, Math.max(0.001, xb.getDeltaTime()));
    let moving = false;

    for (const entry of this.bars) {
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

      if (this.config.spatialMode === 'scatter3d') {
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
    this.clearDataGroup();
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
