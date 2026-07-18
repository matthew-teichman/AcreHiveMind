use chrono::{Datelike, Days, NaiveDate, Utc};
use reqwest::Client;
use serde::Deserialize;
use crate::db::{self, WeatherData};
use rusqlite::Connection;
use tauri::{Manager, Emitter};

#[derive(Clone, serde::Serialize)]
struct ProgressPayload {
    step: String,
    percent: f64,
}

#[derive(Debug, Deserialize)]
struct OpenMeteoDaily {
    time: Vec<String>,
    precipitation_sum: Option<Vec<Option<f64>>>,
    shortwave_radiation_sum: Option<Vec<Option<f64>>>,
    et0_fao_evapotranspiration: Option<Vec<Option<f64>>>,
    // For historical
    soil_temperature_0_to_7cm_mean: Option<Vec<Option<f64>>>,
    soil_moisture_0_to_7cm_mean: Option<Vec<Option<f64>>>,
    // For climate
    temperature_2m_mean: Option<Vec<Option<f64>>>,
    temperature_2m_max: Option<Vec<Option<f64>>>,
    temperature_2m_min: Option<Vec<Option<f64>>>,
    weather_code: Option<Vec<Option<i32>>>,
}

#[derive(Debug, Deserialize)]
struct OpenMeteoHourly {
    time: Vec<String>,
    soil_temperature_6cm: Option<Vec<Option<f64>>>,
    soil_moisture_3_9cm: Option<Vec<Option<f64>>>,
}

#[derive(Debug, Deserialize)]
struct OpenMeteoResponse {
    daily: Option<OpenMeteoDaily>,
    hourly: Option<OpenMeteoHourly>,
}

pub async fn sync_weather_for_fields(app_handle: tauri::AppHandle) {
    let app_data_dir = app_handle.path().app_data_dir().unwrap();
    let db_path = app_data_dir.join("acremind.db");
    
    // 1. Get all fields
    let fields = {
        let conn = Connection::open(&db_path).unwrap();
        db::get_all_fields(&conn).unwrap_or_default()
    };

    let client = Client::new();

    let total_fields = fields.len() as f64;
    let mut field_idx = 0.0;

    for field in fields {
        let percent_base = (field_idx / total_fields) * 100.0;
        let percent_step = 100.0 / total_fields;

        let field_id = field.id.unwrap();
        // Calculate centroid
        let (lat, lng) = calculate_centroid(&field.points_json);
        
        let _ = app_handle.emit("weather-sync-progress", ProgressPayload {
            step: format!("Fetching historical data for {}...", field.name),
            percent: percent_base + (percent_step * 0.1),
        });
        
        let today = Utc::now().date_naive();
        let yesterday = today.checked_sub_days(Days::new(1)).unwrap_or(today);
        let five_years_ago = today.checked_sub_days(Days::new(5 * 365)).unwrap_or(today);

        // Fetch latest historical date
        let latest_date = {
            let conn = Connection::open(&db_path).unwrap();
            db::get_latest_historical_date(&conn, field_id).unwrap_or(None)
        };

        let start_date = if let Some(latest_str) = latest_date {
            if let Ok(date) = NaiveDate::parse_from_str(&latest_str, "%Y-%m-%d") {
                date.checked_add_days(Days::new(1)).unwrap_or(date)
            } else {
                five_years_ago
            }
        } else {
            five_years_ago
        };

        // HISTORICAL FETCH
        if start_date <= yesterday {
            let hist_url = format!(
                "https://archive-api.open-meteo.com/v1/archive?latitude={}&longitude={}&start_date={}&end_date={}&daily=precipitation_sum,shortwave_radiation_sum,et0_fao_evapotranspiration,soil_temperature_0_to_7cm_mean,soil_moisture_0_to_7cm_mean,temperature_2m_max,temperature_2m_min,weather_code&timezone=auto",
                lat, lng, start_date.format("%Y-%m-%d"), yesterday.format("%Y-%m-%d")
            );
            
            if let Ok(res) = client.get(&hist_url).send().await {
                if let Ok(parsed) = res.json::<OpenMeteoResponse>().await {
                    if let Some(daily) = parsed.daily {
                        let weather_data = map_daily_to_weather_data(field_id, "historical", daily);
                        let conn = Connection::open(&db_path).unwrap();
                        let _ = db::upsert_weather_data(&conn, &weather_data);
                    }
                }
            }
        }

        let _ = app_handle.emit("weather-sync-progress", ProgressPayload {
            step: format!("Fetching 16-day forecast for {}...", field.name),
            percent: percent_base + (percent_step * 0.6),
        });

        // FORECAST FETCH (16 days)
        let forecast_url = format!(
            "https://api.open-meteo.com/v1/forecast?latitude={}&longitude={}&daily=precipitation_sum,shortwave_radiation_sum,et0_fao_evapotranspiration,temperature_2m_max,temperature_2m_min,weather_code&hourly=soil_temperature_6cm,soil_moisture_3_9cm&forecast_days=16&timezone=auto",
            lat, lng
        );
        if let Ok(res) = client.get(&forecast_url).send().await {
            if let Ok(parsed) = res.json::<OpenMeteoResponse>().await {
                // For forecast, we manually aggregate the hourly soil data to daily.
                let mut daily_weather = map_daily_to_weather_data(field_id, "forecast", parsed.daily.unwrap_or(OpenMeteoDaily {
                    time: vec![], precipitation_sum: None, shortwave_radiation_sum: None, et0_fao_evapotranspiration: None,
                    soil_temperature_0_to_7cm_mean: None, soil_moisture_0_to_7cm_mean: None, temperature_2m_mean: None,
                    temperature_2m_max: None, temperature_2m_min: None, weather_code: None
                }));
                
                if let Some(hourly) = parsed.hourly {
                    aggregate_hourly_to_daily(&mut daily_weather, hourly);
                }
                
                let conn = Connection::open(&db_path).unwrap();
                let _ = db::delete_weather_data_by_type(&conn, field_id, "forecast");
                let _ = db::upsert_weather_data(&conn, &daily_weather);
            }
        }

        let _ = app_handle.emit("weather-sync-progress", ProgressPayload {
            step: format!("Fetching climate outlook for {}...", field.name),
            percent: percent_base + (percent_step * 0.8),
        });

        // CLIMATE FORECAST FETCH (Rest of year)
        let end_of_year = NaiveDate::from_ymd_opt(today.year(), 12, 31).unwrap();
        let climate_start = today.checked_add_days(Days::new(16)).unwrap_or(today);
        if climate_start <= end_of_year {
            let climate_model = {
                let conn = Connection::open(&db_path).unwrap();
                if let Ok(Some(profile)) = db::get_profile(&conn) {
                    profile.climate_model.unwrap_or_else(|| "MPI_ESM1_2_XR".to_string())
                } else {
                    "MPI_ESM1_2_XR".to_string()
                }
            };
            
            let climate_url = format!(
                "https://climate-api.open-meteo.com/v1/climate?latitude={}&longitude={}&start_date={}&end_date={}&models={}&daily=precipitation_sum,shortwave_radiation_sum,et0_fao_evapotranspiration,temperature_2m_mean,temperature_2m_max,temperature_2m_min",
                lat, lng, climate_start.format("%Y-%m-%d"), end_of_year.format("%Y-%m-%d"), climate_model
            );
            if let Ok(res) = client.get(&climate_url).send().await {
                if let Ok(parsed) = res.json::<OpenMeteoResponse>().await {
                    if let Some(daily) = parsed.daily {
                        let weather_data = map_daily_to_weather_data(field_id, "climate", daily);
                        let conn = Connection::open(&db_path).unwrap();
                        let _ = db::delete_weather_data_by_type(&conn, field_id, "climate");
                        let _ = db::upsert_weather_data(&conn, &weather_data);
                    }
                }
            }
        }
        
        field_idx += 1.0;
    }

    let _ = app_handle.emit("weather-sync-progress", ProgressPayload {
        step: "Sync complete!".to_string(),
        percent: 100.0,
    });
}

fn calculate_centroid(points_json: &str) -> (f64, f64) {
    #[derive(Deserialize)]
    struct Point { lat: f64, lng: f64 }
    
    if let Ok(points) = serde_json::from_str::<Vec<Point>>(points_json) {
        if points.is_empty() { return (0.0, 0.0); }
        let mut sum_lat = 0.0;
        let mut sum_lng = 0.0;
        for p in &points {
            sum_lat += p.lat;
            sum_lng += p.lng;
        }
        let count = points.len() as f64;
        return (sum_lat / count, sum_lng / count);
    }
    (0.0, 0.0)
}

fn map_daily_to_weather_data(field_id: i64, data_type: &str, daily: OpenMeteoDaily) -> Vec<WeatherData> {
    let mut results = Vec::new();
    let count = daily.time.len();
    
    for i in 0..count {
        let precip = daily.precipitation_sum.as_ref().and_then(|v| v.get(i).copied().flatten()).unwrap_or(0.0);
        let sun = daily.shortwave_radiation_sum.as_ref().and_then(|v| v.get(i).copied().flatten()).unwrap_or(0.0);
        let et = daily.et0_fao_evapotranspiration.as_ref().and_then(|v| v.get(i).copied().flatten()).unwrap_or(0.0);
        
        // Try to get soil temp/moist from either historical or climate vars
        let soil_temp = daily.soil_temperature_0_to_7cm_mean.as_ref().and_then(|v| v.get(i).copied().flatten())
            .or_else(|| daily.temperature_2m_mean.as_ref().and_then(|v| v.get(i).copied().flatten()))
            .unwrap_or(0.0);
            
        let soil_moist = daily.soil_moisture_0_to_7cm_mean.as_ref().and_then(|v| v.get(i).copied().flatten())
            .unwrap_or(0.0);

        let temp_max = daily.temperature_2m_max.as_ref().and_then(|v| v.get(i).copied().flatten());
        let temp_min = daily.temperature_2m_min.as_ref().and_then(|v| v.get(i).copied().flatten());
        let wcode = daily.weather_code.as_ref().and_then(|v| v.get(i).copied().flatten());

        results.push(WeatherData {
            id: None,
            field_id,
            date: daily.time[i].clone(),
            data_type: data_type.to_string(),
            precipitation: precip,
            sun_exposure: sun,
            soil_temp_0_7cm: soil_temp,
            soil_moisture_0_7cm: soil_moist,
            evapotranspiration: et,
            temperature_max: temp_max,
            temperature_min: temp_min,
            weather_code: wcode,
        });
    }
    
    results
}

fn aggregate_hourly_to_daily(daily_data: &mut Vec<WeatherData>, hourly: OpenMeteoHourly) {
    use std::collections::HashMap;
    // group by date (YYYY-MM-DD) which is first 10 chars of time
    let mut temp_sums: HashMap<String, (f64, usize)> = HashMap::new();
    let mut moist_sums: HashMap<String, (f64, usize)> = HashMap::new();

    for (i, time_str) in hourly.time.iter().enumerate() {
        if time_str.len() >= 10 {
            let date = &time_str[0..10];
            if let Some(Some(t)) = hourly.soil_temperature_6cm.as_ref().map(|v| v.get(i).copied().flatten()) {
                let entry = temp_sums.entry(date.to_string()).or_insert((0.0, 0));
                entry.0 += t;
                entry.1 += 1;
            }
            if let Some(Some(m)) = hourly.soil_moisture_3_9cm.as_ref().map(|v| v.get(i).copied().flatten()) {
                let entry = moist_sums.entry(date.to_string()).or_insert((0.0, 0));
                entry.0 += m;
                entry.1 += 1;
            }
        }
    }

    for daily in daily_data.iter_mut() {
        if let Some((sum, count)) = temp_sums.get(&daily.date) {
            if *count > 0 {
                daily.soil_temp_0_7cm = sum / (*count as f64);
            }
        }
        if let Some((sum, count)) = moist_sums.get(&daily.date) {
            if *count > 0 {
                daily.soil_moisture_0_7cm = sum / (*count as f64);
            }
        }
    }
}

#[tauri::command]
pub async fn trigger_weather_sync(app_handle: tauri::AppHandle) -> Result<(), String> {
    sync_weather_for_fields(app_handle).await;
    Ok(())
}
