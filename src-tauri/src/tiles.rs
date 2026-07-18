use image::{DynamicImage, GenericImage, RgbaImage};
use reqwest::Client;
use std::f64::consts::PI;

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct LatLng {
    pub lat: f64,
    pub lng: f64,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct BBox {
    pub min_lat: f64,
    pub max_lat: f64,
    pub min_lng: f64,
    pub max_lng: f64,
}

pub fn lng_to_x(lng: f64) -> f64 {
    (lng + 180.0) / 360.0
}

pub fn lat_to_y(lat: f64) -> f64 {
    let lat_rad = lat * PI / 180.0;
    (1.0 - (lat_rad.tan() + (1.0 / lat_rad.cos())).ln() / PI) / 2.0
}

pub fn x_to_lng(x: f64) -> f64 {
    x * 360.0 - 180.0
}

pub fn y_to_lat(y: f64) -> f64 {
    let n = PI - 2.0 * PI * y;
    (n.exp().atan() * 2.0 - PI / 2.0) * 180.0 / PI
}

pub fn calculate_optimal_zoom(_bbox: &BBox) -> u32 {
    15
}

pub struct MapContext {
    pub image: DynamicImage,
    pub zoom: u32,
    pub top_left_x_tile: u32,
    pub top_left_y_tile: u32,
}

impl MapContext {
    pub fn latlng_to_pixel(&self, ll: &LatLng) -> (u32, u32) {
        let n = 2.0_f64.powi(self.zoom as i32);
        let x_global = lng_to_x(ll.lng) * n;
        let y_global = lat_to_y(ll.lat) * n;

        let px = (x_global - self.top_left_x_tile as f64) * 256.0;
        let py = (y_global - self.top_left_y_tile as f64) * 256.0;

        (px.max(0.0) as u32, py.max(0.0) as u32)
    }

    pub fn pixel_to_latlng(&self, px: u32, py: u32) -> LatLng {
        let n = 2.0_f64.powi(self.zoom as i32);
        let x_global = self.top_left_x_tile as f64 + (px as f64 / 256.0);
        let y_global = self.top_left_y_tile as f64 + (py as f64 / 256.0);

        LatLng {
            lat: y_to_lat(y_global / n),
            lng: x_to_lng(x_global / n),
        }
    }
}

pub async fn download_map_image(bbox: &BBox) -> Result<MapContext, String> {
    let zoom = calculate_optimal_zoom(bbox);
    let n = 2.0_f64.powi(zoom as i32);

    let x_min_global = lng_to_x(bbox.min_lng) * n;
    let x_max_global = lng_to_x(bbox.max_lng) * n;
    // note: min_lat translates to max_y
    let y_max_global = lat_to_y(bbox.min_lat) * n;
    let y_min_global = lat_to_y(bbox.max_lat) * n;

    // To ensure the field is well within the image and we have a 1024x1024 or larger area,
    // let's grab a grid around the center.
    let x_center = (x_min_global + x_max_global) / 2.0;
    let y_center = (y_min_global + y_max_global) / 2.0;

    // Grab 4x4 tiles centered around the field (1024x1024 pixels)
    let top_left_x_tile = (x_center - 2.0).floor() as u32;
    let top_left_y_tile = (y_center - 2.0).floor() as u32;
    let width_tiles = 4;
    let height_tiles = 4;

    let mut stitched_image = RgbaImage::new(width_tiles * 256, height_tiles * 256);
    let client = Client::new();

    for dx in 0..width_tiles {
        for dy in 0..height_tiles {
            let tx = top_left_x_tile + dx;
            let ty = top_left_y_tile + dy;
            let url = format!(
                "https://mt1.google.com/vt/lyrs=s&x={}&y={}&z={}",
                tx, ty, zoom
            );

            let resp = client.get(&url).header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36").send().await.map_err(|e| e.to_string())?;
            if resp.status().is_success() {
                let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
                if let Ok(tile_img) = image::load_from_memory(&bytes) {
                    stitched_image
                        .copy_from(&tile_img, dx * 256, dy * 256)
                        .map_err(|e| e.to_string())?;
                }
            }
        }
    }

    Ok(MapContext {
        image: DynamicImage::ImageRgba8(stitched_image),
        zoom,
        top_left_x_tile,
        top_left_y_tile,
    })
}
