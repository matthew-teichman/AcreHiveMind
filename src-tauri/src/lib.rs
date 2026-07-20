use tauri::Manager;

mod db;
mod sam;
mod tiles;
mod weather;
mod agronomy_math;
mod weather_api;
mod satellite;
mod mcp_server;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

fn calculate_net_area(points_json: &str, obstacles: &[db::Obstacle]) -> f64 {
    use geo::{Coord, LineString, Polygon};
    use geo::prelude::GeodesicArea;

    let points: Vec<tiles::LatLng> = serde_json::from_str(points_json).unwrap_or_default();
    if points.is_empty() {
        return 0.0;
    }

    let mut coords: Vec<Coord<f64>> = points.into_iter().map(|p| Coord { x: p.lng, y: p.lat }).collect();
    if let (Some(first), Some(last)) = (coords.first().copied(), coords.last().copied()) {
        if first != last {
            coords.push(first);
        }
    }
    let ls = LineString::new(coords);
    let poly = Polygon::new(ls, vec![]);
    let mut net_area_sqm = poly.geodesic_area_signed().abs();

    for obs in obstacles {
        let obs_points: Vec<tiles::LatLng> = serde_json::from_str(&obs.points_json).unwrap_or_default();
        if obs_points.is_empty() {
            continue;
        }
        let mut obs_coords: Vec<Coord<f64>> = obs_points.into_iter().map(|p| Coord { x: p.lng, y: p.lat }).collect();
        if let (Some(first), Some(last)) = (obs_coords.first().copied(), obs_coords.last().copied()) {
            if first != last {
                obs_coords.push(first);
            }
        }
        let obs_ls = LineString::new(obs_coords);
        let obs_poly = Polygon::new(obs_ls, vec![]);
        net_area_sqm -= obs_poly.geodesic_area_signed().abs();
    }

    if net_area_sqm < 0.0 {
        net_area_sqm = 0.0;
    }

    net_area_sqm / 10000.0
}

fn recalculate_field_area(conn: &rusqlite::Connection, field_id: i64) -> Result<(), String> {
    let fields = db::get_all_fields(conn).map_err(|e| e.to_string())?;
    if let Some(field) = fields.iter().find(|f| f.id == Some(field_id)) {
        let obstacles = db::get_obstacles_for_field(conn, field_id).unwrap_or_default();
        let area = calculate_net_area(&field.points_json, &obstacles);
        db::update_field_area(conn, field_id, area).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn show_main_window(window: tauri::Window) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())
}

#[tauri::command]
async fn close_splashscreen(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(splashscreen) = app.get_webview_window("splashscreen") {
        splashscreen.close().map_err(|e| e.to_string())?;
    }
    if let Some(main_window) = app.get_webview_window("main") {
        main_window.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn get_user_profile(
    state: tauri::State<'_, db::DbState>,
) -> Result<Option<db::UserProfile>, String> {
    // Lock the mutex to get the database connection
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::get_profile(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_user_profile(
    state: tauri::State<'_, db::DbState>,
    profile: db::UserProfile,
) -> Result<(), String> {
    // Lock the mutex to get the database connection
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::save_profile(&conn, &profile).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_fields(state: tauri::State<'_, db::DbState>) -> Result<Vec<db::FarmField>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::get_all_fields(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn add_field(state: tauri::State<'_, db::DbState>, mut field: db::FarmField) -> Result<i64, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let area = calculate_net_area(&field.points_json, &[]);
    field.area_hectares = Some(area);
    db::add_field(&conn, &field).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_field(state: tauri::State<'_, db::DbState>, field_id: i64, points_json: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::update_field(&conn, field_id, &points_json).map_err(|e| e.to_string())?;
    recalculate_field_area(&conn, field_id)?;
    Ok(())
}

#[tauri::command]
fn update_field_stage(state: tauri::State<'_, db::DbState>, field_id: i64, stage: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::update_field_stage(&conn, field_id, &stage).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_field(state: tauri::State<'_, db::DbState>, name: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::delete_field(&conn, &name).map_err(|e| e.to_string())
}

#[tauri::command]
fn factory_reset(state: tauri::State<'_, db::DbState>) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::reset_db(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_weather_summary(state: tauri::State<'_, db::DbState>, field_id: i64) -> Result<db::WeatherSummary, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::get_annual_weather_summary(&conn, field_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_full_field_weather(state: tauri::State<'_, db::DbState>, field_id: i64) -> Result<Vec<db::WeatherData>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::get_full_field_weather(&conn, field_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn add_obstacle(
    state: tauri::State<'_, db::DbState>,
    obstacle: db::Obstacle,
) -> Result<i64, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let id = db::add_obstacle(&conn, &obstacle).map_err(|e| e.to_string())?;
    recalculate_field_area(&conn, obstacle.field_id)?;
    Ok(id)
}

#[tauri::command]
fn get_obstacles_for_field(
    state: tauri::State<'_, db::DbState>,
    field_id: i64,
) -> Result<Vec<db::Obstacle>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::get_obstacles_for_field(&conn, field_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_obstacle(
    state: tauri::State<'_, db::DbState>,
    obstacle: db::Obstacle,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::update_obstacle(&conn, &obstacle).map_err(|e| e.to_string())?;
    recalculate_field_area(&conn, obstacle.field_id)?;
    Ok(())
}

#[tauri::command]
fn delete_obstacle(state: tauri::State<'_, db::DbState>, id: i64) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    
    let field_id: Option<i64> = conn.query_row(
        "SELECT field_id FROM obstacles WHERE id = ?1",
        rusqlite::params![id],
        |row| row.get(0),
    ).ok();

    db::delete_obstacle(&conn, id).map_err(|e| e.to_string())?;

    if let Some(fid) = field_id {
        recalculate_field_area(&conn, fid)?;
    }

    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelInfo {
    name: String,
    version: String,
    last_updated: String,
    status: String,
}

#[tauri::command]
async fn get_model_info(
    state: tauri::State<'_, db::DbState>,
    app: tauri::AppHandle,
) -> Result<ModelInfo, String> {
    let lock = state.sam_models.lock().await;
    let is_ready = lock.is_some();

    let app_data_dir = app.path().app_data_dir().unwrap();
    let encoder_path = app_data_dir.join("mobile_sam_encoder.onnx");

    let last_updated = if let Ok(metadata) = std::fs::metadata(&encoder_path) {
        if let Ok(modified) = metadata.modified() {
            if let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) {
                format!("{}", duration.as_secs() * 1000)
            } else {
                "Unknown".into()
            }
        } else {
            "Unknown".into()
        }
    } else {
        "Not Downloaded".into()
    };

    Ok(ModelInfo {
        name: "MobileSAM".into(),
        version: "1.0.0".into(),
        last_updated,
        status: if is_ready {
            "Ready".into()
        } else {
            "Downloading/Initializing...".into()
        },
    })
}

use base64::Engine;

#[tauri::command]
async fn optimize_field(
    _app: tauri::AppHandle,
    state: tauri::State<'_, db::DbState>,
    field_id: i64,
) -> Result<(db::FarmField, String), String> {
    // 1. Get field and obstacles
    let (mut field, obstacles) = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;

        let fields = db::get_all_fields(&conn).map_err(|e| e.to_string())?;
        let field = fields
            .into_iter()
            .find(|f| f.id == Some(field_id))
            .ok_or("Field not found")?;

        let obstacles = db::get_obstacles_for_field(&conn, field_id).unwrap_or_default();
        (field, obstacles)
    };

    let points: Vec<tiles::LatLng> =
        serde_json::from_str(&field.points_json).map_err(|e| e.to_string())?;

    // 2. Compute Bounding Box
    if points.is_empty() {
        return Err("Field has no points".into());
    }
    let mut min_lat = points[0].lat;
    let mut max_lat = points[0].lat;
    let mut min_lng = points[0].lng;
    let mut max_lng = points[0].lng;
    for p in &points {
        if p.lat < min_lat {
            min_lat = p.lat;
        }
        if p.lat > max_lat {
            max_lat = p.lat;
        }
        if p.lng < min_lng {
            min_lng = p.lng;
        }
        if p.lng > max_lng {
            max_lng = p.lng;
        }
    }
    let bbox = tiles::BBox {
        min_lat,
        max_lat,
        min_lng,
        max_lng,
    };

    // 3. Download Map Image
    let map_context = tiles::download_map_image(&bbox).await?;

    // 4. Run SAM inference
    let mut models_lock = state.sam_models.lock().await;
    let models = models_lock
        .as_mut()
        .ok_or("Model is not ready yet. Please wait.")?;

    let segmented_points = sam::run_sam_inference(models, &map_context, &points)?;

    // 6. Subtract Obstacles
    let mut obs_polys = vec![];
    for obs in obstacles {
        let obs_pts: Vec<tiles::LatLng> =
            serde_json::from_str(&obs.points_json).unwrap_or_default();
        obs_polys.push(obs_pts);
    }
    let final_points = sam::simplify_and_subtract_obstacles(segmented_points, obs_polys);

    // 7. Update DB
    field.points_json = serde_json::to_string(&final_points).map_err(|e| e.to_string())?;
    {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE fields SET points_json = ?1 WHERE id = ?2",
            rusqlite::params![field.points_json, field.id],
        )
        .map_err(|e| e.to_string())?;
        if let Some(id) = field.id {
            recalculate_field_area(&conn, id)?;
            // Refresh field object
            let fields = db::get_all_fields(&conn).map_err(|e| e.to_string())?;
            if let Some(f) = fields.into_iter().find(|f| f.id == Some(id)) {
                field = f;
            }
        }
    }

    // 8. Load debug image to base64
    let debug_path = std::env::temp_dir().join("segmented_mask_debug.png");
    let debug_img_b64 = if let Ok(bytes) = std::fs::read(&debug_path) {
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    } else {
        String::new()
    };
    Ok((field, debug_img_b64))
}

pub async fn get_field_statistics_inner(
    db_state: &db::DbState,
    field_id: i64,
) -> Result<crate::weather_api::AgronomyMetrics, String> {
    let (lat, lng) = {
        // 1. Check Cache
        let conn_lock = db_state.conn.lock().map_err(|e| e.to_string())?;
        
        if let Ok(Some((cached_json, minutes_old))) = db::get_agronomy_cache(&conn_lock, field_id) {
            if minutes_old < 6 * 60 {
                // Cache is fresh (less than 6 hours old)
                if let Ok(metrics) = serde_json::from_str::<crate::weather_api::AgronomyMetrics>(&cached_json) {
                    return Ok(metrics);
                }
            }
        }
        
        // 2. Need to fetch. Get coordinates.
        let fields = db::get_all_fields(&conn_lock).map_err(|e| e.to_string())?;
        let field = fields.into_iter().find(|f| f.id == Some(field_id)).ok_or("Field not found")?;
        
        // Calculate centroid (we'll reuse the logic from weather module or write a simple one here)
        #[derive(serde::Deserialize)]
        struct Point { lat: f64, lng: f64 }
        let points: Vec<Point> = serde_json::from_str(&field.points_json).map_err(|e| e.to_string())?;
        
        if points.is_empty() {
            return Err("Field has no coordinates".into());
        }
        let mut sum_lat = 0.0;
        let mut sum_lng = 0.0;
        for p in &points {
            sum_lat += p.lat;
            sum_lng += p.lng;
        }
        let count = points.len() as f64;
        let lat = sum_lat / count;
        let lng = sum_lng / count;
        (lat, lng)
    };

    // 3. Fetch from API
    let metrics = crate::weather_api::fetch_advanced_agronomy(lat, lng).await?;
    
    // 4. Save to cache
    if let Ok(json) = serde_json::to_string(&metrics) {
        let conn_lock_again = db_state.conn.lock().map_err(|e| e.to_string())?;
        let _ = db::set_agronomy_cache(&conn_lock_again, field_id, &json);
    }
    
    Ok(metrics)
}

#[tauri::command]
async fn get_field_statistics(
    state: tauri::State<'_, db::DbState>,
    field_id: i64,
) -> Result<crate::weather_api::AgronomyMetrics, String> {
    get_field_statistics_inner(&state, field_id).await
}

#[tauri::command]
fn get_chat_sessions(state: tauri::State<'_, db::DbState>) -> Result<Vec<db::ChatSession>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::get_chat_sessions(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_chat_session(state: tauri::State<'_, db::DbState>, title: String) -> Result<i64, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::create_chat_session(&conn, &title).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_chat_session_title(state: tauri::State<'_, db::DbState>, session_id: i64, title: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::update_chat_session_title(&conn, session_id, &title).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_chat_session(state: tauri::State<'_, db::DbState>, session_id: i64) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::delete_chat_session(&conn, session_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_chat_history(state: tauri::State<'_, db::DbState>, session_id: i64) -> Result<Vec<db::ChatMessage>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::get_chat_history(&conn, session_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn add_chat_message(state: tauri::State<'_, db::DbState>, msg: db::ChatMessage) -> Result<i64, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::add_chat_message(&conn, &msg).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_chat_history(state: tauri::State<'_, db::DbState>, session_id: i64) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::clear_chat_history(&conn, session_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn increment_token_usage(state: tauri::State<'_, db::DbState>, amount: i64) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::increment_token_usage(&conn, amount).map_err(|e| e.to_string())
}

#[tauri::command]
fn reset_token_usage(state: tauri::State<'_, db::DbState>) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    db::reset_token_usage(&conn).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Resolve the standard application data folder for our app.
            // On Windows, this is %APPDATA%/com.acremind
            let app_data_dir = app.path().app_data_dir().map_err(|e| {
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("Failed to resolve app data directory: {}", e),
                )) as Box<dyn std::error::Error>
            })?;

            // Ensure the directory exists
            std::fs::create_dir_all(&app_data_dir)?;

            // Database file path: app_data_dir/acremind.db
            let db_path = app_data_dir.join("acremind.db");

            // Initialize connection and tables
            let conn = db::init_db(db_path).map_err(|e| {
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("Failed to initialize database: {}", e),
                )) as Box<dyn std::error::Error>
            })?;

            if let Ok(fields) = db::get_all_fields(&conn) {
                for f in fields {
                    if let Some(id) = f.id {
                        let _ = recalculate_field_area(&conn, id);
                    }
                }
            }

            // Store the database state in Tauri's memory manager
            app.manage(db::DbState {
                conn: std::sync::Mutex::new(conn),
                sam_models: tokio::sync::Mutex::new(None),
            });

            // Start background download/initialization
            let app_handle = app.handle().clone();
            let app_data_dir_clone = app_data_dir.clone();
            tauri::async_runtime::spawn(async move {
                match crate::sam::init_sam_models(&app_data_dir_clone).await {
                    Ok(models) => {
                        let state = app_handle.state::<db::DbState>();
                        let mut lock = state.sam_models.lock().await;
                        *lock = Some(models);
                    }
                    Err(e) => {
                        eprintln!("Failed to initialize SAM models: {}", e);
                    }
                }
                
                // Spawn the background weather sync task
                let handle_for_weather = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    crate::weather::sync_weather_for_fields(handle_for_weather).await;
                });
            });

            // Start Axum microservice for satellite processing and MCP
            let axum_app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                crate::satellite::start_server(axum_app_handle).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            get_user_profile,
            save_user_profile,
            get_fields,
            add_field,
            update_field,
            update_field_stage,
            delete_field,
            factory_reset,
            add_obstacle,
            get_obstacles_for_field,
            update_obstacle,
            delete_obstacle,
            optimize_field,
            get_model_info,
            get_weather_summary,
            get_full_field_weather,
            get_field_statistics,
            crate::weather::trigger_weather_sync,
            show_main_window,
            close_splashscreen,
            get_chat_sessions,
            create_chat_session,
            update_chat_session_title,
            delete_chat_session,
            get_chat_history,
            add_chat_message,
            clear_chat_history,
            increment_token_usage,
            reset_token_usage,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
