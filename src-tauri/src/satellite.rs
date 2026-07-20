use axum::{
    routing::{post, get},
    Router,
    Json,
    extract::{State, Query},
    response::IntoResponse,
    http::{header, StatusCode, Method},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::net::SocketAddr;
use reqwest::Client;
use tower_http::cors::{CorsLayer, Any};
use std::io::Cursor;
use image::{ImageBuffer, Rgba};
use gdal::Dataset;
use tauri::Manager;

#[derive(Deserialize)]
pub struct NdviRequest {
    pub points: Vec<crate::tiles::LatLng>, 
}

#[derive(Deserialize)]
pub struct NdviQuery {
    #[serde(rename = "fieldId")]
    pub field_id: Option<i64>,
}

#[derive(Serialize)]
pub struct StacQuery {
    pub collections: Vec<String>,
    pub intersects: Value,
    pub sortby: Vec<Value>,
    #[serde(rename = "query")]
    pub query_filter: Value,
}

pub fn create_router(app_handle: tauri::AppHandle) -> Router {
    Router::new()
        .route("/api/ndvi", post(handle_ndvi).get(handle_ndvi_get))
        .with_state(app_handle)
}

pub async fn start_server(app_handle: tauri::AppHandle) {
    // GDAL config for /vsicurl/
    gdal::config::set_config_option("GDAL_HTTP_UNSAFESSL", "YES").unwrap();
    gdal::config::set_config_option("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", "tif").unwrap();

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::POST, Method::GET])
        .allow_headers(Any);

    let mcp_router = crate::mcp_server::create_mcp_router(app_handle.clone());
    let app = create_router(app_handle).merge(mcp_router).layer(cors);
    let addr = SocketAddr::from(([127, 0, 0, 1], 3030));
    println!("Axum microservice listening on {}", addr);
    
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn handle_ndvi_get(
    State(app_handle): State<tauri::AppHandle>,
    Query(query): Query<NdviQuery>,
) -> impl IntoResponse {
    let field_id = match query.field_id {
        Some(id) => id,
        None => return (StatusCode::BAD_REQUEST, "Missing fieldId parameter").into_response(),
    };

    let points = {
        let db_state = app_handle.state::<crate::db::DbState>();
        let conn = match db_state.conn.lock() {
            Ok(c) => c,
            Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "Database lock failed").into_response(),
        };

        let fields = match crate::db::get_all_fields(&conn) {
            Ok(f) => f,
            Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "Database error").into_response(),
        };
        
        let field = match fields.into_iter().find(|f| f.id == Some(field_id)) {
            Some(f) => f,
            None => return (StatusCode::NOT_FOUND, "Field not found").into_response(),
        };

        let parsed: Vec<crate::tiles::LatLng> = match serde_json::from_str(&field.points_json) {
            Ok(p) => p,
            Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "Invalid field points JSON").into_response(),
        };
        parsed
    };

    if points.is_empty() {
        return (StatusCode::BAD_REQUEST, "Field has no points").into_response();
    }

    generate_ndvi_image(points).await
}

async fn handle_ndvi(Json(payload): Json<NdviRequest>) -> impl IntoResponse {
    if payload.points.is_empty() {
        return (StatusCode::BAD_REQUEST, "No points provided").into_response();
    }

    generate_ndvi_image(payload.points).await
}

async fn generate_ndvi_image(points: Vec<crate::tiles::LatLng>) -> axum::response::Response {
    // Bounding Box in WGS84
    let mut min_lat = points[0].lat;
    let mut max_lat = points[0].lat;
    let mut min_lng = points[0].lng;
    let mut max_lng = points[0].lng;
    for p in &points {
        if p.lat < min_lat { min_lat = p.lat; }
        if p.lat > max_lat { max_lat = p.lat; }
        if p.lng < min_lng { min_lng = p.lng; }
        if p.lng > max_lng { max_lng = p.lng; }
    }

    // Procedural NDVI generation for global testing
    let width = 256;
    let height = 256;
    
    // Simple spatial hashing for deterministic noise
    let seed = (min_lat * 1000.0) as i32 ^ (min_lng * 1000.0) as i32;
    
    let mut img = image::ImageBuffer::new(width as u32, height as u32);
    for y in 0..height {
        for x in 0..width {
            let nx = x as f32 / width as f32;
            let ny = y as f32 / height as f32;
            
            // Generate some procedural variation
            let wave1 = (nx * 10.0 + (seed as f32 * 0.1)).sin() * 0.1;
            let wave2 = (ny * 15.0).cos() * 0.15;
            let dist = ((nx - 0.5).powi(2) + (ny - 0.5).powi(2)).sqrt();
            
            let mut ndvi = 0.85 - dist * 0.5 + wave1 + wave2;
            ndvi = ndvi.clamp(0.0, 1.0);
            
            let (r, g, b) = if ndvi < 0.2 {
                (160, 82, 45) // Sienna brown
            } else if ndvi < 0.6 {
                // Interpolate brown -> yellow/green
                let pct = (ndvi - 0.2) / 0.4;
                (
                    (160.0 + pct * (173.0 - 160.0)) as u8,
                    (82.0 + pct * (255.0 - 82.0)) as u8,
                    (45.0 + pct * (47.0 - 45.0)) as u8
                )
            } else {
                // Interpolate yellow/green -> dark green
                let pct = (ndvi - 0.6) / 0.4;
                (
                    (173.0 + pct * (0.0 - 173.0)) as u8,
                    (255.0 + pct * (100.0 - 255.0)) as u8,
                    (47.0 + pct * (0.0 - 47.0)) as u8
                )
            };
            
            let a = 200; // Semi-transparent
            img.put_pixel(x as u32, y as u32, image::Rgba([r, g, b, a]));
        }
    }
    
    let mut buffer = std::io::Cursor::new(Vec::new());
    if let Err(e) = img.write_to(&mut buffer, image::ImageFormat::Png) {
        return (StatusCode::INTERNAL_SERVER_ERROR, format!("Image encoding error: {}", e)).into_response();
    }
    
    let headers = [
        (header::CONTENT_TYPE, "image/png"),
        (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
    ];
    
    (StatusCode::OK, headers, buffer.into_inner()).into_response()
}
