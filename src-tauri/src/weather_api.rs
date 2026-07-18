#![allow(dead_code)]
use reqwest::Client;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct OpenMeteoHourlyAdv {
    pub time: Vec<String>,
    pub temperature_2m: Option<Vec<Option<f64>>>,
    pub temperature_180m: Option<Vec<Option<f64>>>,
    pub relative_humidity_2m: Option<Vec<Option<f64>>>,
    pub wind_speed_10m: Option<Vec<Option<f64>>>,
    pub wind_direction_10m: Option<Vec<Option<f64>>>,
    pub precipitation: Option<Vec<Option<f64>>>,
    pub evapotranspiration: Option<Vec<Option<f64>>>,
    pub leaf_wetness_probability: Option<Vec<Option<f64>>>,
    pub soil_temperature_0_to_7cm: Option<Vec<Option<f64>>>,
    pub soil_temperature_7_to_28cm: Option<Vec<Option<f64>>>,
    pub soil_temperature_28_to_100cm: Option<Vec<Option<f64>>>,
    pub soil_temperature_100_to_255cm: Option<Vec<Option<f64>>>,
    pub soil_moisture_0_to_7cm: Option<Vec<Option<f64>>>,
    pub soil_moisture_7_to_28cm: Option<Vec<Option<f64>>>,
    pub soil_moisture_28_to_100cm: Option<Vec<Option<f64>>>,
    pub soil_moisture_100_to_255cm: Option<Vec<Option<f64>>>,
}

#[derive(Debug, Deserialize)]
pub struct OpenMeteoDailyAdv {
    pub time: Vec<String>,
    pub et0_fao_evapotranspiration: Option<Vec<Option<f64>>>,
    pub precipitation_sum: Option<Vec<Option<f64>>>,
}

#[derive(Debug, Deserialize)]
pub struct OpenMeteoAdvResponse {
    pub hourly: Option<OpenMeteoHourlyAdv>,
    pub daily: Option<OpenMeteoDailyAdv>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgronomyMetrics {
    pub delta_t: f64,
    pub inversion_risk: bool,
    pub trafficability_index: f64,
    pub wind_speed: f64,
    pub wind_direction: f64,
    pub temperature_2m: f64,
    pub humidity: f64,
    pub leaf_wetness_prob: f64,
    pub time: Vec<String>,
    pub soil_temp_0_7cm: Vec<f64>,
    pub soil_temp_7_28cm: Vec<f64>,
    pub soil_temp_28_100cm: Vec<f64>,
    pub soil_temp_100_255cm: Vec<f64>,
    pub soil_moist_0_7cm: Vec<f64>,
    pub soil_moist_7_28cm: Vec<f64>,
    pub soil_moist_28_100cm: Vec<f64>,
    pub soil_moist_100_255cm: Vec<f64>,
    pub gdd: f64, // simplified GDD for the current day
}

pub async fn fetch_advanced_agronomy(lat: f64, lng: f64) -> Result<AgronomyMetrics, String> {
    let url = format!(
        "https://api.open-meteo.com/v1/forecast?latitude={}&longitude={}&hourly=temperature_2m,temperature_180m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,precipitation,evapotranspiration,leaf_wetness_probability,soil_temperature_0_to_7cm,soil_temperature_7_to_28cm,soil_temperature_28_to_100cm,soil_temperature_100_to_255cm,soil_moisture_0_to_7cm,soil_moisture_7_to_28cm,soil_moisture_28_to_100cm,soil_moisture_100_to_255cm&daily=et0_fao_evapotranspiration,precipitation_sum,temperature_2m_max,temperature_2m_min&forecast_days=3&timezone=auto",
        lat, lng
    );

    let client = Client::new();
    let res = client.get(&url).send().await.map_err(|e| e.to_string())?;
    
    // We need daily min/max for GDD
    #[derive(Debug, Deserialize)]
    struct DailyForGdd {
        temperature_2m_max: Option<Vec<Option<f64>>>,
        temperature_2m_min: Option<Vec<Option<f64>>>,
    }
    #[derive(Debug, Deserialize)]
    struct RespWithGdd {
        hourly: Option<OpenMeteoHourlyAdv>,
        daily: Option<DailyForGdd>,
    }

    let parsed = res.json::<RespWithGdd>().await.map_err(|e| e.to_string())?;

    let hourly = parsed.hourly.ok_or("No hourly data")?;
    let daily = parsed.daily.ok_or("No daily data")?;

    // Get current hour index roughly (just use index 0 for now as 'current')
    let current_idx = 0;
    let t_2m = hourly.temperature_2m.as_ref().and_then(|v| v.get(current_idx).copied().flatten()).unwrap_or(0.0);
    let t_180m = hourly.temperature_180m.as_ref().and_then(|v| v.get(current_idx).copied().flatten()).unwrap_or(t_2m);
    let rh = hourly.relative_humidity_2m.as_ref().and_then(|v| v.get(current_idx).copied().flatten()).unwrap_or(50.0);
    let wind_spd = hourly.wind_speed_10m.as_ref().and_then(|v| v.get(current_idx).copied().flatten()).unwrap_or(0.0);
    let wind_dir = hourly.wind_direction_10m.as_ref().and_then(|v| v.get(current_idx).copied().flatten()).unwrap_or(0.0);

    // Sum precip and ET for past 48h (we just use the first 48 hours of forecast for a simplistic trafficability)
    let precip_48h: f64 = hourly.precipitation.as_ref().map(|v| v.iter().take(48).filter_map(|x| *x).sum()).unwrap_or(0.0);
    let et_48h: f64 = hourly.evapotranspiration.as_ref().map(|v| v.iter().take(48).filter_map(|x| *x).sum()).unwrap_or(0.0);

    let moist_surf = hourly.soil_moisture_0_to_7cm.as_ref().and_then(|v| v.get(current_idx).copied().flatten()).unwrap_or(0.0);
    let leaf_wetness_prob = hourly.leaf_wetness_probability.as_ref().and_then(|v| v.get(current_idx).copied().flatten()).unwrap_or(0.0);

    let extract_vec = |opt: &Option<Vec<Option<f64>>>| -> Vec<f64> {
        opt.as_ref().map(|v| v.iter().map(|x| x.unwrap_or(0.0)).collect()).unwrap_or_default()
    };

    let st_0_7 = extract_vec(&hourly.soil_temperature_0_to_7cm);
    let st_7_28 = extract_vec(&hourly.soil_temperature_7_to_28cm);
    let st_28_100 = extract_vec(&hourly.soil_temperature_28_to_100cm);
    let st_100_255 = extract_vec(&hourly.soil_temperature_100_to_255cm);

    let sm_0_7 = extract_vec(&hourly.soil_moisture_0_to_7cm);
    let sm_7_28 = extract_vec(&hourly.soil_moisture_7_to_28cm);
    let sm_28_100 = extract_vec(&hourly.soil_moisture_28_to_100cm);
    let sm_100_255 = extract_vec(&hourly.soil_moisture_100_to_255cm);

    // Calculate metrics
    let delta_t = crate::agronomy_math::calculate_delta_t(t_2m, rh);
    let inversion_risk = crate::agronomy_math::check_inversion_risk(t_2m, t_180m);
    let trafficability = crate::agronomy_math::calculate_trafficability(precip_48h, moist_surf, et_48h);

    // GDD (base 10C for corn usually)
    let t_max = daily.temperature_2m_max.as_ref().and_then(|v| v.get(0).copied().flatten()).unwrap_or(10.0);
    let t_min = daily.temperature_2m_min.as_ref().and_then(|v| v.get(0).copied().flatten()).unwrap_or(10.0);
    let avg_t = (t_max + t_min) / 2.0;
    let gdd = (avg_t - 10.0).max(0.0);

    Ok(AgronomyMetrics {
        delta_t,
        inversion_risk,
        trafficability_index: trafficability,
        wind_speed: wind_spd,
        wind_direction: wind_dir,
        temperature_2m: t_2m,
        humidity: rh,
        leaf_wetness_prob,
        time: hourly.time.clone(),
        soil_temp_0_7cm: st_0_7,
        soil_temp_7_28cm: st_7_28,
        soil_temp_28_100cm: st_28_100,
        soil_temp_100_255cm: st_100_255,
        soil_moist_0_7cm: sm_0_7,
        soil_moist_7_28cm: sm_7_28,
        soil_moist_28_100cm: sm_28_100,
        soil_moist_100_255cm: sm_100_255,
        gdd,
    })
}
