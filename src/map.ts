import maplibregl from 'maplibre-gl';
// @ts-ignore
import MapboxDraw from 'maplibre-gl-draw';
import 'maplibre-gl-draw/dist/mapbox-gl-draw.css';

let mapInstance: maplibregl.Map | null = null;
let drawControl: MapboxDraw | null = null;

let isDrawing = false;
let isDrawingObstacle = false;

let selectedPolygonId: string | null = null;
let selectedObstacleId: string | null = null;
let selectedObstacleData: any = null;

let onSelectCallback: ((data: {name: string, crop: string}) => void) | null = null;
let onDeselectCallback: (() => void) | null = null;
let onObstacleSelectCallback: ((data: any) => void) | null = null;
let onObstacleDeselectCallback: (() => void) | null = null;

// Map to store metadata for features
const featureMeta = new Map<string, any>();

export function registerSelectionCallbacks(
  onSelect: (data: {name: string, crop: string}) => void,
  onDeselect: () => void,
  onObstacleSelect?: (data: any) => void,
  onObstacleDeselect?: () => void
) {
  onSelectCallback = onSelect;
  onDeselectCallback = onDeselect;
  if (onObstacleSelect) onObstacleSelectCallback = onObstacleSelect;
  if (onObstacleDeselect) onObstacleDeselectCallback = onObstacleDeselect;
}

const customDrawStyles = [
  {
    "id": "gl-draw-polygon-fill-inactive",
    "type": "fill",
    "filter": ["all", ["==", "active", "false"], ["==", "$type", "Polygon"]],
    "paint": {
      "fill-color": ["coalesce", ["get", "user_color"], "#3bb2d0"],
      "fill-opacity": 0.4
    }
  },
  {
    "id": "gl-draw-polygon-fill-active",
    "type": "fill",
    "filter": ["all", ["==", "active", "true"], ["==", "$type", "Polygon"]],
    "paint": {
      "fill-color": ["coalesce", ["get", "user_color"], "#fbb03b"],
      "fill-opacity": 0.2
    }
  },
  {
    "id": "gl-draw-polygon-stroke-inactive",
    "type": "line",
    "filter": ["all", ["==", "active", "false"], ["==", "$type", "Polygon"]],
    "paint": {
      "line-color": ["coalesce", ["get", "user_color"], "#3bb2d0"],
      "line-width": 2
    }
  },
  {
    "id": "gl-draw-polygon-stroke-active",
    "type": "line",
    "filter": ["all", ["==", "active", "true"], ["==", "$type", "Polygon"]],
    "paint": {
      "line-color": ["coalesce", ["get", "user_color"], "#fbb03b"],
      "line-dasharray": [0.2, 2],
      "line-width": 2
    }
  },
  {
    "id": "gl-draw-polygon-and-line-vertex-halo-active",
    "type": "circle",
    "filter": ["all", ["==", "meta", "vertex"], ["==", "$type", "Point"], ["!=", "mode", "static"]],
    "paint": {
      "circle-radius": 5,
      "circle-color": "#FFF"
    }
  },
  {
    "id": "gl-draw-polygon-and-line-vertex-active",
    "type": "circle",
    "filter": ["all", ["==", "meta", "vertex"], ["==", "$type", "Point"], ["!=", "mode", "static"]],
    "paint": {
      "circle-radius": 3,
      "circle-color": "#fbb03b"
    }
  }
];

export function createFarmHouseMarkerElement(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'farmhouse-marker';
  el.style.cursor = 'pointer';
  el.innerHTML = `
    <div style="display: flex; flex-direction: column; align-items: center; transform: translateY(-50%);">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="#3b82f6" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="filter: drop-shadow(0px 2px 4px rgba(0,0,0,0.5));">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
        <polyline points="9 22 9 12 15 12 15 22"></polyline>
      </svg>
      <span style="background: rgba(0,0,0,0.7); color: white; padding: 3px 8px; border-radius: 6px; font-size: 12px; margin-top: 6px; white-space: nowrap; font-weight: 600; box-shadow: 0 2px 4px rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2);">Farm House</span>
    </div>
  `;
  return el;
}

export function addFarmHouseMarker(coords: [number, number]) {
  if (!mapInstance) return;
  new maplibregl.Marker({ element: createFarmHouseMarkerElement() })
    .setLngLat([coords[1], coords[0]])
    .addTo(mapInstance);
}

export function initMap(containerId: string, initialCoords?: [number, number]) {
  const coords: [number, number] = initialCoords ? [initialCoords[1], initialCoords[0]] : [-93.6, 41.5];
  
  mapInstance = new maplibregl.Map({
    container: containerId,
    style: {
      version: 8,
      sources: {
        'google-satellite': {
          type: 'raster',
          tiles: ['https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}'],
          tileSize: 256
        }
      },
      layers: [
        {
          id: 'satellite-layer',
          type: 'raster',
          source: 'google-satellite',
          minzoom: 0,
          maxzoom: 22
        }
      ]
    },
    center: coords,
    zoom: 16
  });

  drawControl = new MapboxDraw({
    displayControlsDefault: false,
    controls: {},
    styles: customDrawStyles,
    userProperties: true
  });

  mapInstance.addControl(drawControl as any);
  mapInstance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

  mapInstance.on('draw.create', (e: any) => {
    if (isDrawing) {
      isDrawing = false;
      const feature = e.features[0];
      if (window as any) {
         const onComplete = (window as any)._onDrawComplete;
         if (onComplete) {
            const coords = feature.geometry.coordinates[0].map((c: any[]) => ({ lng: c[0], lat: c[1] }));
            onComplete(coords, feature);
         }
      }
    } else if (isDrawingObstacle) {
      isDrawingObstacle = false;
      const feature = e.features[0];
      if (window as any) {
         const onComplete = (window as any)._onObstacleDrawComplete;
         if (onComplete) {
            const coords = feature.geometry.coordinates[0].map((c: any[]) => ({ lng: c[0], lat: c[1] }));
            onComplete(coords, feature);
         }
      }
    }
  });

  mapInstance.on('draw.selectionchange', (e: any) => {
    if (e.features.length > 0) {
      const feature = e.features[0];
      const meta = featureMeta.get(feature.id);
      if (meta && meta.type === 'field') {
        deselectCurrentObstacle();
        selectedPolygonId = feature.id;
        if (onSelectCallback) onSelectCallback({ name: meta.name, crop: meta.crop });
      } else if (meta && meta.type === 'obstacle') {
        deselectCurrentPolygon();
        selectedObstacleId = feature.id;
        selectedObstacleData = meta.data;
        if (onObstacleSelectCallback) onObstacleSelectCallback(meta.data);
      }
    } else {
      deselectCurrentPolygon();
      deselectCurrentObstacle();
    }
  });

  return mapInstance;
}

export function panMapTo(coords: [number, number]) {
  if (mapInstance) {
    mapInstance.flyTo({ center: [coords[1], coords[0]], zoom: 16 });
  }
}

export function enableDrawingMode(onComplete: (points: any[], polygonLayer: any) => void) {
  if (!mapInstance || !drawControl) return;
  deselectCurrentPolygon();
  isDrawing = true;
  (window as any)._onDrawComplete = onComplete;
  drawControl.changeMode('draw_polygon');
}

export function cancelDrawingMode() {
  if (!isDrawing || !drawControl) return;
  isDrawing = false;
  drawControl.changeMode('simple_select');
}

export function drawExistingField(points: { lat: number; lng: number }[], name: string, crop: string) {
  if (!drawControl) return null;
  const coords = points.map(p => [p.lng, p.lat]);
  if (coords.length > 0 && (coords[0][0] !== coords[coords.length-1][0] || coords[0][1] !== coords[coords.length-1][1])) {
    coords.push(coords[0]);
  }
  
  const feature = {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [coords] },
    properties: { color: '#22c55e' }
  };
  
  const ids = drawControl.add(feature as any);
  if (ids && ids.length > 0) {
    featureMeta.set(ids[0], { type: 'field', name, crop });
    return feature;
  }
  return null;
}

export function enableObstacleDrawingMode(onComplete: (points: any[], polygonLayer: any) => void) {
  if (!mapInstance || !drawControl) return;
  isDrawingObstacle = true;
  (window as any)._onObstacleDrawComplete = onComplete;
  drawControl.changeMode('draw_polygon');
}

export function cancelObstacleDrawingMode() {
  if (!isDrawingObstacle || !drawControl) return;
  isDrawingObstacle = false;
  drawControl.changeMode('simple_select');
}

export function drawExistingObstacle(obstacleData: any) {
  if (!drawControl) return null;
  let points = [];
  try {
    points = JSON.parse(obstacleData.pointsJson || obstacleData.points_json);
  } catch (e) {
    return null;
  }
  const coords = points.map((p: any) => [p.lng, p.lat]);
  if (coords.length > 0 && (coords[0][0] !== coords[coords.length-1][0] || coords[0][1] !== coords[coords.length-1][1])) {
    coords.push(coords[0]);
  }
  
  const feature = {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [coords] },
    properties: { color: '#ef4444' }
  };
  const ids = drawControl.add(feature as any);
  if (ids && ids.length > 0) {
    featureMeta.set(ids[0], { type: 'obstacle', data: obstacleData });
    return feature;
  }
  return null;
}

export function deselectCurrentPolygon() {
  if (selectedPolygonId && drawControl) {
    // There is no distinct unselect, we just empty the selection
    const sel = drawControl.getSelectedIds();
    if (sel.includes(selectedPolygonId)) {
        drawControl.changeMode('simple_select', { featureIds: [] });
    }
    selectedPolygonId = null;
  }
  if (onDeselectCallback) onDeselectCallback();
}

export function deselectCurrentObstacle() {
  if (selectedObstacleId && drawControl) {
    const sel = drawControl.getSelectedIds();
    if (sel.includes(selectedObstacleId)) {
        drawControl.changeMode('simple_select', { featureIds: [] });
    }
    selectedObstacleId = null;
    selectedObstacleData = null;
  }
  if (onObstacleDeselectCallback) onObstacleDeselectCallback();
}

export function selectPolygon(_polygon: any, _name: string, _crop: string) {
  // handled via events
}

export function enableEditMode() {
  if (selectedPolygonId && drawControl) {
    drawControl.changeMode('direct_select', { featureId: selectedPolygonId });
  }
}

export function disableEditMode() {
  if (selectedPolygonId && drawControl) {
    drawControl.changeMode('simple_select', { featureIds: [selectedPolygonId] });
  }
}

export function enableObstacleEditMode() {
  if (selectedObstacleId && drawControl) {
    drawControl.changeMode('direct_select', { featureId: selectedObstacleId });
  }
}

export function disableObstacleEditMode() {
  if (selectedObstacleId && drawControl) {
    drawControl.changeMode('simple_select', { featureIds: [selectedObstacleId] });
  }
}

export function deleteCurrentPolygon() {
  if (selectedPolygonId && drawControl) {
    drawControl.delete(selectedPolygonId);
    featureMeta.delete(selectedPolygonId);
    selectedPolygonId = null;
  }
  if (onDeselectCallback) onDeselectCallback();
}

export function deleteCurrentObstacle() {
  if (selectedObstacleId && drawControl) {
    drawControl.delete(selectedObstacleId);
    featureMeta.delete(selectedObstacleId);
    selectedObstacleId = null;
    selectedObstacleData = null;
  }
  if (onObstacleDeselectCallback) onObstacleDeselectCallback();
}

export function getSelectedFieldPolygonPoints() {
  if (selectedPolygonId && drawControl) {
    const feature = drawControl.get(selectedPolygonId);
    if (feature && feature.geometry.type === 'Polygon') {
      return feature.geometry.coordinates[0].map(c => ({ lng: c[0], lat: c[1] }));
    }
  }
  return [];
}

export function getSelectedObstaclePolygonPoints() {
  if (selectedObstacleId && drawControl) {
    const feature = drawControl.get(selectedObstacleId);
    if (feature && feature.geometry.type === 'Polygon') {
      return feature.geometry.coordinates[0].map(c => ({ lng: c[0], lat: c[1] }));
    }
  }
  return [];
}

export function getSelectedObstacleData() {
  return selectedObstacleData;
}

export function setupPolygonSelection(_polygon: any, _name: string, _crop: string) {
  // Handled by draw events
}

// Mini maps
let miniMapInstance: maplibregl.Map | null = null;
let miniMapMarker: maplibregl.Marker | null = null;

export function initMiniMap(containerId: string, initialCoords: [number, number], onMarkerDrag?: (lat: number, lng: number) => void) {
  const coords: [number, number] = [initialCoords[1], initialCoords[0]];
  miniMapInstance = new maplibregl.Map({
    container: containerId,
    style: {
      version: 8,
      sources: {
        'google-satellite': { type: 'raster', tiles: ['https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}'], tileSize: 256 }
      },
      layers: [{ id: 'sat', type: 'raster', source: 'google-satellite' }]
    },
    center: coords,
    zoom: 16,
    attributionControl: false
  });
  
  miniMapMarker = new maplibregl.Marker({ 
    element: createFarmHouseMarkerElement(),
    draggable: !!onMarkerDrag 
  })
    .setLngLat(coords)
    .addTo(miniMapInstance);
    
  if (onMarkerDrag) {
    miniMapMarker.on('dragend', () => {
      const pos = miniMapMarker!.getLngLat();
      onMarkerDrag(pos.lat, pos.lng);
    });
  }
  return miniMapInstance;
}

export function updateMiniMap(coords: [number, number]) {
  if (miniMapInstance && miniMapMarker) {
    miniMapInstance.resize();
    miniMapInstance.setCenter([coords[1], coords[0]]);
    miniMapMarker.setLngLat([coords[1], coords[0]]);
  }
}

export function invalidateMiniMapSize() {
  if (miniMapInstance) miniMapInstance.resize();
}

let fieldDataMiniMapInstance: maplibregl.Map | null = null;

export function invalidateFieldDataMiniMapSize() {
  if (fieldDataMiniMapInstance) fieldDataMiniMapInstance.resize();
}


export function initFieldDataMiniMap(containerId: string, points: {lat: number, lng: number}[], obstacles: any[] = []) {
  if (!points || points.length === 0) return;
  const coords = points.map(p => [p.lng, p.lat]);
  let sumLat = 0, sumLng = 0;
  points.forEach(p => { sumLat += p.lat; sumLng += p.lng; });
  const center: [number, number] = [sumLng / points.length, sumLat / points.length];

  fieldDataMiniMapInstance = new maplibregl.Map({
    container: containerId,
    style: {
      version: 8,
      sources: {
        'sat': { type: 'raster', tiles: ['https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}'], tileSize: 256 }
      },
      layers: [{ id: 'sat-layer', type: 'raster', source: 'sat' }]
    },
    center,
    zoom: 15,
    interactive: false,
    attributionControl: false
  });

  fieldDataMiniMapInstance.on('load', () => {
    fieldDataMiniMapInstance!.addSource('field-polygon', {
      type: 'geojson',
      data: {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [coords] }
      } as any
    });
    
    // Fill layer (transparent so we can see NDVI underneath)
    fieldDataMiniMapInstance!.addLayer({
      id: 'field-fill',
      type: 'fill',
      source: 'field-polygon',
      paint: { 'fill-color': '#22c55e', 'fill-opacity': 0.0 }
    });
    
    // Outline layer (black line)
    fieldDataMiniMapInstance!.addLayer({
      id: 'field-outline',
      type: 'line',
      source: 'field-polygon',
      paint: { 'line-color': '#000000', 'line-width': 2 }
    });

    if (obstacles && obstacles.length > 0) {
      obstacles.forEach((obs, idx) => {
        try {
          const pts = JSON.parse(obs.pointsJson || obs.points_json);
          const obsCoords = pts.map((p: any) => [p.lng, p.lat]);
          fieldDataMiniMapInstance!.addSource(`obs-${idx}`, {
            type: 'geojson',
            data: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [obsCoords] } } as any
          });
          fieldDataMiniMapInstance!.addLayer({
            id: `obs-fill-${idx}`,
            type: 'fill',
            source: `obs-${idx}`,
            paint: { 'fill-color': '#ef4444', 'fill-opacity': 0.7 }
          });
        } catch (e) {}
      });
    }

    // Get the full viewport bounds to cover the whole minimap with NDVI
    const bounds = fieldDataMiniMapInstance!.getBounds();
    const extPoints = [
      { lat: bounds.getSouth(), lng: bounds.getWest() },
      { lat: bounds.getNorth(), lng: bounds.getEast() }
    ];

    // Fetch NDVI image dynamically from Axum server using full viewport bounds
    fetch('http://127.0.0.1:3030/api/ndvi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points: extPoints })
    })
    .then(res => {
      if (!res.ok) throw new Error('NDVI fetch failed');
      return res.blob();
    })
    .then(blob => {
      const url = URL.createObjectURL(blob);
      let minLng = bounds.getWest();
      let maxLng = bounds.getEast();
      let minLat = bounds.getSouth();
      let maxLat = bounds.getNorth();
      
      fieldDataMiniMapInstance!.addSource('ndvi-overlay', {
        type: 'image',
        url: url,
        coordinates: [
          [minLng, maxLat], // Top left
          [maxLng, maxLat], // Top right
          [maxLng, minLat], // Bottom right
          [minLng, minLat]  // Bottom left
        ]
      });
      
      fieldDataMiniMapInstance!.addLayer({
        id: 'ndvi-layer',
        type: 'raster',
        source: 'ndvi-overlay',
        paint: {
          'raster-opacity': 0.7
        }
      }, 'field-outline'); // Insert before the outline so outline stays on top!
    })
    .catch(err => console.error("Failed to load NDVI:", err));
  });
}
