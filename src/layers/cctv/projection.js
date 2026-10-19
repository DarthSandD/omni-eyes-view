import { attachCctvVideo } from './videoPlayback.js';
import * as Cesium from 'cesium';
import {
  CCTV_PROJECTION_OVERLAY_SOURCE_ID,
  CCTV_PROJECTION_OVERLAY_SOURCE_OPTIONS,
  MAX_VIDEO_ATTACH_ATTEMPTS,
  PLANE_OUTLINE_COLOR,
  PROJECTION_CANVAS_WIDTH,
  PROJECTION_CANVAS_HEIGHT,
  VIDEO_ATTACH_RETRY_BASE_MS,
} from './policy.js';

export function createProjection({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { holdContinuousRender, releaseContinuousRender } = services.render;

  /**
   * Build the protected label associated with one active monitor plane.
   * @param {{cameraId: string, name: string, position: Cesium.Cartesian3|Function}} input
   * @returns {Object} Shared-host presentation entry.
   */

  function createCctvProjectionOverlayEntry({ cameraId, name, position }) {
    return {
      id: String(cameraId),
      position,
      variant: 'selected',
      selected: true,
      protected: true,
      paintLane: 'selected',
      collisionGroup: 'ambient-card',
      priority: Number.MAX_SAFE_INTEGER - 1,
      title: String(name || cameraId || 'CAMERA'),
      details: [],
      accent: '#6be8ff',
      interactive: false,
      gapPx: 6,
      verticalOnly: true,
      placement: 'above',
      edgeFade: 'keyhole',
      horizonCull: true,
      terrainOcclusion: false,
    };
  }

  /**
   * Re-derives the monitor plane entity's placement (position, orientation,
   * dimensions) + label from the record's current frustum geometry, so the plane
   * always caps the wireframe exactly (corner rays terminate on its corners).
   * No-op when the record has no plane runtime (idle neighbors have no plane).
   * @param {Object} record - Camera record.
   */

  function updatePlanePlacement(record) {
    const runtime = record?.projection;
    if (!runtime?.planeEntity) return;
    const geometry =
      record.frustumGeometry ||
      parts.geometry.computeFrustumGeometry(
        record.camera,
        parts.ground.groundAltFor(record),
        record.probeClampRangeM,
      );
    const positions =
      record.frustumPositions || parts.geometry.frustumCartesians(geometry);
    runtime.planeEntity.position = positions.capCenter;
    runtime.planeEntity.orientation = parts.model.planeOrientationFor(
      record.camera,
      positions.capCenter,
    );
    if (runtime.planeEntity.plane) {
      runtime.planeEntity.plane.dimensions = new Cesium.Cartesian2(
        geometry.halfW * 2,
        geometry.halfH * 2,
      );
    }
    if (runtime.labelPosition) {
      Cesium.Cartesian3.clone(positions.label, runtime.labelPosition);
    }
  }

  /**
   * Clear the active monitor-plane label source and ownership marker.
   */

  function clearProjectionOverlay() {
    layerState._cctvOverlayHost.clearSource(CCTV_PROJECTION_OVERLAY_SOURCE_ID);
    layerState._cctvOverlayHost.setVisible(
      CCTV_PROJECTION_OVERLAY_SOURCE_ID,
      false,
    );
    layerState._projectionOverlayOwnerId = null;
  }

  /**
   * Shows/hides the monitor plane and its associated shared-host label.
   * @param {Object} runtime - Projection runtime.
   * @param {boolean} visible
   */

  function setPlaneVisible(runtime, visible) {
    if (!runtime) return;
    if (runtime.planeEntity) runtime.planeEntity.show = !!visible;
    if (visible && runtime.overlayEntry && runtime.cameraId) {
      if (layerState._projectionOverlayOwnerId !== runtime.cameraId) {
        layerState._cctvOverlayHost.setEntries(
          CCTV_PROJECTION_OVERLAY_SOURCE_ID,
          [runtime.overlayEntry],
          CCTV_PROJECTION_OVERLAY_SOURCE_OPTIONS,
        );
        layerState._cctvOverlayHost.setVisible(
          CCTV_PROJECTION_OVERLAY_SOURCE_ID,
          true,
        );
        layerState._projectionOverlayOwnerId = runtime.cameraId;
      }
    } else if (layerState._projectionOverlayOwnerId === runtime.cameraId) {
      clearProjectionOverlay();
    }
  }

  /** Create the native monitor plane plus its cached host-label presentation. */

  function createProjectionPlane(record, runtime, geometry, positions) {
    runtime.labelPosition ||= new Cesium.Cartesian3();
    Cesium.Cartesian3.clone(positions.label, runtime.labelPosition);
    runtime.cameraId = String(record.camera.id);
    runtime.overlayEntry = createCctvProjectionOverlayEntry({
      cameraId: runtime.cameraId,
      name: record.camera.name,
      position: () => runtime.labelPosition,
    });
    runtime.planeEntity = layerState._viewer.entities.add({
      id: `cctv-${record.camera.id}-plane`,
      properties: { cctvCameraId: record.camera.id },
      show: false,
      position: positions.capCenter,
      orientation: parts.model.planeOrientationFor(
        record.camera,
        positions.capCenter,
      ),
      plane: {
        plane: new Cesium.Plane(Cesium.Cartesian3.UNIT_Z, 0.0),
        dimensions: new Cesium.Cartesian2(
          geometry.halfW * 2,
          geometry.halfH * 2,
        ),
        material: runtime.planeMaterial,
        outline: true,
        outlineColor: PLANE_OUTLINE_COLOR,
      },
    });
    return runtime.planeEntity;
  }

  /**
   * Attaches a decoder for a video-feed projection runtime, retrying transient
   * failures with backoff before falling back to still-image mode.
   *
   * Agency upstreams are flaky (slow/fragment-timeout hiccups): a single
   * attach failure used to flip the runtime to image mode permanently, so one
   * transient hiccup meant the synthetic frame for the rest of the session.
   * Retries get a fresh <video> element and a fresh HLS lease each time;
   * attachCctvVideo's dispose already released the failed attempt's lease.
   * The retry timer is cleared on destroy, so a torn-down runtime never
   * reattaches. After MAX_VIDEO_ATTACH_ATTEMPTS the runtime falls back to
   * image mode exactly as before (frame endpoint + placeholder).
   *
   * @param {Object} record - Camera record.
   * @param {Object} runtime - Projection runtime.
   * @param {string} feedType - Normalized feed type.
   * @param {number} attempt - Zero-based attempt counter.
   */
  function attachProjectionVideo(record, runtime, feedType, attempt) {
    if (runtime.disposed) return;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    // Cesium sizes the video texture from the element's width/height
    // attributes at first upload. Set them from the real stream dimensions
    // and rebind on any resolution change (camera switch, adaptive source).
    const bindVideoTexture = () => {
      if (runtime.video !== video || !runtime.planeMaterial) return;
      if (!(video.videoWidth > 0 && video.videoHeight > 0)) return;
      video.width = video.videoWidth;
      video.height = video.videoHeight;
      runtime.planeMaterial.image = runtime.canvas;
      runtime.planeMaterial.image = video;
    };
    video.addEventListener('loadedmetadata', bindVideoTexture);
    video.addEventListener('resize', bindVideoTexture);
    runtime.video = video;
    // The video MUST live in the document for its media pipeline to run.
    // Verified 2026-10-19: a detached <video> never fires 'canplay'
    // (stuck at readyState 1 for 35s, same stream attached plays in ~8s),
    // so attachCctvVideo's 30s startup timer killed every HLS feed and the
    // panel fell back to the synthetic frame. Off-screen 1x1, never
    // display:none (which stalls media the same way).
    if (
      typeof document !== 'undefined' &&
      document.body &&
      !video.isConnected
    ) {
      video.style.cssText =
        'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
      video.setAttribute('aria-hidden', 'true');
      document.body.appendChild(video);
    }
    runtime.playback = attachCctvVideo(
      video,
      parts.frames.mediaUrlFor(record.camera),
      feedType,
      {
        onFailure: () => {
          if (runtime.disposed) return;
          // The failed decoder's element leaves the document with it:
          // dispose() (inside attachCctvVideo) stops it, this removes it.
          video.remove?.();
          runtime.video = null;
          if (attempt + 1 < MAX_VIDEO_ATTACH_ATTEMPTS) {
            clearTimeout(runtime.videoRetryTimer);
            runtime.videoRetryTimer = setTimeout(
              () => {
                if (runtime.disposed) return;
                attachProjectionVideo(record, runtime, feedType, attempt + 1);
              },
              VIDEO_ATTACH_RETRY_BASE_MS * 2 ** attempt,
            );
            parts.presentation.notifyListeners();
            return;
          }
          runtime.mode = 'image';
          runtime.image = new Image();
          // CORS-clean fetch is REQUIRED here, not optional. On GitHub Pages
          // the frame endpoint is cross-origin (the worker proxy). Without
          // crossOrigin the image loads opaque, drawImage() onto the
          // projection canvas taints it, and Cesium's next texImage2D upload
          // of that canvas throws SecurityError — which kills the whole
          // Cesium render loop and leaves a black globe. With
          // crossOrigin='anonymous' a non-CORS source fails to load instead
          // (onerror → placeholder), which can never taint the canvas.
          runtime.image.crossOrigin = 'anonymous';
          runtime.image.decoding = 'async';
          runtime.image.onload = () => {
            runtime.imageLoading = false;
            runtime.imageReady = true;
            runtime.frameFailureCount = 0;
            runtime.imageStamp = Date.now();
          };
          runtime.image.onerror = () => {
            runtime.imageLoading = false;
            runtime.imageReady = false;
            runtime.frameFailureCount = (runtime.frameFailureCount || 0) + 1;
          };
          runtime.planeMaterial.image = runtime.canvas;
          parts.frames.refreshProjectionImage(record, true);
          parts.presentation.notifyListeners();
        },
      },
    );
  }

  /**
   * Creates the projection runtime for a camera record: an offscreen canvas,
   * the monitor plane plus associated host label, and either an
   * <img> or <video> element depending on the feed type.
   *
   * The plane is the only projection representation (v2): the frustum's far cap,
   * perpendicular to the view axis (§2b — never billboarded; a wall primitive
   * can't pitch, the plane can). It is textured with the live frame: video
   * element direct, canvas double-buffer otherwise.
   *
   * @param {Object} record - Camera record.
   * @returns {Object|null} Projection runtime, or null if no viewer.
   */

  function createProjectionRuntime(record) {
    if (!layerState._viewer) return null;
    const canvas = document.createElement('canvas');
    canvas.width = PROJECTION_CANVAS_WIDTH;
    canvas.height = PROJECTION_CANVAS_HEIGHT;
    const ctx = canvas.getContext('2d', { alpha: true });

    const feedType = parts.model.normalizeFeedType(record.camera.feedType);
    const mode = parts.model.isVideoFeedType(feedType) ? 'video' : 'image';
    const runtime = {
      mode,
      canvas,
      ctx,
      image: null,
      video: null,
      planeEntity: null,
      cameraId: String(record.camera.id),
      labelPosition: new Cesium.Cartesian3(),
      overlayEntry: null,
      planeMaterial: null,
      buffers: null,
      bufferIndex: 0,
      lastTextureSwapAt: 0,
      lastImageRefreshAt: 0,
      imageReady: false,
      imageLoading: false,
      imageStamp: 0,
      drawnImageStamp: -1,
      // Signature of the pixels currently ON the canvas, plus the reused 64x36
      // scratch used to compute it. null = "nothing known", which always redraws.
      lastFrameSignature: null,
      signatureCanvas: null,
      signatureCtx: null,
      lastPlaceholderPaintAt: 0,
      // canvasStamp increments on every canvas write (frame blit / placeholder
      // paint); lastSwappedCanvasStamp trails it so refreshProjectionTextures
      // only re-uploads the plane texture when there is genuinely new content.
      canvasStamp: 1,
      lastSwappedCanvasStamp: 0,
      disposed: false,
    };

    parts.frames.paintProjectionPlaceholder(ctx, record.camera);

    if (mode === 'video') {
      attachProjectionVideo(record, runtime, feedType, 0);
    } else {
      const img = new Image();
      img.decoding = 'async';
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        runtime.imageLoading = false;
        runtime.imageReady = true;
        runtime.frameFailureCount = 0;
        runtime.imageStamp = Date.now();
      };
      img.onerror = () => {
        runtime.imageLoading = false;
        runtime.imageReady = false;
        runtime.frameFailureCount = (runtime.frameFailureCount || 0) + 1;
      };
      runtime.image = img;
    }

    // Monitor plane = the frustum's far cap: video feeds bind the video element
    // directly (Cesium updates video-backed entity materials per frame); image
    // feeds start on the placeholder canvas and switch to double-buffer swaps
    // at <=1Hz.
    const geometry =
      record.frustumGeometry ||
      parts.geometry.computeFrustumGeometry(
        record.camera,
        parts.ground.groundAltFor(record),
        record.probeClampRangeM,
      );
    const positions =
      record.frustumPositions || parts.geometry.frustumCartesians(geometry);
    runtime.planeMaterial = new Cesium.ImageMaterialProperty({
      image: canvas,
      transparent: true,
      color: Cesium.Color.WHITE.withAlpha(0.95),
    });
    createProjectionPlane(record, runtime, geometry, positions);

    return runtime;
  }

  /**
   * Lazily initializes the projection runtime for a record if it doesn't exist yet.
   * @param {Object} record - Camera record.
   * @returns {Object|null} The record's projection runtime.
   */

  function ensureProjectionRuntime(record) {
    if (!record) return null;
    if (record.projection && !record.projection.disposed)
      return record.projection;
    const runtime = createProjectionRuntime(record);
    record.projection = runtime;
    if (runtime) {
      layerState._projectionEntities.push(runtime);
    }
    return runtime;
  }

  /**
   * Tears down a projection runtime: stops video playback, removes the monitor
   * plane, and clears its host label if it owns the active source.
   * @param {Object} runtime - Projection runtime to destroy.
   */

  function destroyProjectionRuntime(runtime) {
    if (!runtime || runtime.disposed) return;
    runtime.disposed = true;
    // A pending video-attach retry must never fire after teardown.
    clearTimeout(runtime.videoRetryTimer);
    runtime.videoRetryTimer = null;
    runtime.playback?.dispose();
    runtime.playback = null;
    if (runtime.image) {
      runtime.image.onload = null;
      runtime.image.onerror = null;
      runtime.image.src = '';
    }
    if (runtime.video) {
      runtime.video.pause();
      runtime.video.removeAttribute('src');
      runtime.video.load();
      // Paired with the off-screen DOM attach in createProjectionRuntime:
      // a stale 1x1 video left in the document would keep a decoder alive.
      runtime.video.remove?.();
      runtime.video = null;
    }
    if (runtime.planeEntity && layerState._viewer) {
      layerState._viewer.entities.remove(runtime.planeEntity);
      runtime.planeEntity = null;
    }
    if (layerState._projectionOverlayOwnerId === runtime.cameraId)
      clearProjectionOverlay();
    runtime.overlayEntry = null;
    runtime.labelPosition = null;
    runtime.planeMaterial = null;
  }

  function startProjectionLoop() {
    if (layerState._projectionRaf) return;
    if (!parts.model.projectionLoopIsNeeded()) return;
    // The armed projection loop uploads video textures / runs focus fades per
    // frame — the scene must render continuously while it runs. Released when
    // the tick self-stops. (perf wave 2)
    holdContinuousRender('cctv-projection');

    const tick = () => {
      if (!layerState._viewer || !parts.model.projectionLoopIsNeeded()) {
        layerState._projectionRaf = 0;
        releaseContinuousRender('cctv-projection');
        return;
      }

      parts.rendering.refreshCctvFocusStyles(performance.now());

      const active = parts.selection.getActiveRecord();
      if (layerState._enabled && layerState._showProjection && active) {
        ensureProjectionRuntime(active);
        if (active.projection && !active.projection.video) {
          parts.frames.drawProjectionFrame(active);
          parts.frames.refreshProjectionTextures(active);
        }
      }

      layerState._projectionRaf = requestAnimationFrame(tick);
    };

    layerState._projectionRaf = requestAnimationFrame(tick);
  }

  /** Cancels the projection animation loop. */

  function stopProjectionLoop() {
    if (layerState._projectionRaf) {
      cancelAnimationFrame(layerState._projectionRaf);
      layerState._projectionRaf = 0;
    }
    releaseContinuousRender('cctv-projection');
  }

  /**
   * Pauses video playback on all non-active camera projections and resumes
   * the active one (if projection is enabled).
   * @param {string|null} activeId - ID of the currently active camera.
   */

  /**
   * The active camera's decoded <video>, for a second surface (the panel card)
   * to paint from. Null when the active feed is a still or not yet attached.
   * @returns {HTMLVideoElement|null}
   */
  function getActiveVideoElement() {
    if (!layerState._enabled) return null;
    return parts.selection.getActiveRecord()?.projection?.video || null;
  }

  function pauseInactiveProjectionFeeds(activeId) {
    for (const record of layerState._records) {
      if (!record.projection?.video) continue;
      if (record.camera.id === activeId && layerState._enabled) {
        record.projection.video.play().catch(() => {});
      } else {
        const runtime = record.projection;
        destroyProjectionRuntime(runtime);
        record.projection = null;
        layerState._projectionEntities = layerState._projectionEntities.filter(
          (entry) => entry !== runtime,
        );
      }
    }
  }
  return {
    createCctvProjectionOverlayEntry,
    getActiveVideoElement,
    updatePlanePlacement,
    clearProjectionOverlay,
    setPlaneVisible,
    createProjectionPlane,
    createProjectionRuntime,
    ensureProjectionRuntime,
    destroyProjectionRuntime,
    startProjectionLoop,
    stopProjectionLoop,
    pauseInactiveProjectionFeeds,
  };
}
