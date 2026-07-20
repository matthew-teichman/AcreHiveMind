import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { message, confirm } from "@tauri-apps/plugin-dialog";
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import katexExtension from 'marked-katex-extension';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

marked.use(katexExtension({
  throwOnError: false
}));

import { initMap, enableDrawingMode, cancelDrawingMode, registerSelectionCallbacks, deselectCurrentPolygon, setupPolygonSelection, selectPolygon, enableEditMode, disableEditMode, deleteCurrentPolygon, panMapTo, initMiniMap, updateMiniMap, invalidateMiniMapSize, drawExistingField, enableObstacleDrawingMode, cancelObstacleDrawingMode, drawExistingObstacle, deselectCurrentObstacle, enableObstacleEditMode, disableObstacleEditMode, deleteCurrentObstacle, getSelectedObstaclePolygonPoints, getSelectedObstacleData, initFieldDataMiniMap, addFarmHouseMarker, invalidateFieldDataMiniMapSize } from "./map";

interface UserProfile {
  firstName: string;
  lastName?: string;
  email: string;
  address?: string;
  coordinates: {
    lat: number;
    lng: number;
  };
  climateModel: string;
  geminiApiKey?: string;
  geminiModel?: string;
  ollamaUrl?: string;
  llmProvider?: string;
  tokenUsage?: number;
}

interface ChatSession {
  id: number;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface ChatMessage {
  id?: number;
  sessionId: number;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  modelUsed: string;
  thoughts?: string;
}

interface FarmField {
  id?: number;
  name: string;
  crop: string;
  stage: string;
  pointsJson: string;
  areaHectares?: number;
  obstacles?: Obstacle[];
  weatherSummary?: WeatherSummary;
}

interface WeatherSummary {
  totalPrecipitation1yr: number;
  totalSunExposure1yr: number;
  avgSoilTemp1yr: number;
  avgSoilMoisture1yr: number;
  totalEt1yr: number;
}

interface WeatherData {
  id?: number;
  fieldId: number;
  date: string;
  dataType: string;
  precipitation: number;
  sunExposure: number;
  soilTemp07cm: number;
  soilMoisture07cm: number;
  evapotranspiration: number;
  temperatureMax?: number;
  temperatureMin?: number;
  weatherCode?: number;
}

interface Obstacle {
  id?: number;
  fieldId: number;
  obstacleType: string;
  pointsJson: string;
  note?: string;
}

interface ModelInfo {
  name: string;
  version: string;
  lastUpdated: string;
  status: string;
}

// Initialize theme early to avoid flashes
const savedTheme = localStorage.getItem('theme') || 'light';
if (savedTheme === 'dark') {
  document.documentElement.setAttribute('data-theme', 'dark');
} else {
  document.documentElement.removeAttribute('data-theme');
}

// State
let fields: FarmField[] = [];
let currentDrawnPoints: { lat: number; lng: number }[] = [];

function renderTable() {
  const tbody = document.getElementById('fields-table-body');
  if (!tbody) return;

  if (fields.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="text-center text-muted" style="text-align: center; padding: 32px; color: var(--text-secondary);">Get started by adding a field using the "+ Add Field" button.</td></tr>`;
    return;
  }

  tbody.innerHTML = fields.map(f => {
    let obstacleInfo = "0";
    if (f.obstacles && f.obstacles.length > 0) {
      const types = f.obstacles.map(o => o.obstacleType);
      obstacleInfo = `${f.obstacles.length} (${types.join(', ')})`;
    }
    
    // Format summaries
    const ws = f.weatherSummary;
    const precip = ws ? ws.totalPrecipitation1yr.toFixed(1) : '-';
    const sun = ws ? ws.totalSunExposure1yr.toFixed(1) : '-';
    const soilT = ws ? ws.avgSoilTemp1yr.toFixed(1) : '-';
    const soilM = ws ? ws.avgSoilMoisture1yr.toFixed(2) : '-';
    const et = ws ? ws.totalEt1yr.toFixed(1) : '-';

    return `
    <tr class="field-row" style="cursor: pointer;" data-field-id="${f.id}">
      <td>${f.name}</td>
      <td>${f.crop}</td>
      <td>
        <select class="stage-select" data-field-id="${f.id}" data-prev-val="${f.stage}">
          ${['Preparing', 'Planting', 'Vegetative', 'Reproductive', 'Harvest', 'Winter'].map(s => 
            `<option value="${s}" ${f.stage === s ? 'selected' : ''}>${s}</option>`
          ).join('')}
        </select>
      </td>
      <td>${f.areaHectares !== undefined && f.areaHectares !== null ? f.areaHectares.toFixed(2) : '0.00'}</td>
      <td>${obstacleInfo}</td>
      <td>${precip} mm</td>
      <td>${sun} MJ/m²</td>
      <td>${soilT} °C</td>
      <td>${soilM} m³/m³</td>
      <td>${et} mm</td>
    </tr>
  `;
  }).join('');
  
  // Attach select change listeners explicitly to update DB and avoid row click collision
  const stageSelects = tbody.querySelectorAll('.stage-select');
  stageSelects.forEach(select => {
    select.addEventListener('click', (e) => {
      e.stopPropagation();
    });
    select.addEventListener('change', async (e) => {
      e.stopPropagation();
      const target = e.target as HTMLSelectElement;
      const fieldIdStr = target.getAttribute('data-field-id');
      const newStage = target.value;
      if (fieldIdStr) {
        try {
          await invoke('update_field_stage', { fieldId: parseInt(fieldIdStr), stage: newStage });
          const field = fields.find(f => f.id === parseInt(fieldIdStr));
          if (field) field.stage = newStage;
          target.setAttribute('data-prev-val', newStage);
        } catch(err) {
          console.error("Failed to update stage", err);
          target.value = target.getAttribute('data-prev-val') || 'Preparing';
        }
      }
    });
  });

  // Attach row click listeners for weather modal
  const rows = tbody.querySelectorAll('.field-row');
  rows.forEach(row => {
    row.addEventListener('click', async () => {
      const fieldIdStr = row.getAttribute('data-field-id');
      if (fieldIdStr) {
        await openWeatherModal(parseInt(fieldIdStr));
      }
    });
  });
}

  // --- Weather Modal Logic ---
/**
 * Returns an SVG string for a weather icon based on the WMO weather code.
 * @param {number | null | undefined} code - The WMO weather code
 * @returns {string} The SVG markup for the icon
 */
export function getWeatherIconSVG(code: number | null | undefined): string {
  if (code === null || code === undefined) return getSunnySVG();
  if (code <= 3) return code === 0 ? getSunnySVG() : getCloudySVG();
  if (code === 45 || code === 48) return getCloudySVG(); // Fog
  if (code === 56 || code === 57 || code === 66 || code === 67) return getSnowySVG();
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return getRainySVG();
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return getSnowySVG();
  if (code >= 95 && code <= 99) return getThunderSVG();
  return getSunnySVG();
}

/** @returns {string} SVG for sunny weather */
export function getSunnySVG() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`;
}

/** @returns {string} SVG for cloudy weather */
export function getCloudySVG() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"></path></svg>`;
}

/** @returns {string} SVG for rainy weather */
export function getRainySVG() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"></path><path d="M16 14v6"></path><path d="M8 14v6"></path><path d="M12 16v6"></path></svg>`;
}

/** @returns {string} SVG for thunderstorm weather */
export function getThunderSVG() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 16.9A5 5 0 0 0 18 7h-1.26a8 8 0 1 0-11.62 9"></path><polyline points="13 11 9 17 15 17 11 23"></polyline></svg>`;
}

/** @returns {string} SVG for snowy weather */
export function getSnowySVG() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"></path><path d="M8 15h.01"/><path d="M8 19h.01"/><path d="M12 17h.01"/><path d="M12 21h.01"/><path d="M16 15h.01"/><path d="M16 19h.01"/></svg>`;
}

let currentChart: any = null; // using any for Chart.js instance
let currentSoilChart: any = null;

async function openWeatherModal(fieldId: number) {
  const tableView = document.getElementById('field-table-view');
  const detailsView = document.getElementById('field-details-view');
  if (!tableView || !detailsView) return;

  // Immediate UI feedback
  tableView.classList.add('hidden');
  detailsView.classList.remove('hidden');

  const field = fields.find(f => f.id === fieldId);
  if (field) {
    const titleEl = document.getElementById('weather-modal-title');
    if (titleEl) titleEl.textContent = `${field.name} Data`;
    
    const cropEl = document.getElementById('meta-crop');
    if (cropEl) cropEl.innerHTML = `<strong>Crop:</strong> ${field.crop}`;
    
    const stageEl = document.getElementById('meta-stage');
    if (stageEl) stageEl.innerHTML = `<strong>Stage:</strong> ${field.stage}`;
    
    const areaEl = document.getElementById('meta-area');
    if (areaEl) areaEl.innerHTML = `<strong>Area:</strong> ${field.areaHectares ? field.areaHectares.toFixed(2) : 0} ha`;
    
    const rainEl = document.getElementById('meta-rain');
    if (rainEl) {
      const rain = field.weatherSummary ? field.weatherSummary.totalPrecipitation1yr.toFixed(1) : '-';
      rainEl.innerHTML = `<strong>1-Yr Rainfall:</strong> ${rain} mm`;
    }
    
    if (field.pointsJson) {
      try {
        const points = JSON.parse(field.pointsJson);
        setTimeout(() => {
          initFieldDataMiniMap('field-data-mini-map', points, field.obstacles);
        }, 150);
      } catch (e) {
        console.error("Failed to initialize field mini map:", e);
      }
    }
  }

  try {
    const weatherData = await invoke<WeatherData[]>("get_full_field_weather", { fieldId });
    if (!weatherData || weatherData.length === 0) {
      await message("Weather data has not finished syncing yet. Please try again in a moment.", { title: "Data Syncing" });
      // Revert if no data
      tableView.classList.remove('hidden');
      detailsView.classList.add('hidden');
      return;
    }

    // Group by data type
    const historical = weatherData.filter(d => d.dataType === 'historical');
    
    const todayStr = new Date().toISOString().split('T')[0];
    const forecast = weatherData.filter(d => d.dataType === 'forecast' && d.date >= todayStr).slice(0, 16);
    const climate = weatherData.filter(d => d.dataType === 'climate' && d.date >= todayStr);

    // Populate 16-Day Forecast
    const el16 = document.getElementById('weather-16day-content');
    if (el16) {
      if (forecast.length > 0) {
        const cards = forecast.map(day => {
          const d = new Date(day.date + 'T12:00:00Z');
          const dateStr = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
          const maxT = day.temperatureMax !== null && day.temperatureMax !== undefined ? Math.round(day.temperatureMax) + '&deg;C' : '--';
          const minT = day.temperatureMin !== null && day.temperatureMin !== undefined ? Math.round(day.temperatureMin) + '&deg;C' : '--';
          const precip = day.precipitation > 0 ? day.precipitation.toFixed(1) + ' mm' : '0 mm';
          const iconSvg = getWeatherIconSVG(day.weatherCode);
          
          return `
            <div class="forecast-card">
              <div class="fc-date">${dateStr}</div>
              <div class="fc-icon">${iconSvg}</div>
              <div class="fc-temp">${maxT} / ${minT}</div>
              <div class="fc-precip">${precip}</div>
            </div>
          `;
        }).join('');
        el16.innerHTML = cards;
      } else {
        el16.innerHTML = `<p style="font-size: 14px; color: var(--text-secondary); padding: 0 16px;">No forecast data available.</p>`;
      }
    }

    // Populate Climate Outlook
    const elClim = document.getElementById('weather-climate-content');
    if (elClim && climate.length > 0) {
      const avgT = climate.reduce((a, b) => a + (b.soilTemp07cm || 0), 0) / climate.length;
      const sumP = climate.reduce((a, b) => a + (b.precipitation || 0), 0);
      elClim.innerHTML = `<span title="A projection of weather conditions for the remainder of the calendar year based on long-range models">Outlook to end of year (${climate.length} days):</span> <br/>
        <span title="Predicted cumulative precipitation from now until the end of the year">Estimated Rainfall:</span> <b>${sumP.toFixed(1)} mm</b><br/>
        <span title="Predicted average topsoil temperature for the remainder of the year">Estimated Avg Soil Temp:</span> <b>${avgT.toFixed(1)} &deg;C</b>`;
    }

    // Populate Soil & Hydrology Summary (from recent historical)
    const elSoil = document.getElementById('weather-soil-content');
    if (elSoil && historical.length > 0) {
      const lastWeek = historical.slice(-7);
      const avgSoilM = lastWeek.reduce((a, b) => a + (b.soilMoisture07cm || 0), 0) / lastWeek.length;
      const avgET = lastWeek.reduce((a, b) => a + (b.evapotranspiration || 0), 0) / lastWeek.length;
      elSoil.innerHTML = `Past 7 days averages:<br/>
        <span title="Volumetric water content in the top 7cm of soil. Indicates immediate moisture availability for roots.">Soil Moisture (0-7cm):</span> <b>${avgSoilM.toFixed(3)} m&sup3;/m&sup3;</b><br/>
        <span title="Reference Evapotranspiration (ET0) - the estimated rate of water loss from soil and plant transpiration">Evapotranspiration (ET0):</span> <b>${avgET.toFixed(2)} mm/day</b>`;
    }

    // Build Chart.js Graph
    renderWeatherChart(historical);

    // Fetch Advanced Agronomy Data
    try {
      const agronomyStats: any = await invoke("get_field_statistics", { fieldId });
      const agronomyContent = document.getElementById('agronomy-metrics-content');
      if (agronomyContent) {
         agronomyContent.innerHTML = `
           <div class="metrics-card" title="Delta T indicates evaporation rate and droplet survival. Ideal spraying conditions are between 2 and 8 &deg;C."><strong>Delta T (Spraying):</strong> ${agronomyStats.deltaT.toFixed(2)} &deg;C</div>
           <div class="metrics-card" title="High risk indicates a temperature inversion layer which can trap airborne chemicals and cause unpredictable drift."><strong>Inversion Risk:</strong> ${agronomyStats.inversionRisk ? '<span style="color:red">High</span>' : '<span style="color:green">Low</span>'}</div>
           <div class="metrics-card" title="Index (0-100) indicating soil firmness and suitability for heavy machinery. Higher is better to avoid soil compaction."><strong>Trafficability Index:</strong> ${agronomyStats.trafficabilityIndex.toFixed(0)} / 100</div>
           <div class="metrics-card" title="Growing Degree Days (GDD) accumulated today based on average temperature, used to track crop development stages."><strong>GDD (Today):</strong> ${agronomyStats.gdd.toFixed(1)} &deg;C</div>
           <div class="metrics-card" title="Current wind speed and direction, critical for evaluating spray drift risk and field operations."><strong>Wind:</strong> ${agronomyStats.windSpeed.toFixed(1)} km/h @ ${agronomyStats.windDirection.toFixed(0)}&deg;</div>
           <div class="metrics-card" title="Relative humidity which affects plant transpiration rates, disease pressure, and chemical efficacy."><strong>Humidity:</strong> ${agronomyStats.humidity.toFixed(0)}%</div>
           <div class="metrics-card" title="Probability of leaf surface wetness, which strongly influences foliar disease risk and fungicide application timing."><strong>Leaf Wetness:</strong> ${agronomyStats.leafWetnessProb.toFixed(0)}%</div>
         `;
         
         renderSoilProfileChart(agronomyStats);
      }
    } catch (e) {
      console.error("Failed to load agronomy stats:", e);
    }
    
    // Tab switching setup (only bind once by removing old listeners if any, or just setting onclick)
    const tabBtns = document.querySelectorAll('.tab-btn');
    tabBtns.forEach(btn => {
      (btn as HTMLElement).onclick = () => {
        // Reset all tabs
        tabBtns.forEach(b => {
          (b as HTMLElement).classList.remove('active');
          (b as HTMLElement).style.borderBottom = 'none';
          (b as HTMLElement).style.color = 'var(--text-secondary)';
          (b as HTMLElement).style.fontWeight = 'normal';
        });
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));
        
        // Set active tab
        (btn as HTMLElement).classList.add('active');
        (btn as HTMLElement).style.borderBottom = '2px solid #8b5cf6';
        (btn as HTMLElement).style.color = 'var(--text-primary)';
        (btn as HTMLElement).style.fontWeight = '600';
        
        const targetPane = document.getElementById(btn.getAttribute('data-tab') || '');
        if (targetPane) {
          targetPane.classList.remove('hidden');
          // Invalidate map size if agronomy tab
          if (btn.getAttribute('data-tab') === 'tab-agronomy') {
             setTimeout(() => {
                invalidateFieldDataMiniMapSize();
             }, 100);
          }
        }
      };
    });

    // Default to Weather tab
    const weatherTabBtn = document.querySelector('[data-tab="tab-weather"]') as HTMLElement;
    if (weatherTabBtn) weatherTabBtn.click();
    
    tableView.classList.add('hidden');
    detailsView.classList.remove('hidden');

  } catch (err) {
    console.error("Failed to load weather data:", err);
    await message("Error loading detailed weather data.", { title: "Error", kind: "error" });
  }
}

function renderWeatherChart(historical: WeatherData[]) {
  const canvas = document.getElementById('weather-chart') as HTMLCanvasElement;
  if (!canvas) return;

  if (currentChart) {
    currentChart.destroy();
  }

  // Group by month
  const monthlyData: Record<string, { precip: number; sun: number }> = {};
  for (const d of historical) {
    const month = d.date.substring(0, 7); // YYYY-MM
    if (!monthlyData[month]) {
      monthlyData[month] = { precip: 0, sun: 0 };
    }
    monthlyData[month].precip += d.precipitation;
    monthlyData[month].sun += d.sunExposure;
  }

  const labels = Object.keys(monthlyData).sort();
  const precipData = labels.map(l => monthlyData[l].precip);
  const sunData = labels.map(l => monthlyData[l].sun);

  const calcExpected = (data: number[]) => {
    const expected = new Array(labels.length).fill(null);
    const yearsToAvg = Math.floor(labels.length / 12) - 1;
    if (yearsToAvg > 0) {
      const startIndex = labels.length - 12;
      for (let m = 0; m < 12; m++) {
        let sum = 0;
        for (let y = 0; y < yearsToAvg; y++) {
          sum += data[startIndex - 12 * (y + 1) + m];
        }
        expected[startIndex + m] = sum / yearsToAvg;
      }
    }
    return expected;
  };
  
  const expectedPrecip = calcExpected(precipData);
  const expectedSun = calcExpected(sunData);

  // @ts-ignore
  currentChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Rainfall (mm)',
          data: precipData,
          backgroundColor: 'rgba(59, 130, 246, 0.7)',
          borderColor: 'rgba(59, 130, 246, 1)',
          borderWidth: 1
        },
        {
          type: 'line',
          label: 'Expected Rainfall',
          data: expectedPrecip,
          borderColor: 'rgba(59, 130, 246, 1)',
          borderWidth: 3,
          pointBackgroundColor: 'rgba(59, 130, 246, 1)',
          pointRadius: 4,
          fill: false,
          spanGaps: false
        },
        {
          label: 'Sun Exposure (MJ/m²)',
          data: sunData,
          backgroundColor: 'rgba(245, 158, 11, 0.7)',
          borderColor: 'rgba(245, 158, 11, 1)',
          borderWidth: 1
        },
        {
          type: 'line',
          label: 'Expected Sun',
          data: expectedSun,
          borderColor: 'rgba(245, 158, 11, 1)',
          borderWidth: 3,
          pointBackgroundColor: 'rgba(245, 158, 11, 1)',
          pointRadius: 4,
          fill: false,
          spanGaps: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          grid: {
            color: (context: any) => {
              if (context.index % 12 === 0) return 'rgba(128,128,128,0.6)';
              return 'rgba(0,0,0,0)';
            }
          },
          border: {
            dash: [5, 5]
          }
        },
        y: {
          beginAtZero: true
        }
      }
    }
  });
}

function renderSoilProfileChart(stats: any) {
  const canvas = document.getElementById('soil-profile-chart') as HTMLCanvasElement;
  if (!canvas) return;

  if (currentSoilChart) {
    currentSoilChart.destroy();
  }

  if (!stats.time || stats.time.length === 0) return;

  const labels = stats.time.map((t: string) => {
    const d = new Date(t);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });
  });

  // @ts-ignore
  currentSoilChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Temp 0-7cm (°C)',
          data: stats.soilTemp07cm || stats.soilTemp07Cm || stats.soilTemp_0_7cm || [],
          borderColor: '#ef4444',
          yAxisID: 'yTemp',
          tension: 0.4,
          pointRadius: 0,
        },
        {
          label: 'Temp 7-28cm (°C)',
          data: stats.soilTemp728cm || stats.soilTemp728Cm || stats.soilTemp_7_28cm || [],
          borderColor: '#f97316',
          yAxisID: 'yTemp',
          tension: 0.4,
          pointRadius: 0,
        },
        {
          label: 'Temp 28-100cm (°C)',
          data: stats.soilTemp28100cm || stats.soilTemp28100Cm || stats.soilTemp_28_100cm || [],
          borderColor: '#f59e0b',
          yAxisID: 'yTemp',
          tension: 0.4,
          pointRadius: 0,
        },
        {
          label: 'Temp 100-255cm (°C)',
          data: stats.soilTemp100255cm || stats.soilTemp100255Cm || stats.soilTemp_100_255cm || [],
          borderColor: '#eab308',
          yAxisID: 'yTemp',
          tension: 0.4,
          pointRadius: 0,
        },
        {
          label: 'Moisture 0-7cm (m³/m³)',
          data: stats.soilMoist07cm || stats.soilMoist07Cm || stats.soilMoist_0_7cm || [],
          borderColor: '#3b82f6',
          yAxisID: 'yMoist',
          tension: 0.4,
          pointRadius: 0,
        },
        {
          label: 'Moisture 7-28cm (m³/m³)',
          data: stats.soilMoist728cm || stats.soilMoist728Cm || stats.soilMoist_7_28cm || [],
          borderColor: '#60a5fa',
          yAxisID: 'yMoist',
          tension: 0.4,
          pointRadius: 0,
        },
        {
          label: 'Moisture 28-100cm (m³/m³)',
          data: stats.soilMoist28100cm || stats.soilMoist28100Cm || stats.soilMoist_28_100cm || [],
          borderColor: '#93c5fd',
          yAxisID: 'yMoist',
          tension: 0.4,
          pointRadius: 0,
        },
        {
          label: 'Moisture 100-255cm (m³/m³)',
          data: stats.soilMoist100255cm || stats.soilMoist100255Cm || stats.soilMoist_100_255cm || [],
          borderColor: '#bfdbfe',
          yAxisID: 'yMoist',
          tension: 0.4,
          pointRadius: 0,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.1)' }
        },
        yTemp: {
          type: 'linear',
          display: true,
          position: 'left',
          title: { display: true, text: 'Temperature (°C)' },
          grid: { color: 'rgba(255,255,255,0.1)' }
        },
        yMoist: {
          type: 'linear',
          display: true,
          position: 'right',
          title: { display: true, text: 'Moisture (m³/m³)' },
          grid: { drawOnChartArea: false }
        }
      },
      plugins: {
        legend: {
          labels: { color: 'white' }
        }
      }
    }
  });
}

let currentCalendarDate = new Date();

async function renderCalendar() {
  const grid = document.getElementById('calendar-grid');
  const monthLabel = document.getElementById('calendar-current-month');
  if (!grid || !monthLabel) return;

  const year = currentCalendarDate.getFullYear();
  const month = currentCalendarDate.getMonth();
  monthLabel.textContent = currentCalendarDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  // Get first day of month (0-6)
  const firstDay = new Date(year, month, 1).getDay();
  // Get days in month
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  let html = '';
  // Empty cells before start of month
  for (let i = 0; i < firstDay; i++) {
    html += `<div class="calendar-day empty"></div>`;
  }

  // Generate days
  const today = new Date();
  for (let d = 1; d <= daysInMonth; d++) {
    const isToday = today.getFullYear() === year && today.getMonth() === month && today.getDate() === d;
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    html += `
      <div class="calendar-day ${isToday ? 'today' : ''}" data-date="${dateStr}">
        <div class="cal-date">${d}</div>
        <div class="cal-weather" id="cal-weather-${dateStr}"></div>
      </div>
    `;
  }
  grid.innerHTML = html;

  // Fetch weather data for the first field if available
  if (fields.length > 0 && fields[0].id) {
    try {
      const weatherData = await invoke<WeatherData[]>("get_full_field_weather", { fieldId: fields[0].id });
      if (weatherData && weatherData.length > 0) {
        const todayStr = new Date().toISOString().split('T')[0];
        let forecastCount = 0;
        weatherData.forEach(day => {
          if (day.date >= todayStr) {
            if (day.dataType === 'climate') return;
            if (day.dataType === 'forecast') {
              if (forecastCount >= 16) return;
              forecastCount++;
            }
          }
          const wContainer = document.getElementById(`cal-weather-${day.date}`);
          if (wContainer) {
            const iconSvg = getWeatherIconSVG(day.weatherCode);
            let desc = "Clear";
            if (day.weatherCode !== undefined && day.weatherCode !== null) {
               const code = day.weatherCode;
               if (code > 0 && code <= 3) desc = "Cloudy";
               else if (code === 45 || code === 48) desc = "Fog";
               else if (code === 56 || code === 57 || code === 66 || code === 67) desc = "Freezing Rain";
               else if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) desc = "Rain";
               else if ((code >= 71 && code <= 77) || code === 85 || code === 86) desc = "Snow";
               else if (code >= 95 && code <= 99) desc = "Storm";
            } else if (day.precipitation > 0) {
               desc = "Rain";
            }
            
            const precipHtml = day.precipitation > 0 ? `<div class="cal-weather-precip">${day.precipitation.toFixed(1)}mm</div>` : '';
            const tempHtml = (day.temperatureMax !== undefined && day.temperatureMin !== undefined) ? 
              `<div class="cal-weather-temps" style="font-size: 11px; font-weight: 600; margin-top: 4px; display: flex; gap: 4px;">
                 <span style="color: #ef4444;" title="High">${Math.round(day.temperatureMax)}°</span> 
                 <span style="color: var(--text-secondary);">/</span> 
                 <span style="color: #3b82f6;" title="Low">${Math.round(day.temperatureMin)}°</span>
               </div>` : '';
               
            wContainer.innerHTML = `
              <div class="cal-weather-row" style="display: flex; align-items: center; gap: 4px;">
                <div class="cal-weather-icon">${iconSvg}</div>
                <div class="cal-weather-desc" style="font-size: 11px;">${desc}</div>
              </div>
              ${tempHtml}
              ${precipHtml}
            `;
          }
        });
      }
    } catch (e) {
      console.error("Failed to fetch weather for calendar", e);
    }
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  const sidebarWeatherText = document.getElementById('sidebar-weather-text');
  const sidebarWeatherDot = document.getElementById('sidebar-weather-dot');
  if (sidebarWeatherText && sidebarWeatherDot) {
    const lastSync = localStorage.getItem('lastWeatherSync');
    const lastSyncIso = localStorage.getItem('lastWeatherSyncIso');
    
    let isStale = true;
    let lastSyncTime = 0;
    if (lastSyncIso) {
      lastSyncTime = new Date(lastSyncIso).getTime();
    } else if (lastSync) {
      lastSyncTime = new Date(lastSync).getTime();
    }
    
    if (lastSyncTime > 0 && !isNaN(lastSyncTime)) {
      const oneDay = 24 * 60 * 60 * 1000;
      if (Date.now() - lastSyncTime < oneDay) {
        isStale = false;
      }
    }
    
    sidebarWeatherText.textContent = lastSync ? `Weather Updated: ${lastSync}` : 'Weather: Not Synced';
    if (isStale) {
      sidebarWeatherDot.classList.remove('active');
    } else {
      sidebarWeatherDot.classList.add('active');
    }
  }

  // State
  let profile: UserProfile | null = null;
  
  try {
    profile = await invoke<UserProfile | null>("get_user_profile");
  } catch (err) {
    console.error("Failed to load user profile from database:", err);
  }

  async function loadFields() {
    try {
      const dbFields = await invoke<FarmField[]>("get_fields");
      fields.length = 0; // Clear the array
      for (const f of dbFields) {
        fields.push(f);
        try {
          const points = JSON.parse(f.pointsJson);
          drawExistingField(points, f.name, f.crop);
          if (f.id) {
            const obstacles = await invoke<Obstacle[]>("get_obstacles_for_field", { fieldId: f.id });
            f.obstacles = obstacles;
            
            try {
              const ws = await invoke<WeatherSummary>("get_weather_summary", { fieldId: f.id });
              f.weatherSummary = ws;
            } catch (err) {
              console.error("Failed to load weather summary for field", f.id, err);
            }

            for (const obs of obstacles) {
              drawExistingObstacle(obs);
            }
          }
        } catch (err) {
          console.error("Failed to parse field points for " + f.name, err);
        }
      }
      renderTable();
      updateSuggestionVisibility();
    } catch (err) {
      console.error("Failed to load fields from database:", err);
    }
  }

  // Populate settings view form
  function populateSettingsForm(profileData: UserProfile) {
    const firstNameInput = document.getElementById("settings-first-name") as HTMLInputElement | null;
    const lastNameInput = document.getElementById("settings-last-name") as HTMLInputElement | null;
    const emailInput = document.getElementById("settings-email") as HTMLInputElement | null;
    const addressInput = document.getElementById("settings-address") as HTMLInputElement | null;
    const latInput = document.getElementById("settings-lat") as HTMLInputElement | null;
    const lngInput = document.getElementById("settings-lng") as HTMLInputElement | null;
    const climateModelSelect = document.getElementById("settings-climate-model") as HTMLSelectElement | null;
    const geminiKeyInput = document.getElementById("settings-gemini-key") as HTMLInputElement | null;
    const geminiModelSelect = document.getElementById("settings-gemini-model") as HTMLSelectElement | null;
    const ollamaUrlInput = document.getElementById("settings-ollama-url") as HTMLInputElement | null;
    const llmProviderSelect = document.getElementById("settings-llm-provider") as HTMLSelectElement | null;
    const tokenUsageDisplay = document.getElementById("settings-token-usage");
    
    if (firstNameInput) firstNameInput.value = profileData.firstName;
    if (lastNameInput) lastNameInput.value = profileData.lastName || "";
    if (emailInput) emailInput.value = profileData.email;
    if (addressInput) addressInput.value = profileData.address || "";
    if (latInput) latInput.value = profileData.coordinates.lat.toString();
    if (lngInput) lngInput.value = profileData.coordinates.lng.toString();
    if (climateModelSelect) climateModelSelect.value = profileData.climateModel || "MPI_ESM1_2_XR";
    if (geminiKeyInput) geminiKeyInput.value = profileData.geminiApiKey || "";
    if (ollamaUrlInput) ollamaUrlInput.value = profileData.ollamaUrl || "";
    if (llmProviderSelect) llmProviderSelect.value = profileData.llmProvider || "gemini";
    if (tokenUsageDisplay) tokenUsageDisplay.textContent = (profileData.tokenUsage || 0).toString();
    if (geminiModelSelect) {
      // If the profile has a model that isn't in the options yet, add it
      if (profileData.geminiModel) {
        let exists = false;
        for (let i = 0; i < geminiModelSelect.options.length; i++) {
          if (geminiModelSelect.options[i].value === profileData.geminiModel) {
            exists = true;
            break;
          }
        }
        if (!exists) {
          const opt = document.createElement('option');
          opt.value = profileData.geminiModel;
          opt.textContent = profileData.geminiModel.replace('models/', '');
          geminiModelSelect.appendChild(opt);
        }
      }
      geminiModelSelect.value = profileData.geminiModel || "models/gemini-1.5-flash-latest";
    }

    const currentProviderBadge = document.getElementById("agentic-current-provider");
    if (currentProviderBadge) {
      if (profileData.llmProvider === 'ollama') {
        currentProviderBadge.textContent = 'Ollama';
      } else {
        const modelName = (profileData.geminiModel || 'gemini-1.5-flash-latest').replace('models/', '');
        currentProviderBadge.textContent = `Gemini (${modelName})`;
      }
    }

    const miniMapContainer = document.getElementById("settings-mini-map");
    
    const handleMarkerDrag = (lat: number, lng: number) => {
      if (latInput) latInput.value = lat.toFixed(6);
      if (lngInput) lngInput.value = lng.toFixed(6);
    };

    if (miniMapContainer && !miniMapContainer.classList.contains('leaflet-container')) {
      setTimeout(() => initMiniMap("settings-mini-map", [profileData.coordinates.lat, profileData.coordinates.lng], handleMarkerDrag), 100);
    } else {
      updateMiniMap([profileData.coordinates.lat, profileData.coordinates.lng]);
    }
  }

  // Autocomplete functionality
  let debounceTimeout: any;

  function setupAutocomplete(inputId: string, dropdownId: string) {
    const input = document.getElementById(inputId) as HTMLInputElement;
    const dropdown = document.getElementById(dropdownId);
    if (!input || !dropdown) return;

    input.addEventListener("input", (e) => {
      const val = (e.target as HTMLInputElement).value.trim();
      if (!val) {
        dropdown.classList.add("hidden");
        return;
      }

      clearTimeout(debounceTimeout);
      debounceTimeout = setTimeout(() => {
        fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(val)}&limit=5`)
          .then(res => res.json())
          .then(data => {
            if (data.features && data.features.length > 0) {
              dropdown.innerHTML = data.features.map((feature: any) => {
                const props = feature.properties;
                const coords = feature.geometry.coordinates; // [lon, lat]
                const title = props.name || props.street || props.city || "Unknown";
                const details = [props.city, props.state, props.country].filter(Boolean).join(", ");
                
                return `
                  <div class="autocomplete-item" data-lat="${coords[1]}" data-lon="${coords[0]}" data-full="${title + (details ? ', ' + details : '')}">
                    <span class="autocomplete-primary">${title}</span>
                    <span class="autocomplete-secondary">${details}</span>
                  </div>
                `;
              }).join('');
              
              dropdown.classList.remove("hidden");
              
              dropdown.querySelectorAll(".autocomplete-item").forEach(item => {
                item.addEventListener("click", () => {
                  const fullAddress = item.getAttribute("data-full") || "";
                  const lat = item.getAttribute("data-lat");
                  const lon = item.getAttribute("data-lon");
                  
                  input.value = fullAddress;
                  input.dataset.lat = lat || "";
                  input.dataset.lon = lon || "";
                  dropdown.classList.add("hidden");

                  if (inputId === "settings-address" && lat && lon) {
                    updateMiniMap([parseFloat(lat), parseFloat(lon)]);
                    const latInput = document.getElementById("settings-lat") as HTMLInputElement;
                    const lngInput = document.getElementById("settings-lng") as HTMLInputElement;
                    if (latInput) latInput.value = lat;
                    if (lngInput) lngInput.value = lon;
                  }

                  if (inputId === "onboarding-address" && lat && lon) {
                    const onboardingMapContainer = document.getElementById("onboarding-map-container");
                    if (onboardingMapContainer) {
                      onboardingMapContainer.classList.remove("hidden");
                    }
                    const miniMapNode = document.getElementById("onboarding-mini-map");
                    if (miniMapNode) {
                      const numLat = parseFloat(lat);
                      const numLon = parseFloat(lon);
                      
                      const onboardingLat = document.getElementById("onboarding-lat") as HTMLInputElement | null;
                      const onboardingLng = document.getElementById("onboarding-lng") as HTMLInputElement | null;
                      if (onboardingLat) onboardingLat.value = numLat.toFixed(6);
                      if (onboardingLng) onboardingLng.value = numLon.toFixed(6);

                      if (!miniMapNode.classList.contains('leaflet-container')) {
                        const handleDrag = (dLat: number, dLng: number) => {
                          if (onboardingLat) {
                            onboardingLat.value = dLat.toFixed(6);
                            validateCoordinate(onboardingLat, -90, 90);
                          }
                          if (onboardingLng) {
                            onboardingLng.value = dLng.toFixed(6);
                            validateCoordinate(onboardingLng, -180, 180);
                          }
                          input.dataset.lat = dLat.toString();
                          input.dataset.lon = dLng.toString();
                        };
                        setTimeout(() => initMiniMap("onboarding-mini-map", [numLat, numLon], handleDrag), 100);
                      } else {
                        setTimeout(() => {
                          if ((window as any).L && miniMapNode.classList.contains('leaflet-container')) {
                            invalidateMiniMapSize();
                            updateMiniMap([numLat, numLon]);
                          }
                        }, 100);
                      }
                    }
                  }
                });
              });
            } else {
              dropdown.classList.add("hidden");
            }
          })
          .catch(err => {
            console.error("Autocomplete fetch failed", err);
          });
      }, 300);
    });

    document.addEventListener("click", (e) => {
      if (!input.contains(e.target as Node) && !dropdown.contains(e.target as Node)) {
        dropdown.classList.add("hidden");
      }
    });
  }

  setupAutocomplete("onboarding-address", "onboarding-address-dropdown");
  setupAutocomplete("settings-address", "settings-address-dropdown");

  // Onboarding Location Mode Tab Toggling
  const btnLocAddress = document.getElementById("btn-location-address");
  const btnLocCoords = document.getElementById("btn-location-coords");
  const onboardingAddressGroup = document.getElementById("onboarding-address-group");
  const onboardingCoordsGroup = document.getElementById("onboarding-coords-group");
  
  let onboardingMode: "address" | "coords" = "address";

  function validateCoordinate(input: HTMLInputElement, min: number, max: number) {
    const val = input.value.trim();
    if (!val || val === "-" || val === "." || val === "-.") {
      input.classList.remove("invalid");
      return false;
    }
    const num = parseFloat(val);
    const isValid = !isNaN(num) && num >= min && num <= max;
    if (isValid) {
      input.classList.remove("invalid");
      return true;
    } else {
      input.classList.add("invalid");
      return false;
    }
  }

  const onboardingLat = document.getElementById("onboarding-lat") as HTMLInputElement | null;
  const onboardingLng = document.getElementById("onboarding-lng") as HTMLInputElement | null;

  function syncOnboardingMap() {
    if (onboardingLat && onboardingLng && onboardingMode === "coords") {
      const latValid = validateCoordinate(onboardingLat, -90, 90);
      const lngValid = validateCoordinate(onboardingLng, -180, 180);
      if (latValid && lngValid) {
        updateMiniMap([parseFloat(onboardingLat.value), parseFloat(onboardingLng.value)]);
      }
    }
  }

  if (onboardingLat) {
    onboardingLat.addEventListener("input", () => {
      validateCoordinate(onboardingLat, -90, 90);
      syncOnboardingMap();
    });
  }
  if (onboardingLng) {
    onboardingLng.addEventListener("input", () => {
      validateCoordinate(onboardingLng, -180, 180);
      syncOnboardingMap();
    });
  }

  function updateSuggestionVisibility() {
    const banner = document.getElementById("map-suggestion-banner");
    if (!banner) return;

    const mapActive = document.getElementById("map-container")?.classList.contains("active");
    const isDrawingActive = !document.getElementById("drawing-status")?.classList.contains("hidden");

    if (mapActive && fields.length === 0 && !isDrawingActive) {
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  }

  if (btnLocAddress && btnLocCoords && onboardingAddressGroup && onboardingCoordsGroup) {
    const onboardingMapContainer = document.getElementById("onboarding-map-container");

    btnLocAddress.addEventListener("click", () => {
      btnLocAddress.classList.add("active");
      btnLocCoords.classList.remove("active");
      onboardingAddressGroup.classList.remove("hidden");
      onboardingCoordsGroup.classList.add("hidden");
      
      const addrInput = document.getElementById("onboarding-address") as HTMLInputElement;
      if (addrInput && addrInput.dataset.lat && addrInput.dataset.lon) {
        if (onboardingMapContainer) onboardingMapContainer.classList.remove("hidden");
        setTimeout(() => { invalidateMiniMapSize(); }, 100);
      } else {
        if (onboardingMapContainer) onboardingMapContainer.classList.add("hidden");
      }
      
      onboardingMode = "address";
    });

    btnLocCoords.addEventListener("click", () => {
      btnLocCoords.classList.add("active");
      btnLocAddress.classList.remove("active");
      onboardingCoordsGroup.classList.remove("hidden");
      onboardingAddressGroup.classList.add("hidden");
      if (onboardingMapContainer) onboardingMapContainer.classList.remove("hidden");
      onboardingMode = "coords";

      const miniMapNode = document.getElementById("onboarding-mini-map");
      if (miniMapNode && !miniMapNode.classList.contains('leaflet-container')) {
        const handleDrag = (lat: number, lng: number) => {
          if (onboardingLat) {
            onboardingLat.value = lat.toFixed(6);
            validateCoordinate(onboardingLat, -90, 90);
          }
          if (onboardingLng) {
            onboardingLng.value = lng.toFixed(6);
            validateCoordinate(onboardingLng, -180, 180);
          }
          const addrInput = document.getElementById("onboarding-address") as HTMLInputElement;
          if (addrInput) {
            addrInput.dataset.lat = lat.toString();
            addrInput.dataset.lon = lng.toString();
          }
        };
        const defaultCoords: [number, number] = [41.5, -93.6];
        setTimeout(() => initMiniMap("onboarding-mini-map", defaultCoords, handleDrag), 100);
      } else if (miniMapNode) {
        setTimeout(() => {
          // Invalidate size in case tab switched and container was hidden
          if ((window as any).L && miniMapNode.classList.contains('leaflet-container')) {
             invalidateMiniMapSize();
             syncOnboardingMap();
          }
        }, 100);
      }
    });
  }

  // Initialize map if profile exists
  const mapContainer = document.getElementById("map-container");
  if (mapContainer && profile) {
    const map = initMap("map-container", [profile.coordinates.lat, profile.coordinates.lng]);
    map.on('load', async () => {
      addFarmHouseMarker([profile!.coordinates.lat, profile!.coordinates.lng]);
      await loadFields();
      updateSuggestionVisibility();
    });
  }

  // Onboarding overlay visibility
  const onboardingOverlay = document.getElementById("onboarding-overlay");
  if (!profile) {
    if (onboardingOverlay) {
      onboardingOverlay.classList.remove("hidden");
    }
  } else {
    populateSettingsForm(profile);
  }

  // Onboarding steps navigation
  function showStep(stepNum: number) {
    document.querySelectorAll(".onboarding-step").forEach(step => {
      step.classList.remove("active");
    });
    const activeStep = document.getElementById(`onboarding-step-${stepNum}`);
    if (activeStep) {
      activeStep.classList.add("active");
    }
    document.querySelectorAll(".progress-dot").forEach(dot => {
      const stepAttr = dot.getAttribute("data-step");
      if (stepAttr === stepNum.toString()) {
        dot.classList.add("active");
      } else {
        dot.classList.remove("active");
      }
    });
  }

  const startBtn = document.getElementById("btn-onboarding-start");
  if (startBtn) {
    startBtn.addEventListener("click", () => {
      showStep(2);
    });
  }

  const back1Btn = document.getElementById("btn-onboarding-back-1");
  if (back1Btn) {
    back1Btn.addEventListener("click", () => {
      showStep(1);
    });
  }

  const back2Btn = document.getElementById("btn-onboarding-back-2");
  if (back2Btn) {
    back2Btn.addEventListener("click", () => {
      showStep(2);
    });
  }

  const next2Btn = document.getElementById("btn-onboarding-next-2");
  if (next2Btn) {
    next2Btn.addEventListener("click", async () => {
      const firstNameVal = (document.getElementById("onboarding-first-name") as HTMLInputElement).value.trim();
      const emailVal = (document.getElementById("onboarding-email") as HTMLInputElement).value.trim();
      
      if (!firstNameVal) {
        await message('Please enter your First Name.', { title: 'AcreHiveMind' });
        return;
      }
      
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailVal || !emailPattern.test(emailVal)) {
        await message('Please enter a valid Email Address.', { title: 'AcreHiveMind' });
        return;
      }
      
      showStep(3);
    });
  }

  const finishBtn = document.getElementById("btn-onboarding-finish");
  if (finishBtn) {
    finishBtn.addEventListener("click", async () => {
      const addressVal = (document.getElementById("onboarding-address") as HTMLInputElement).value.trim();
      const errDiv = document.getElementById("onboarding-geocode-error");
      const finishText = document.getElementById("btn-finish-text");
      const finishSpinner = document.getElementById("btn-finish-spinner");
      
      if (!addressVal) {
        await message('Please enter your Farm Address.', { title: 'AcreHiveMind' });
        return;
      }

      if (finishText) finishText.textContent = "Locating Farm...";
      if (finishSpinner) finishSpinner.classList.remove("hidden");
      if (errDiv) errDiv.classList.add("hidden");
      finishBtn.setAttribute("disabled", "true");

      const addressInput = document.getElementById("onboarding-address") as HTMLInputElement;

      const finishSetup = async (lat: number, lon: number, finalAddress?: string) => {
        const firstNameVal = (document.getElementById("onboarding-first-name") as HTMLInputElement).value.trim();
        const lastNameVal = (document.getElementById("onboarding-last-name") as HTMLInputElement).value.trim() || undefined;
        const emailVal = (document.getElementById("onboarding-email") as HTMLInputElement).value.trim();
        const climateModelVal = (document.getElementById("onboarding-climate-model") as HTMLSelectElement).value;
        const geminiApiKey = (document.getElementById("onboarding-gemini-key") as HTMLInputElement)?.value.trim();
        const ollamaUrl = (document.getElementById("onboarding-ollama-url") as HTMLInputElement)?.value.trim();
        
        const newProfile: UserProfile = {
          firstName: firstNameVal,
          lastName: lastNameVal,
          email: emailVal,
          address: finalAddress || `Coordinates: ${lat.toFixed(4)}, ${lon.toFixed(4)}`,
          coordinates: { lat, lng: lon },
          climateModel: climateModelVal || "MPI_ESM1_2_XR",
          geminiApiKey: geminiApiKey || undefined,
          ollamaUrl: ollamaUrl || undefined,
          llmProvider: "gemini"
        };
        
        try {
          await invoke("save_user_profile", { profile: newProfile });
          profile = newProfile;
          
          populateSettingsForm(newProfile);
          
          if (mapContainer) {
            initMap("map-container", [lat, lon]);
            await loadFields();
            updateSuggestionVisibility();
          }
          
          if (onboardingOverlay) {
            onboardingOverlay.classList.add("hidden");
          }
        } catch (err) {
          console.error("Failed to save user profile:", err);
          await message('Failed to save profile: ' + err, { title: 'AcreHiveMind' });
        }

        if (finishText) finishText.textContent = "Finish Setup";
        if (finishSpinner) finishSpinner.classList.add("hidden");
        finishBtn.removeAttribute("disabled");
      };

      if (onboardingMode === "coords") {
        const onboardingLatInput = document.getElementById("onboarding-lat") as HTMLInputElement;
        const onboardingLngInput = document.getElementById("onboarding-lng") as HTMLInputElement;
        const isLatValid = validateCoordinate(onboardingLatInput, -90, 90);
        const isLngValid = validateCoordinate(onboardingLngInput, -180, 180);

        if (!isLatValid || !isLngValid) {
          if (!isLatValid) onboardingLatInput.classList.add("invalid");
          if (!isLngValid) onboardingLngInput.classList.add("invalid");
          await message('Please enter valid Latitude (-90 to 90) and Longitude (-180 to 180) coordinates.', { title: 'AcreHiveMind' });
          return;
        }

        const latVal = parseFloat(onboardingLatInput.value);
        const lngVal = parseFloat(onboardingLngInput.value);

        if (finishText) finishText.textContent = "Locating Farm...";
        if (finishSpinner) finishSpinner.classList.remove("hidden");
        if (errDiv) errDiv.classList.add("hidden");
        finishBtn.setAttribute("disabled", "true");

        finishSetup(latVal, lngVal);
      } else {
        const addressVal = addressInput.value.trim();
        if (!addressVal) {
          await message('Please enter your Farm Address.', { title: 'AcreHiveMind' });
          return;
        }

        if (finishText) finishText.textContent = "Locating Farm...";
        if (finishSpinner) finishSpinner.classList.remove("hidden");
        if (errDiv) errDiv.classList.add("hidden");
        finishBtn.setAttribute("disabled", "true");

        if (addressInput.dataset.lat && addressInput.dataset.lon) {
          finishSetup(parseFloat(addressInput.dataset.lat), parseFloat(addressInput.dataset.lon), addressVal);
        } else {
          const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(addressVal)}&limit=1`;
          
          fetch(url, {
            headers: {
              'User-Agent': 'Acremind-Tauri-App (teich@example.com)'
            }
          })
            .then(res => res.json())
            .then(data => {
              if (data && data.length > 0) {
                const lat = parseFloat(data[0].lat);
                const lon = parseFloat(data[0].lon);
                finishSetup(lat, lon, addressVal);
              } else {
                throw new Error("Address location not found");
              }
            })
            .catch(err => {
              console.error("Onboarding geocoding failed", err);
              if (errDiv) errDiv.classList.remove("hidden");
              if (finishText) finishText.textContent = "Finish Setup";
              if (finishSpinner) finishSpinner.classList.add("hidden");
              finishBtn.removeAttribute("disabled");
            });
        }
      }
    });
  }

  // Settings form submission and validation logic
  const settingsForm = document.getElementById("settings-profile-form") as HTMLFormElement | null;
  const settingsStatus = document.getElementById("settings-status-message");

  if (settingsForm) {
    settingsForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      
      if (!profile) {
        await message('Please complete onboarding first.', { title: 'AcreHiveMind' });
        return;
      }

      const firstName = (document.getElementById("settings-first-name") as HTMLInputElement).value.trim();
      const lastName = (document.getElementById("settings-last-name") as HTMLInputElement).value.trim() || undefined;
      const email = (document.getElementById("settings-email") as HTMLInputElement).value.trim();
      const address = (document.getElementById("settings-address") as HTMLInputElement).value.trim();
      const latInputEl = document.getElementById("settings-lat") as HTMLInputElement;
      const lngInputEl = document.getElementById("settings-lng") as HTMLInputElement;
      const climateModel = (document.getElementById("settings-climate-model") as HTMLSelectElement).value;
      const llmProvider = (document.getElementById("settings-llm-provider") as HTMLSelectElement).value;
      const geminiApiKey = (document.getElementById("settings-gemini-key") as HTMLInputElement).value.trim();
      const geminiModel = (document.getElementById("settings-gemini-model") as HTMLSelectElement).value;
      const ollamaUrl = (document.getElementById("settings-ollama-url") as HTMLInputElement).value.trim();
      
      const isLatValid = validateCoordinate(latInputEl, -90, 90);
      const isLngValid = validateCoordinate(lngInputEl, -180, 180);

      if (!isLatValid || !isLngValid) {
        if (!isLatValid) latInputEl.classList.add("invalid");
        if (!isLngValid) lngInputEl.classList.add("invalid");
        await message('Please enter valid Latitude (-90 to 90) and Longitude (-180 to 180) coordinates.', { title: 'AcreHiveMind' });
        return;
      }

      const latVal = parseFloat(latInputEl.value);
      const lngVal = parseFloat(lngInputEl.value);

      const btnSave = document.getElementById("btn-save-settings") as HTMLButtonElement | null;
      if (btnSave) btnSave.disabled = true;

      if (settingsStatus) {
        settingsStatus.className = "status-message success";
        settingsStatus.textContent = "Updating profile...";
        settingsStatus.classList.remove("hidden");
      }

      const coordsChanged = latVal !== profile.coordinates.lat || lngVal !== profile.coordinates.lng;
      const addressChanged = address !== profile.address;

      const saveProfileAndNotify = async (lat: number, lng: number) => {
        const updatedProfile: UserProfile = {
          firstName,
          lastName,
          email,
          address: address || `Coordinates: ${lat.toFixed(4)}, ${lng.toFixed(4)}`,
          coordinates: { lat, lng },
          climateModel,
          geminiApiKey: geminiApiKey || undefined,
          geminiModel: geminiModel || undefined,
          ollamaUrl: ollamaUrl || undefined,
          llmProvider,
          tokenUsage: profile?.tokenUsage || 0
        };
        
        try {
          await invoke("save_user_profile", { profile: updatedProfile });
          profile = updatedProfile;

          populateSettingsForm(updatedProfile);
          panMapTo([lat, lng]);

          const currentProviderBadge = document.getElementById("agentic-current-provider");
          if (currentProviderBadge) {
            if (updatedProfile.llmProvider === 'ollama') {
              currentProviderBadge.textContent = 'Ollama';
            } else {
              const mName = (updatedProfile.geminiModel || 'gemini-1.5-flash-latest').replace('models/', '');
              currentProviderBadge.textContent = `Gemini (${mName})`;
            }
          }

          if (settingsStatus) {
            settingsStatus.className = "status-message success";
            settingsStatus.textContent = "Profile updated successfully!";
            settingsStatus.classList.remove("hidden");
            setTimeout(() => {
              settingsStatus.classList.add("hidden");
            }, 3000);
          }
        } catch (err) {
          console.error("Failed to update profile settings:", err);
          if (settingsStatus) {
            settingsStatus.className = "status-message error";
            settingsStatus.textContent = "Failed to update profile on backend.";
            settingsStatus.classList.remove("hidden");
          }
        }
        if (btnSave) btnSave.disabled = false;
      };

      const addressInput = document.getElementById("settings-address") as HTMLInputElement;

      if (coordsChanged) {
        await saveProfileAndNotify(latVal, lngVal);
        delete addressInput.dataset.lat;
        delete addressInput.dataset.lon;
      } else if (addressChanged && address) {
        if (addressInput.dataset.lat && addressInput.dataset.lon) {
          await saveProfileAndNotify(parseFloat(addressInput.dataset.lat), parseFloat(addressInput.dataset.lon));
          delete addressInput.dataset.lat;
          delete addressInput.dataset.lon;
        } else {
          const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&limit=1`;
          fetch(url, {
            headers: {
              'User-Agent': 'Acremind-Tauri-App (teich@example.com)'
            }
          })
            .then(res => res.json())
            .then(async (data) => {
              if (data && data.length > 0) {
                const lat = parseFloat(data[0].lat);
                const lon = parseFloat(data[0].lon);
                await saveProfileAndNotify(lat, lon);
              } else {
                throw new Error("Address location not found");
              }
            })
            .catch(err => {
              console.error("Settings geocoding failed", err);
              if (settingsStatus) {
                settingsStatus.className = "status-message error";
                settingsStatus.textContent = "Failed to locate address. Keeping previous settings.";
                settingsStatus.classList.remove("hidden");
                setTimeout(() => {
                  settingsStatus.classList.add("hidden");
                }, 4000);
              }
              if (btnSave) btnSave.disabled = false;
            });
        }
      } else {
        await saveProfileAndNotify(latVal, lngVal);
      }
    });
  }

  // Factory Reset button
  const btnFactoryReset = document.getElementById('btn-factory-reset');
  if (btnFactoryReset) {
    btnFactoryReset.addEventListener('click', async () => {
      const confirmReset = await confirm("Are you sure you want to reset everything? This will delete all fields and data. You will need to complete onboarding again.", { title: 'AcreHiveMind - Factory Reset', kind: 'warning' });
      if (confirmReset) {
        try {
          await invoke('factory_reset');
          localStorage.removeItem('onboardingComplete');
          localStorage.removeItem('lastWeatherSync');
          localStorage.removeItem('lastWeatherSyncIso');
          window.location.reload();
        } catch (err) {
          console.error("Factory reset failed:", err);
          await message('Factory reset failed: ' + err, { title: 'AcreHiveMind' });
        }
      }
    });
  }

  const btnResetTokens = document.getElementById('btn-reset-tokens');
  if (btnResetTokens) {
    btnResetTokens.addEventListener('click', async () => {
      try {
        await invoke('reset_token_usage');
        if (profile) profile.tokenUsage = 0;
        const display = document.getElementById('settings-token-usage');
        if (display) display.textContent = "0";
      } catch (err) {
        console.error("Failed to reset token usage:", err);
      }
    });
  }

  // Handle onboarding location tabs

  // Theme Toggle Button
  const btnThemeToggle = document.getElementById("btn-theme-toggle");
  if (btnThemeToggle) {
    btnThemeToggle.addEventListener("click", () => {
      const isDark = document.documentElement.getAttribute("data-theme") === "dark";
      if (isDark) {
        document.documentElement.removeAttribute("data-theme");
        localStorage.setItem("theme", "light");
      } else {
        document.documentElement.setAttribute("data-theme", "dark");
        localStorage.setItem("theme", "dark");
      }
    });
  }

  const btnRefreshGemini = document.getElementById("btn-refresh-gemini-models") as HTMLButtonElement | null;
  if (btnRefreshGemini) {
    btnRefreshGemini.addEventListener("click", async () => {
      const geminiKeyInput = document.getElementById("settings-gemini-key") as HTMLInputElement | null;
      const apiKey = geminiKeyInput?.value.trim();
      if (!apiKey) {
        await message("Please enter your Gemini API Key first.", { title: 'AcreHiveMind', kind: 'warning' });
        return;
      }
      
      const originalText = btnRefreshGemini.textContent;
      btnRefreshGemini.textContent = "⌛";
      btnRefreshGemini.disabled = true;

      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        const data = await res.json();
        
        if (data.error) {
          throw new Error(data.error.message);
        }

        const models = data.models || [];
        const generateModels = models.filter((m: any) => 
          m.supportedGenerationMethods && m.supportedGenerationMethods.includes("generateContent")
        );

        const geminiModelSelect = document.getElementById("settings-gemini-model") as HTMLSelectElement | null;
        if (geminiModelSelect) {
          const currentValue = geminiModelSelect.value;
          geminiModelSelect.innerHTML = '';
          for (const m of generateModels) {
            const opt = document.createElement("option");
            opt.value = m.name;
            opt.textContent = m.displayName || m.name.replace('models/', '');
            geminiModelSelect.appendChild(opt);
          }
          // Restore selected value if still available
          if (Array.from(geminiModelSelect.options).some(o => o.value === currentValue)) {
            geminiModelSelect.value = currentValue;
          }
        }
        await message(`Successfully loaded ${generateModels.length} models.`, { title: 'AcreHiveMind' });
      } catch (err: any) {
        await message("Failed to fetch models: " + err.message, { title: 'AcreHiveMind', kind: 'error' });
      } finally {
        btnRefreshGemini.textContent = originalText;
        btnRefreshGemini.disabled = false;
      }
    });
  }

  // Settings coordinates input real-time mini-map preview & validation
  const settingsLatInput = document.getElementById("settings-lat") as HTMLInputElement | null;
  const settingsLngInput = document.getElementById("settings-lng") as HTMLInputElement | null;

  const handleCoordsChange = () => {
    if (settingsLatInput && settingsLngInput) {
      const isLatValid = validateCoordinate(settingsLatInput, -90, 90);
      const isLngValid = validateCoordinate(settingsLngInput, -180, 180);
      if (isLatValid && isLngValid) {
        const lat = parseFloat(settingsLatInput.value);
        const lng = parseFloat(settingsLngInput.value);
        updateMiniMap([lat, lng]);
      }
    }
  };

  if (settingsLatInput) settingsLatInput.addEventListener("input", handleCoordsChange);
  if (settingsLngInput) settingsLngInput.addEventListener("input", handleCoordsChange);

  // Initial render
  renderTable();

  // Initialize Calendar Navigation
  const btnPrevMonth = document.getElementById('btn-prev-month');
  const btnNextMonth = document.getElementById('btn-next-month');
  if (btnPrevMonth) {
    btnPrevMonth.addEventListener('click', () => {
      currentCalendarDate.setMonth(currentCalendarDate.getMonth() - 1);
      renderCalendar();
    });
  }
  if (btnNextMonth) {
    btnNextMonth.addEventListener('click', () => {
      currentCalendarDate.setMonth(currentCalendarDate.getMonth() + 1);
      renderCalendar();
    });
  }

  // NDVI Info Toggle
  const btnToggleNdvi = document.getElementById('btn-toggle-ndvi-info');
  const ndviWidget = document.getElementById('ndvi-info-widget');
  if (btnToggleNdvi && ndviWidget) {
    btnToggleNdvi.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      ndviWidget.classList.add('hidden');
    });
  }

  // UI Elements for Add Field Flow
  const btnAddField = document.getElementById('btn-add-field') as HTMLButtonElement | null;
  const btnEditField = document.getElementById('btn-edit-field') as HTMLButtonElement | null;
  const btnOptimizeField = document.getElementById('btn-optimize-field') as HTMLButtonElement | null;
  const btnDeleteField = document.getElementById('btn-delete-field') as HTMLButtonElement | null;
  const btnAddObstacle = document.getElementById('btn-add-obstacle') as HTMLButtonElement | null;

  let isEditing = false;
  let selectedFieldName: string | null = null;
  let selectedFieldId: number | null = null;
  let previousFieldPointsJson: string | null = null;
  const btnUndoField = document.getElementById('btn-undo-field') as HTMLButtonElement | null;

  // Selection UI Elements
  const selectedFieldInfo = document.getElementById('selected-field-info');
  const fieldInfoText = document.getElementById('field-info-text');
  const btnDeselectField = document.getElementById('btn-deselect-field');

  const selectedObstacleInfo = document.getElementById('selected-obstacle-info');
  const obstacleInfoText = document.getElementById('obstacle-info-text');
  const btnDeselectObstacle = document.getElementById('btn-deselect-obstacle');
  const btnEditObstacle = document.getElementById('btn-edit-obstacle') as HTMLButtonElement | null;
  const btnDeleteObstacle = document.getElementById('btn-delete-obstacle') as HTMLButtonElement | null;
  
  let isEditingObstacle = false;
  let editingObstacleId: number | null = null;

  if (btnDeselectObstacle) {
    btnDeselectObstacle.addEventListener('click', () => {
      deselectCurrentObstacle();
    });
  }

  // Register selection callbacks
  registerSelectionCallbacks(
    (data) => {
      selectedFieldName = data.name;
      const fieldObj = fields.find(f => f.name === data.name);
      selectedFieldId = fieldObj?.id || null;
      if (selectedFieldInfo && fieldInfoText) {
        fieldInfoText.textContent = `Selected Field: ${data.name} (Crop: ${data.crop})`;
        selectedFieldInfo.classList.remove('hidden');
      }
      if (btnAddField) {
        btnAddField.disabled = true;
      }
      if (btnEditField) {
        btnEditField.classList.remove('hidden');
        btnEditField.textContent = 'Edit';
        isEditing = false;
      }
      if (btnOptimizeField) {
        btnOptimizeField.classList.remove('hidden');
      }
      if (btnDeleteField) {
        btnDeleteField.classList.remove('hidden');
      }
      if (btnAddObstacle) {
        btnAddObstacle.classList.remove('hidden');
      }
      if (btnUndoField) {
        btnUndoField.classList.add('hidden');
        previousFieldPointsJson = null;
      }
    },
    () => {
      selectedFieldName = null;
      selectedFieldId = null;
      if (selectedFieldInfo) {
        selectedFieldInfo.classList.add('hidden');
      }
      if (btnAddField) {
        btnAddField.disabled = false;
      }
      if (btnEditField) {
        btnEditField.classList.add('hidden');
        if (isEditing) {
          disableEditMode();
          isEditing = false;
        }
      }
      if (btnOptimizeField) {
        btnOptimizeField.classList.add('hidden');
      }
      if (btnDeleteField) {
        btnDeleteField.classList.add('hidden');
      }
      if (btnAddObstacle) {
        btnAddObstacle.classList.add('hidden');
      }
      if (btnUndoField) {
        btnUndoField.classList.add('hidden');
        previousFieldPointsJson = null;
      }
    },
    (obsData: any) => {
      if (selectedObstacleInfo && obstacleInfoText) {
        obstacleInfoText.textContent = `Selected Obstacle: ${obsData.obstacleType}${obsData.note ? ' - ' + obsData.note : ''}`;
        selectedObstacleInfo.classList.remove('hidden');
      }
      if (btnEditObstacle) {
        btnEditObstacle.classList.remove('hidden');
        btnEditObstacle.textContent = 'Edit Obstacle';
        isEditingObstacle = false;
      }
      if (btnDeleteObstacle) {
        btnDeleteObstacle.classList.remove('hidden');
      }
      if (btnAddField) {
        btnAddField.disabled = true;
      }
    },
    () => {
      if (selectedObstacleInfo) {
        selectedObstacleInfo.classList.add('hidden');
      }
      if (btnEditObstacle) {
        btnEditObstacle.classList.add('hidden');
        if (isEditingObstacle) {
          disableObstacleEditMode();
          isEditingObstacle = false;
        }
      }
      if (btnDeleteObstacle) {
        btnDeleteObstacle.classList.add('hidden');
      }
      if (btnAddField && !selectedFieldName) {
        btnAddField.disabled = false;
      }
    }
  );

  if (btnUndoField) {
    btnUndoField.addEventListener('click', async () => {
      if (selectedFieldId && previousFieldPointsJson) {
        try {
          await invoke("update_field", { fieldId: selectedFieldId, pointsJson: previousFieldPointsJson });
          
          // Refresh fields and deselect to redraw
          const updatedFields: any = await invoke("get_fields");
          fields = updatedFields;
          renderTable();
          
          const idToRestore = selectedFieldId;
          deleteCurrentPolygon();
          
          // Redraw the original field and re-select it
          const restoredField = fields.find(f => f.id === idToRestore);
          if (restoredField) {
             const points = JSON.parse(restoredField.pointsJson || (restoredField as any).points_json);
             const { drawExistingField, selectPolygon } = await import('./map');
             const newPoly = drawExistingField(points, restoredField.name, restoredField.crop);
             if (newPoly) {
                 selectPolygon(newPoly, restoredField.name, restoredField.crop);
             }
          }
          
          btnUndoField.classList.add('hidden');
          previousFieldPointsJson = null;
          await message("Optimization undone.", { title: 'AcreHiveMind' });
        } catch (err) {
          await message("Failed to undo optimization: " + err, { title: 'AcreHiveMind' });
        }
      }
    });
  }

  if (btnEditField) {
    btnEditField.addEventListener('click', async () => {
      if (!isEditing) {
        enableEditMode();
        btnEditField.textContent = 'Save Changes';
        if (btnAddObstacle) btnAddObstacle.classList.remove('hidden');
        isEditing = true;
        
        // Save state for undo
        previousFieldPointsJson = fields.find(f => f.id === selectedFieldId)?.pointsJson || null;
      } else {
        disableEditMode();
        btnEditField.textContent = 'Edit';
        if (btnAddObstacle) btnAddObstacle.classList.add('hidden');
        isEditing = false;
        
        if (btnUndoField) btnUndoField.classList.add('hidden');
        previousFieldPointsJson = null;
        
        // Save the manual changes to backend
        try {
          const { getSelectedFieldPolygonPoints } = await import('./map');
          const points = getSelectedFieldPolygonPoints();
          if (points.length > 0 && selectedFieldId) {
            const pointsJson = JSON.stringify(points);
            await invoke("update_field", { fieldId: selectedFieldId, pointsJson });
            const updatedFields: any = await invoke("get_fields");
            fields = updatedFields;
          }
        } catch (e) {
          await message("Failed to save field edits: " + e, { title: 'AcreHiveMind' });
        }
      }
    });
  }

  if (btnDeleteField) {
    btnDeleteField.addEventListener('click', async () => {
      if (selectedFieldName && await confirm(`Are you sure you want to delete "${selectedFieldName}"?`, { title: 'AcreHiveMind', kind: 'warning' })) {
        try {
          await invoke("delete_field", { name: selectedFieldName });
          // Remove from map and trigger deselect callbacks
          deleteCurrentPolygon();
          
          // Remove from state array
          const index = fields.findIndex(f => f.name === selectedFieldName);
          if (index > -1) {
            fields.splice(index, 1);
            renderTable();
            updateSuggestionVisibility();
          }
        } catch (err) {
          console.error("Failed to delete field:", err);
          await message('Failed to delete field: ' + err, { title: 'AcreHiveMind' });
        }
      }
    });
  }

  if (btnOptimizeField) {
    btnOptimizeField.addEventListener('click', async () => {
      if (selectedFieldId) {
        try {
          btnOptimizeField.textContent = "Optimizing...";
          btnOptimizeField.disabled = true;
          // Save for undo
          const oldPointsJsonToRestore = fields.find(f => f.id === selectedFieldId)?.pointsJson || null;
          
          const result: any = await invoke("optimize_field", { fieldId: selectedFieldId });
          const updatedField = result[0];
          const debugBase64 = result[1];
          
          // Re-draw field
          deleteCurrentPolygon();
          const points = JSON.parse(updatedField.pointsJson || updatedField.points_json);
          const newPolygon = drawExistingField(points, updatedField.name, updatedField.crop);
          
          if (newPolygon) {
            selectPolygon(newPolygon, updatedField.name, updatedField.crop);
          }
          
          // Show undo button again after selection callbacks
          previousFieldPointsJson = oldPointsJsonToRestore;
          if (btnUndoField) btnUndoField.classList.remove('hidden');
          
          // Redraw obstacles for the field
          if (updatedField.id) {
            const obstacles = await invoke<Obstacle[]>("get_obstacles_for_field", { fieldId: updatedField.id });
            for (const obs of obstacles) {
              drawExistingObstacle(obs);
            }
          }
          
          // Update state array
          const index = fields.findIndex(f => f.id === selectedFieldId);
          if (index > -1) {
            fields[index].pointsJson = updatedField.pointsJson || updatedField.points_json;
          }
          
          if (debugBase64) {
            const debugModal = document.getElementById('debug-modal');
            const debugImg = document.getElementById('debug-image') as HTMLImageElement;
            if (debugModal && debugImg) {
               debugImg.src = "data:image/png;base64," + debugBase64;
               debugModal.classList.remove('hidden');
            }
          }
        } catch (err) {
          console.error("Failed to optimize field:", err);
          await message('Failed to optimize field: ' + err, { title: 'AcreHiveMind' });
        } finally {
          btnOptimizeField.textContent = "Optimize";
          btnOptimizeField.disabled = false;
        }
      }
    });
  }

  const btnCloseDebug = document.getElementById('btn-close-debug');
  if (btnCloseDebug) {
    btnCloseDebug.addEventListener('click', () => {
      const debugModal = document.getElementById('debug-modal');
      if (debugModal) debugModal.classList.add('hidden');
    });
  }


  if (btnEditObstacle) {
    btnEditObstacle.addEventListener('click', () => {
      if (!isEditingObstacle) {
        enableObstacleEditMode();
        btnEditObstacle.textContent = 'Save Changes';
        isEditingObstacle = true;
      } else {
        disableObstacleEditMode();
        btnEditObstacle.textContent = 'Edit Obstacle';
        isEditingObstacle = false;
        
        // When saving changes, open modal to allow updating type/note
        const data = getSelectedObstacleData();
        if (data) {
          const typeInput = document.getElementById('obstacle-type') as HTMLSelectElement;
          const noteInput = document.getElementById('obstacle-note') as HTMLTextAreaElement;
          typeInput.value = data.obstacleType;
          noteInput.value = data.note || "";
          editingObstacleId = data.id;
          
          const obstacleModal = document.getElementById('add-obstacle-modal');
          if (obstacleModal) obstacleModal.classList.remove('hidden');
        }
      }
    });
  }

  if (btnDeleteObstacle) {
    btnDeleteObstacle.addEventListener('click', async () => {
      const data = getSelectedObstacleData();
      if (data && await confirm(`Are you sure you want to delete this obstacle?`, { title: 'AcreHiveMind', kind: 'warning' })) {
        try {
          await invoke("delete_obstacle", { id: data.id });
          deleteCurrentObstacle();
          // Remove from field obstacles state
          const fieldObj = fields.find(f => f.id === data.fieldId);
          if (fieldObj && fieldObj.obstacles) {
            fieldObj.obstacles = fieldObj.obstacles.filter(o => o.id !== data.id);
            const allFields = await invoke<FarmField[]>("get_fields");
            const updatedField = allFields.find(f => f.id === data.fieldId);
            if (updatedField) fieldObj.areaHectares = updatedField.areaHectares;
            renderTable();
          }
        } catch (err) {
          console.error("Failed to delete obstacle:", err);
          await message('Failed to delete obstacle: ' + err, { title: 'AcreHiveMind' });
        }
      }
    });
  }

  if (btnDeselectField) {
    btnDeselectField.addEventListener('click', () => {
      deselectCurrentPolygon();
    });
  }

  // Handle sidebar navigation & View Switching
  const navItems = document.querySelectorAll('.sidebar ul li a');
  const viewContainers = document.querySelectorAll('.view-container');
  
  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      
      const link = item as HTMLElement;
      document.querySelectorAll('.sidebar ul li').forEach(n => n.classList.remove('active'));
      link.parentElement?.classList.add('active');
      
      // Switch view if data-view is present
      const targetViewId = link.getAttribute('data-view');
      
      if (targetViewId) {
        viewContainers.forEach(container => {
          if (container.id === targetViewId) {
            container.classList.remove('hidden');
            container.classList.add('active');
          } else {
            container.classList.remove('active');
            container.classList.add('hidden');
          }
        });
        
        // Show/hide Add Field button based on active view
        if (btnAddField) {
          if (targetViewId === 'map-container') {
            btnAddField.classList.remove('hidden');
          } else {
            btnAddField.classList.add('hidden');
          }
        }
        updateSuggestionVisibility();
        
        if (targetViewId === 'settings-container') {
          loadModelInfo();
          if (profile) populateSettingsForm(profile);
        }
        if (targetViewId === 'schedule-container') {
          renderCalendar();
        }
        if (targetViewId === 'agentic-container') {
          loadChatSessions();
        }
      }
    });
  });
  
  const btnCancelDraw = document.getElementById('btn-cancel-draw');
  const drawingStatus = document.getElementById('drawing-status');
  const modal = document.getElementById('add-field-modal');
  const form = document.getElementById('add-field-form') as HTMLFormElement;
  const btnModalCancel = document.getElementById('btn-modal-cancel');
  
  let currentPolygonLayer: any = null;

  if (btnAddField && drawingStatus) {
    btnAddField.addEventListener('click', () => {
      drawingStatus.classList.remove('hidden');
      updateSuggestionVisibility();
      enableDrawingMode((points, polygonLayer) => {
        // Drawing completed
        drawingStatus.classList.add('hidden');
        currentPolygonLayer = polygonLayer;
        currentDrawnPoints = points.map(p => ({ lat: p.lat, lng: p.lng }));
        if (modal) modal.classList.remove('hidden');
        updateSuggestionVisibility();
      });
    });
  }

  if (btnCancelDraw && drawingStatus) {
    btnCancelDraw.addEventListener('click', () => {
      cancelDrawingMode();
      drawingStatus.classList.add('hidden');
      updateSuggestionVisibility();
    });
  }

  if (btnModalCancel && modal) {
    btnModalCancel.addEventListener('click', () => {
      modal.classList.add('hidden');
      if (currentPolygonLayer) {
        // Remove the unsaved polygon from map
        currentPolygonLayer.remove();
        currentPolygonLayer = null;
      }
      updateSuggestionVisibility();
    });
  }

  if (form && modal) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nameInput = document.getElementById('field-name') as HTMLInputElement;
      const cropInput = document.getElementById('field-crop') as HTMLInputElement;
      const stageInput = document.getElementById('field-stage') as HTMLSelectElement;
      
      const name = nameInput.value;
      const crop = cropInput.value || 'None';
      const stage = stageInput ? stageInput.value : 'Preparing';

      const newField: FarmField = {
        name,
        crop,
        stage,
        pointsJson: JSON.stringify(currentDrawnPoints)
      };

      try {
        const id = await invoke<number>("add_field", { field: newField });
        newField.id = id;

        // Add to state and re-render table BEFORE selecting, so callbacks can find the ID
        fields.push(newField);
        renderTable();
        updateSuggestionVisibility();

        // Setup selection behavior on the polygon layer
        if (currentPolygonLayer) {
          setupPolygonSelection(currentPolygonLayer, name, crop);
          // Immediately select the newly created polygon
          selectPolygon(currentPolygonLayer, name, crop);
        }
      } catch (err) {
        console.error("Failed to add field to database:", err);
        await message('Failed to save field to database: ' + err, { title: 'AcreHiveMind' });
        if (currentPolygonLayer) {
          currentPolygonLayer.remove();
        }
      }

      // Close modal and reset form
      modal.classList.add('hidden');
      form.reset();
      currentPolygonLayer = null;
      currentDrawnPoints = [];
    });
  }
  
  // Obstacle Add Logic
  const obstacleModal = document.getElementById('add-obstacle-modal');
  const obstacleForm = document.getElementById('add-obstacle-form') as HTMLFormElement;
  const btnModalObstacleCancel = document.getElementById('btn-modal-obstacle-cancel');
  let currentObstaclePoints: any[] = [];
  let currentObstacleLayer: any = null;

  if (btnAddObstacle) {
    btnAddObstacle.addEventListener('click', async () => {
      if (!selectedFieldId) {
        await message('Please select a field first.', { title: 'AcreHiveMind' });
        return;
      }
      // Temporarily hide the button
      btnAddObstacle.disabled = true;
      btnAddObstacle.textContent = "Click inside field to draw...";
      
      enableObstacleDrawingMode((points, polygonLayer) => {
        currentObstaclePoints = points.map((p: any) => ({ lat: p.lat, lng: p.lng }));
        currentObstacleLayer = polygonLayer;
        if (obstacleModal) obstacleModal.classList.remove('hidden');
        btnAddObstacle.disabled = false;
        btnAddObstacle.textContent = "Add Obstacle";
      });
    });
  }

  if (btnModalObstacleCancel && obstacleModal) {
    btnModalObstacleCancel.addEventListener('click', () => {
      cancelObstacleDrawingMode();
      if (currentObstacleLayer) {
        currentObstacleLayer.remove();
        currentObstacleLayer = null;
      }
      obstacleModal.classList.add('hidden');
      currentObstaclePoints = [];
      editingObstacleId = null;
    });
  }

  if (obstacleForm && obstacleModal) {
    obstacleForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const typeInput = document.getElementById('obstacle-type') as HTMLSelectElement;
      const noteInput = document.getElementById('obstacle-note') as HTMLTextAreaElement;
      
      if (editingObstacleId !== null) {
        // We are updating an existing obstacle
        const data = getSelectedObstacleData();
        const points = getSelectedObstaclePolygonPoints();
        if (data && points.length > 0) {
          const updatedObstacle: Obstacle = {
            id: editingObstacleId,
            fieldId: data.fieldId,
            obstacleType: typeInput.value,
            pointsJson: JSON.stringify(points),
            note: noteInput.value.trim() || undefined
          };
          try {
            await invoke("update_obstacle", { obstacle: updatedObstacle });
            // Update state
            const fieldObj = fields.find(f => f.id === updatedObstacle.fieldId);
            if (fieldObj && fieldObj.obstacles) {
              const obsIndex = fieldObj.obstacles.findIndex(o => o.id === updatedObstacle.id);
              if (obsIndex > -1) {
                fieldObj.obstacles[obsIndex] = updatedObstacle;
                const allFields = await invoke<FarmField[]>("get_fields");
                const updatedField = allFields.find(f => f.id === updatedObstacle.fieldId);
                if (updatedField) fieldObj.areaHectares = updatedField.areaHectares;
                renderTable();
              }
            }
            // Redraw it clean
            deleteCurrentObstacle();
            drawExistingObstacle(updatedObstacle);
          } catch (err) {
            console.error("Failed to update obstacle in database:", err);
            await message('Failed to update obstacle: ' + err, { title: 'AcreHiveMind' });
          }
        }
      } else {
        // We are creating a new obstacle
        if (!selectedFieldId || currentObstaclePoints.length === 0) {
          obstacleModal.classList.add('hidden');
          return;
        }

        const newObstacle: Obstacle = {
          fieldId: selectedFieldId,
          obstacleType: typeInput.value,
          pointsJson: JSON.stringify(currentObstaclePoints),
          note: noteInput.value.trim() || undefined
        };

        try {
          const id = await invoke<number>("add_obstacle", { obstacle: newObstacle });
          newObstacle.id = id;
          if (currentObstacleLayer) {
            currentObstacleLayer.remove();
          }
          // Update state
          const fieldObj = fields.find(f => f.id === newObstacle.fieldId);
          if (fieldObj) {
            if (!fieldObj.obstacles) fieldObj.obstacles = [];
            fieldObj.obstacles.push(newObstacle);
            const allFields = await invoke<FarmField[]>("get_fields");
            const updatedField = allFields.find(f => f.id === newObstacle.fieldId);
            if (updatedField) fieldObj.areaHectares = updatedField.areaHectares;
            renderTable();
          }
          drawExistingObstacle(newObstacle);
        } catch (err) {
          console.error("Failed to add obstacle to database:", err);
          await message('Failed to save obstacle to database: ' + err, { title: 'AcreHiveMind' });
          if (currentObstacleLayer) {
            currentObstacleLayer.remove();
          }
        }
      }

      obstacleModal.classList.add('hidden');
      obstacleForm.reset();
      currentObstaclePoints = [];
      currentObstacleLayer = null;
      editingObstacleId = null;
    });
  }
  // Add model info loader
  async function loadModelInfo() {
    try {
      const info = await invoke<ModelInfo>('get_model_info');
      const nameEl = document.getElementById('model-name');
      const versionEl = document.getElementById('model-version');
      const updatedEl = document.getElementById('model-updated');
      const statusEl = document.getElementById('model-status');
      
      if (nameEl) nameEl.textContent = info.name;
      if (versionEl) versionEl.textContent = info.version;
      
      if (updatedEl) {
        const ts = parseInt(info.lastUpdated);
        if (!isNaN(ts)) {
          updatedEl.textContent = new Date(ts).toLocaleString();
        } else {
          updatedEl.textContent = info.lastUpdated;
        }
      }
      
      if (statusEl) {
        statusEl.textContent = info.status;
        if (info.status === "Ready") {
          statusEl.style.color = "var(--success-color, #10b981)";
        } else {
          statusEl.style.color = "var(--warning-color, #f59e0b)";
        }
      }
    } catch (e) {
      console.error("Failed to load model info", e);
      const statusEl = document.getElementById('model-status');
      if (statusEl) {
        statusEl.textContent = "Error loading info";
        statusEl.style.color = "var(--error-color, #ef4444)";
      }
    }
  }
  const btnBackToTable = document.getElementById('btn-back-to-table');
  if (btnBackToTable) {
    btnBackToTable.addEventListener('click', () => {
      const detailsView = document.getElementById('field-details-view');
      const tableView = document.getElementById('field-table-view');
      if (detailsView && tableView) {
        detailsView.classList.add('hidden');
        tableView.classList.remove('hidden');
      }
    });
  }

  // Weather Sync
  const btnSyncWeather = document.getElementById('btn-sync-weather') as HTMLButtonElement | null;
  const syncWeatherText = document.getElementById('sync-weather-text');
  const weatherSyncSpinner = document.getElementById('weather-sync-spinner');

  if (btnSyncWeather && syncWeatherText && weatherSyncSpinner) {
    btnSyncWeather.addEventListener('click', async () => {
      btnSyncWeather.disabled = true;
      syncWeatherText.textContent = 'Syncing...';
      weatherSyncSpinner.classList.remove('hidden');

      const progContainer = document.getElementById('weather-sync-progress-container');
      const progBar = document.getElementById('weather-sync-progress-bar');
      const progText = document.getElementById('weather-sync-progress-text');
      if (progContainer) progContainer.classList.remove('hidden');
      if (progBar) progBar.style.width = '0%';
      if (progText) progText.textContent = 'Initializing...';

      try {
        await invoke('trigger_weather_sync');
        for (const f of fields) {
          if (f.id) {
            try {
              f.weatherSummary = await invoke("get_weather_summary", { fieldId: f.id });
            } catch (err) {
              console.error("Failed to refresh weather summary for field", f.id, err);
            }
          }
        }
        renderTable();
        
        const now = new Date();
        const syncTime = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' ' + now.toLocaleDateString();
        localStorage.setItem('lastWeatherSync', syncTime);
        localStorage.setItem('lastWeatherSyncIso', now.toISOString());
        
        const sidebarWeatherText = document.getElementById('sidebar-weather-text');
        const sidebarWeatherDot = document.getElementById('sidebar-weather-dot');
        if (sidebarWeatherText) sidebarWeatherText.textContent = `Weather Updated: ${syncTime}`;
        if (sidebarWeatherDot) sidebarWeatherDot.classList.add('active');
        
        const progText = document.getElementById('weather-sync-progress-text');
        if (progText) progText.textContent = 'Sync complete!';
        const progBar = document.getElementById('weather-sync-progress-bar');
        if (progBar) progBar.style.width = '100%';
        
        // Wait 3 seconds to show completion, then finally block hides it
        await new Promise(resolve => setTimeout(resolve, 3000));
        
      } catch (e) {
        console.error('Weather sync failed:', e);
        await message('Weather sync failed: ' + e, { title: 'AcreHiveMind' });
      } finally {
        btnSyncWeather.disabled = false;
        syncWeatherText.textContent = 'Weather Update';
        weatherSyncSpinner.classList.add('hidden');
        
        // Failsafe hide in case of errors
        const progContainer = document.getElementById('weather-sync-progress-container');
        if (progContainer) progContainer.classList.add('hidden');
      }
    });
  }

  // Setup progress listener
  listen('weather-sync-progress', (event: any) => {
    const payload = event.payload as { step: string; percent: number };
    const progBar = document.getElementById('weather-sync-progress-bar');
    const progText = document.getElementById('weather-sync-progress-text');
    
    if (progBar && payload.percent <= 100) {
      progBar.style.width = `${Math.max(0, payload.percent)}%`;
    }
    if (progText && payload.percent <= 100) {
      progText.textContent = payload.step;
    }
  });

  // Agentic Recommendation Chat Logic
  const chatHistory = document.getElementById('agentic-chat-history');
  const chatForm = document.getElementById('agentic-chat-form') as HTMLFormElement;
  const chatInput = document.getElementById('agentic-chat-input') as HTMLTextAreaElement;
  const btnSettingsClearChat = document.getElementById('btn-settings-clear-chat') as HTMLButtonElement;
  const agenticSidebarList = document.getElementById('agentic-sessions-list');
  const btnAgenticNewChat = document.getElementById('btn-agentic-new-chat') as HTMLButtonElement;
  const activeSessionTitleEl = document.getElementById('agentic-active-session-title');
  
  let chatSessionsLoaded = false;
  let activeSessionId: number | null = null;
  let allSessions: ChatSession[] = [];

  async function loadChatSessions() {
    if (chatSessionsLoaded) return;
    try {
      allSessions = await invoke('get_chat_sessions');
      
      // If no sessions exist, create one
      if (allSessions.length === 0) {
        await invoke('create_chat_session', { title: "New Chat" });
        allSessions = await invoke('get_chat_sessions'); // reload to get the struct
      }
      
      if (!activeSessionId && allSessions.length > 0) {
        activeSessionId = allSessions[0].id;
      }
      
      renderSessionsSidebar();
      if (activeSessionId) {
        await loadChatHistory(activeSessionId);
      }
      
      chatSessionsLoaded = true;
    } catch (e) {
      console.error("Failed to load chat sessions:", e);
    }
  }

  function renderSessionsSidebar() {
    if (!agenticSidebarList) return;
    agenticSidebarList.innerHTML = '';
    
    allSessions.forEach(session => {
      const item = document.createElement('div');
      item.className = `chat-session-item ${session.id === activeSessionId ? 'active' : ''}`;
      
      const titleSpan = document.createElement('span');
      titleSpan.className = 'chat-session-title';
      titleSpan.textContent = session.title;
      
      const delBtn = document.createElement('button');
      delBtn.className = 'session-delete-btn';
      delBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
      delBtn.title = "Delete Chat";
      
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const confirmDelete = await confirm(`Are you sure you want to delete "${session.title}"?`, { title: 'AcreHiveMind', kind: 'warning' });
        if (confirmDelete) {
          await invoke('delete_chat_session', { sessionId: session.id });
          allSessions = allSessions.filter(s => s.id !== session.id);
          
          if (allSessions.length === 0) {
             const newId: number = await invoke('create_chat_session', { title: "New Chat" });
             allSessions = await invoke('get_chat_sessions');
             activeSessionId = newId;
          } else if (activeSessionId === session.id) {
             activeSessionId = allSessions[0].id;
          }
          renderSessionsSidebar();
          if (activeSessionId) await loadChatHistory(activeSessionId);
        }
      });
      
      item.appendChild(titleSpan);
      item.appendChild(delBtn);
      
      item.addEventListener('click', async () => {
        if (activeSessionId !== session.id) {
          activeSessionId = session.id;
          renderSessionsSidebar();
          await loadChatHistory(session.id);
        }
      });
      
      agenticSidebarList.appendChild(item);
    });
    
    if (activeSessionTitleEl) {
      const activeSession = allSessions.find(s => s.id === activeSessionId);
      activeSessionTitleEl.textContent = activeSession ? activeSession.title : "Agentic Recommendation";
    }
  }

  if (btnAgenticNewChat) {
    btnAgenticNewChat.addEventListener('click', async () => {
       const newId: number = await invoke('create_chat_session', { title: "New Chat" });
       allSessions = await invoke('get_chat_sessions');
       activeSessionId = newId;
       renderSessionsSidebar();
       await loadChatHistory(newId);
    });
  }

  async function handleClearChat() {
    if (!activeSessionId) return;
    const confirmClear = await confirm("Are you sure you want to clear the active chat history?", { title: 'AcreHiveMind', kind: 'warning' });
    if (confirmClear) {
      try {
        await invoke("clear_chat_history", { sessionId: activeSessionId });
        if (chatHistory) chatHistory.innerHTML = '';
        await message("Chat history cleared.", { title: 'AcreHiveMind' });
      } catch (e) {
        console.error("Failed to clear chat history:", e);
        await message("Failed to clear chat history: " + e, { title: 'AcreHiveMind' });
      }
    }
  }

  if (btnSettingsClearChat) {
    btnSettingsClearChat.addEventListener('click', handleClearChat);
  }

  async function loadChatHistory(sessionId: number) {
    try {
      const messages: ChatMessage[] = await invoke('get_chat_history', { sessionId });
      if (chatHistory) {
        chatHistory.innerHTML = '';
        for (const msg of messages) {
          await appendMessageToUI(msg);
        }
      }
      setTimeout(scrollToBottom, 100);
    } catch (e) {
      console.error("Failed to load chat history:", e);
    }
  }

  async function appendMessageToUI(msg: ChatMessage) {
    if (!chatHistory) return;
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${msg.role === 'user' ? 'user' : 'assistant'}`;
    
    let contentHtml = msg.content.replace(/\n/g, '<br/>');
    if (msg.role === 'assistant') {
      try {
        const parsed = await marked.parse(msg.content);
        const mathPurifyConfig = {
          ADD_TAGS: ['math', 'maction', 'maligngroup', 'malignmark', 'menclose', 'merror', 'mfenced', 'mfrac', 'mi', 'mlabeledtr', 'multiscripts', 'mn', 'mo', 'mover', 'mpadded', 'mphantom', 'mroot', 'mrow', 'ms', 'mspace', 'msqrt', 'mstyle', 'msub', 'msup', 'msubsup', 'mtable', 'mtd', 'mtext', 'mtr', 'munder', 'munderover', 'semantics', 'annotation', 'annotation-xml'],
          ADD_ATTR: ['display', 'xmlns', 'mathvariant', 'mathcolor', 'mathsize']
        };
        contentHtml = DOMPurify.sanitize(parsed as string, mathPurifyConfig);
      } catch (e) {
        console.error("Markdown parsing failed", e);
      }
    }
    
    let thoughtsHtml = '';
    if (msg.thoughts) {
      try {
        const parsedThoughts = await marked.parse(msg.thoughts);
        const mathPurifyConfig = {
          ADD_TAGS: ['math', 'maction', 'maligngroup', 'malignmark', 'menclose', 'merror', 'mfenced', 'mfrac', 'mi', 'mlabeledtr', 'multiscripts', 'mn', 'mo', 'mover', 'mpadded', 'mphantom', 'mroot', 'mrow', 'ms', 'mspace', 'msqrt', 'mstyle', 'msub', 'msup', 'msubsup', 'mtable', 'mtd', 'mtext', 'mtr', 'munder', 'munderover', 'semantics', 'annotation', 'annotation-xml'],
          ADD_ATTR: ['display', 'xmlns', 'mathvariant', 'mathcolor', 'mathsize']
        };
        const cleanThoughts = DOMPurify.sanitize(parsedThoughts as string, mathPurifyConfig);
        thoughtsHtml = `
          <details class="chat-thoughts">
            <summary>Thinking Process</summary>
            <div class="chat-thoughts-content">${cleanThoughts}</div>
          </details>
        `;
      } catch (e) {
        console.error("Markdown parsing failed for thoughts", e);
      }
    }
    
    bubble.innerHTML = `
      ${thoughtsHtml}
      <div class="content">${contentHtml}</div>
      <span class="timestamp">${new Date(msg.timestamp).toLocaleString()} - ${msg.modelUsed}</span>
    `;
    chatHistory.appendChild(bubble);
  }

  function scrollToBottom() {
    if (chatHistory) {
      chatHistory.scrollTop = chatHistory.scrollHeight;
    }
  }

  function showTypingIndicator() {
    if (!chatHistory) return null;
    const indicator = document.createElement('div');
    indicator.className = 'chat-typing-indicator';
    indicator.innerHTML = '<span></span><span></span><span></span>';
    chatHistory.appendChild(indicator);
    scrollToBottom();
    return indicator;
  }

  async function generateChatTitle(prompt: string, provider: string, profile: UserProfile | null): Promise<string> {
    const instruction = `Generate a very short, concise title (maximum 4 words) for this prompt. Do not include quotes or any other text, just the title itself. Prompt: "${prompt}"`;
    try {
      if (provider === 'gemini') {
        if (!profile?.geminiApiKey) return "New Chat";
        const model = profile.geminiModel || 'models/gemini-1.5-flash-latest';
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${profile.geminiApiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: instruction }] }],
            generationConfig: { maxOutputTokens: 20 }
          })
        });
        if (!res.ok) return "New Chat";
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        return text ? text.replace(/["']/g, '').trim() : "New Chat";
      } else {
        const ollamaUrl = profile?.ollamaUrl || 'http://localhost:11434';
        let selectedModel = 'llama3.2';
        
        try {
          const tagsRes = await fetch(`${ollamaUrl}/api/tags`);
          if (tagsRes.ok) {
            const tagsData = await tagsRes.json();
            if (tagsData.models && tagsData.models.length > 0) {
              const hasLlama = tagsData.models.some((m: any) => m.name.startsWith('llama3.2'));
              if (!hasLlama) selectedModel = tagsData.models[0].name;
            }
          }
        } catch (e) {
          // ignore tag fetch failure
        }
        
        const res = await fetch(`${ollamaUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: selectedModel,
            prompt: instruction,
            stream: false,
            options: { num_predict: 20 }
          })
        });
        if (!res.ok) return "New Chat";
        const data = await res.json();
        return data.response ? data.response.replace(/["']/g, '').trim() : "New Chat";
      }
    } catch (e) {
      console.error("AI Title generation error:", e);
      return "New Chat";
    }
  }

  if (chatForm && chatInput) {
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        chatForm.requestSubmit();
      }
    });

    chatForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const content = chatInput.value.trim();
      if (!content) return;
      chatInput.value = '';

      const provider = profile?.llmProvider || 'gemini';
      
      if (!activeSessionId) {
         console.error("No active session ID!");
         return;
      }
      
      const userMsg: ChatMessage = {
        sessionId: activeSessionId,
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
        modelUsed: provider === 'gemini' ? 'Gemini' : 'Ollama'
      };

      appendMessageToUI(userMsg);
      scrollToBottom();
      try {
        await invoke('add_chat_message', { msg: userMsg });
        
        // Auto-rename session if it's named "New Chat"
        const activeSession = allSessions.find(s => s.id === activeSessionId);
        if (activeSession && activeSession.title === "New Chat") {
           const sessionIdToUpdate = activeSessionId;
           // Run title generation in background so it doesn't block the UI
           generateChatTitle(content, provider, profile).then(async (newTitle) => {
              if (newTitle && newTitle !== "New Chat") {
                 await invoke('update_chat_session_title', { sessionId: sessionIdToUpdate, title: newTitle });
                 const sessionToUpdate = allSessions.find(s => s.id === sessionIdToUpdate);
                 if (sessionToUpdate) {
                    sessionToUpdate.title = newTitle;
                    renderSessionsSidebar();
                 }
              }
           });
        }
      } catch (e) {
        console.error("Failed to save user msg:", e);
      }

      const indicator = showTypingIndicator();

      let historyMessages: ChatMessage[] = [];
      try {
        historyMessages = await invoke('get_chat_history', { sessionId: activeSessionId });
      } catch (e) {
        console.error("Failed to fetch history for LLM", e);
        historyMessages = [userMsg];
      }

      try {
        let assistantContent = '';
        let thoughtsContent = '';
        if (provider === 'gemini') {
          if (!profile?.geminiApiKey) {
            assistantContent = 'Error: Please configure your Gemini API Key in Settings.';
          } else {
            const m = profile.geminiModel || 'models/gemini-1.5-flash-latest';
            
            // 1. Initialize MCP Client over SSE
            const transport = new SSEClientTransport(new URL('http://127.0.0.1:3030/mcp/sse'));
            const mcpClient = new Client({ name: "acremind-frontend", version: "1.0.0" }, { capabilities: {} });
            await mcpClient.connect(transport);
            
            // 2. Fetch available tools from backend
            const { tools } = await mcpClient.listTools();
            const geminiTools = tools.map(t => ({
              name: t.name,
              description: t.description,
              parameters: t.inputSchema
            }));

            // 3. Prepare initial message to Gemini
            let chatMessages = historyMessages.map(msg => ({
              role: msg.role === 'user' ? 'user' : 'model',
              parts: [{ text: msg.content }]
            }));

            const fetchWithTimeout = async (url: string, options: any, timeoutMs = 15000) => {
              const controller = new AbortController();
              const id = setTimeout(() => controller.abort(), timeoutMs);
              try {
                const response = await fetch(url, {
                  ...options,
                  signal: controller.signal
                });
                clearTimeout(id);
                return response;
              } catch (err) {
                clearTimeout(id);
                throw err;
              }
            };

            const makeGeminiRequest = async (messages: any[]) => {
              const res = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/${m}:generateContent?key=${profile!.geminiApiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: messages,
                  systemInstruction: {
                    parts: [{ text: "You are a helpful farming assistant named Agentic Recommendation. Always use your tools to retrieve ground truth data instead of hallucinating. Do NOT introduce yourself or say 'Hello! I am Agentic Recommendation, your farming assistant' in your responses. Get straight to answering the user's question using the data retrieved." }]
                  },
                  tools: geminiTools.length > 0 ? [{ functionDeclarations: geminiTools }] : undefined
                })
              });
              return res;
            };

            let res = await makeGeminiRequest(chatMessages);
            let data = await res.json();
            let accumulatedTokens = 0;
            if (data.usageMetadata && data.usageMetadata.totalTokenCount) {
              accumulatedTokens += data.usageMetadata.totalTokenCount;
            }

            if (data.error) {
              assistantContent = `Gemini API Error: ${data.error.message}`;
            } else {
              // 4. Handle Tool Calls via loop (tool chaining)
              let loopCount = 0;
              const maxLoops = 5;
              while (data.candidates && data.candidates.length > 0 && loopCount < maxLoops) {
                loopCount++;
                const parts = data.candidates[0].content.parts;
                const funcPart = parts.find((p: any) => p.functionCall);
                
                if (funcPart) {
                  const func = funcPart.functionCall;
                  console.log("LLM invoked tool:", func.name, func.args);
                  
                  // Append model's tool call request to chat history payload
                  chatMessages.push(data.candidates[0].content);
                  
                  // Execute the tool locally via MCP with a timeout
                  let toolResultText = "";
                  try {
                    const toolPromise = mcpClient.callTool({
                      name: func.name,
                      arguments: func.args
                    });
                    const timeoutPromise = new Promise((_, reject) => 
                      setTimeout(() => reject(new Error(`MCP Tool call to '${func.name}' timed out after 15s`)), 15000)
                    );
                    const toolResponse = await Promise.race([toolPromise, timeoutPromise]);
                    
                    // Construct the tool response part
                    toolResultText = ((toolResponse as any).content || []).map((c: any) => c.text).join('\n');
                  } catch (e: any) {
                    console.error("Tool execution failed:", e);
                    toolResultText = `Error executing tool: ${e.message || e.toString()}`;
                  }
                  
                  chatMessages.push({
                    role: "function",
                    parts: [{
                      functionResponse: {
                        name: func.name,
                        response: {
                          name: func.name,
                          content: toolResultText
                        }
                      }
                    } as any]
                  });

                  // Send the tool response back to Gemini to continue the loop
                  res = await makeGeminiRequest(chatMessages);
                  data = await res.json();
                  if (data.usageMetadata && data.usageMetadata.totalTokenCount) {
                    accumulatedTokens += data.usageMetadata.totalTokenCount;
                  }
                  
                  if (data.error) {
                    assistantContent = `Gemini API Error: ${data.error.message}`;
                    break;
                  }
                } else {
                  // No more tool calls, we have the final text
                  if (parts.length > 1) {
                    thoughtsContent = parts[0].text;
                    assistantContent = parts.map((p: any) => p.text).filter((t: any) => t).join('\n');
                  } else {
                    assistantContent = parts[0].text;
                  }
                  break;
                }
              }
              
              if (loopCount >= maxLoops) {
                assistantContent = "Error: Stopped execution to prevent an infinite tool call loop.";
              }
              
              if (!assistantContent) {
                assistantContent = "Gemini returned an empty response.";
              }
              
              if (accumulatedTokens > 0) {
                 try {
                   await invoke('increment_token_usage', { amount: accumulatedTokens });
                   if (profile) profile.tokenUsage = (profile.tokenUsage || 0) + accumulatedTokens;
                   const display = document.getElementById('settings-token-usage');
                   if (display) {
                     display.textContent = profile!.tokenUsage!.toString();
                   }
                 } catch (e) {
                   console.error("Failed to increment token usage", e);
                 }
              }
            }
          }
        } else {
          // Ollama
          const ollamaUrl = profile?.ollamaUrl || 'http://localhost:11434';
          let selectedModel = 'llama3.2';
          
          try {
            const tagsRes = await fetch(`${ollamaUrl}/api/tags`);
            if (tagsRes.ok) {
              const tagsData = await tagsRes.json();
              if (tagsData.models && tagsData.models.length > 0) {
                const hasLlama = tagsData.models.some((m: any) => m.name.startsWith('llama3.2'));
                if (!hasLlama) {
                  selectedModel = tagsData.models[0].name;
                  console.log("Auto-selected Ollama model:", selectedModel);
                }
              }
            }
          } catch (e) {
            console.warn("Failed to query Ollama tags API, falling back to llama3.2:", e);
          }

          const ollamaTools = tools.map(t => ({
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.inputSchema
            }
          }));

          const makeOllamaRequest = async (msgs: any[]) => {
            return await fetch(`${ollamaUrl}/api/chat`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: selectedModel,
                messages: msgs,
                tools: ollamaTools.length > 0 ? ollamaTools : undefined,
                stream: false,
                options: { num_ctx: 32768 }
              })
            });
          };

          let ollamaMessages: any[] = [
            { role: 'system', content: "You are a helpful farming assistant named Agentic Recommendation. Always use your tools to retrieve ground truth data instead of hallucinating. Do NOT introduce yourself or say 'Hello! I am Agentic Recommendation, your farming assistant' in your responses. Get straight to answering the user's question using the data retrieved." },
            ...historyMessages.map(msg => ({
              role: msg.role,
              content: msg.content
            }))
          ];

          let res = await makeOllamaRequest(ollamaMessages);
          let data = await res.json();
          let accumulatedTokens = 0;
          if (data.prompt_eval_count) accumulatedTokens += data.prompt_eval_count;
          if (data.eval_count) accumulatedTokens += data.eval_count;

          if (data.error) {
            assistantContent = `Ollama Error: ${data.error}`;
          } else {
            let loopCount = 0;
            while (data.message?.tool_calls && data.message.tool_calls.length > 0 && loopCount < 5) {
              loopCount++;
              ollamaMessages.push(data.message);

              for (const toolCall of data.message.tool_calls) {
                const func = toolCall.function;
                console.log("Ollama invoked tool:", func.name, func.arguments);

                let toolResultText = "";
                try {
                  const parsedArgs = typeof func.arguments === 'string' ? JSON.parse(func.arguments) : func.arguments;
                  const toolPromise = mcpClient.callTool({
                    name: func.name,
                    arguments: parsedArgs
                  });
                  const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error(`MCP Tool call to '${func.name}' timed out after 15s`)), 15000)
                  );
                  const toolResponse = await Promise.race([toolPromise, timeoutPromise]);
                  toolResultText = ((toolResponse as any).content || []).map((c: any) => c.text).join('\n');
                } catch (e: any) {
                  console.error("Tool execution failed:", e);
                  toolResultText = `Error executing tool: ${e.message || e.toString()}`;
                }

                ollamaMessages.push({
                  role: "tool",
                  content: toolResultText,
                  name: func.name
                });
              }

              res = await makeOllamaRequest(ollamaMessages);
              data = await res.json();
              if (data.prompt_eval_count) accumulatedTokens += data.prompt_eval_count;
              if (data.eval_count) accumulatedTokens += data.eval_count;
              
              if (data.error) {
                assistantContent = `Ollama Error: ${data.error}`;
                break;
              }
            }

            if (!data.error) {
              assistantContent = data.message?.content || "";
            }
            
            if (accumulatedTokens > 0) {
               try {
                 await invoke('increment_token_usage', { amount: accumulatedTokens });
                 if (profile) profile.tokenUsage = (profile.tokenUsage || 0) + accumulatedTokens;
                 const display = document.getElementById('settings-token-usage');
                 if (display) {
                   display.textContent = profile!.tokenUsage!.toString();
                 }
               } catch (e) {
                 console.error("Failed to increment token usage", e);
               }
            }
          }
        }

        if (indicator) indicator.remove();

        const assistantMsg: ChatMessage = {
          sessionId: activeSessionId!,
          role: 'assistant',
          content: assistantContent,
          timestamp: new Date().toISOString(),
          modelUsed: provider === 'gemini' ? 'Gemini' : 'Ollama',
          thoughts: thoughtsContent || undefined
        };

        appendMessageToUI(assistantMsg);
        scrollToBottom();
        await invoke('add_chat_message', { msg: assistantMsg });

      } catch (e) {
        console.error("API Error:", e);
        if (indicator) indicator.remove();
        const errorMsg: ChatMessage = {
          sessionId: activeSessionId!,
          role: 'assistant',
          content: `Connection Error: ${e}`,
          timestamp: new Date().toISOString(),
          modelUsed: provider === 'gemini' ? 'Gemini' : 'Ollama'
        };
        appendMessageToUI(errorMsg);
        scrollToBottom();
      }
    });
  }

  // Hide splashscreen and show main window smoothly
  setTimeout(async () => {
    try {
      await invoke("close_splashscreen");
    } catch (e) {
      console.warn("Failed to close splashscreen:", e);
    }
  }, 5000); // 5 second delay before closing the splash screen

});
