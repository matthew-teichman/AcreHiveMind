#![allow(dead_code)]
use crate::db::WeatherData;
// using chrono internally

/// Calculates Delta T given dry bulb (temp) and relative humidity.
/// Since we don't have direct RH from the API currently, we can approximate wet bulb or use empirical formulas.
/// For agricultural purposes, a simple empirical approximation of wet bulb can be used, but since we didn't fetch RH yet in `weather_api`,
/// let's implement the standard formula and we will need to fetch RH.
/// However, Delta T = Dry Bulb - Wet Bulb. 
/// Let's use an approximation: T_w = T * atan(0.151977 * (RH + 8.313659)^(1/2)) + atan(T + RH) - atan(RH - 1.676331) + 0.00391838 * (RH)^(3/2) * atan(0.023101 * RH) - 4.686035
pub fn calculate_delta_t(temp_c: f64, rh: f64) -> f64 {
    let t = temp_c;
    let rh_val = rh;
    let tw = t * (0.151977 * (rh_val + 8.313659).powf(0.5)).atan()
        + (t + rh_val).atan()
        - (rh_val - 1.676331).atan()
        + 0.00391838 * rh_val.powf(1.5) * (0.023101 * rh_val).atan()
        - 4.686035;
    
    t - tw
}

/// Returns true if temperature at 180m is greater than at 2m (inversion risk).
pub fn check_inversion_risk(temp_2m: f64, temp_180m: f64) -> bool {
    temp_180m > temp_2m
}

/// Calculates a Trafficability Index (0-100)
/// Higher is better (drier/firmer). 
/// Simple model: Starts at 100, drops by precip, recovers by ET0.
pub fn calculate_trafficability(precip_48h: f64, soil_moist_surf: f64, et0_48h: f64) -> f64 {
    // Arbitrary weighting for the sake of the metric:
    // Soil moisture is m3/m3 (usually 0.1 to 0.4).
    let moisture_penalty = (soil_moist_surf * 100.0).max(0.0).min(50.0) * 1.5; // up to 75 penalty
    let precip_penalty = (precip_48h * 2.0).min(50.0); // 25mm rain drops index by 50
    let et_recovery = (et0_48h * 3.0).min(25.0); // Some recovery
    
    let index = 100.0 - moisture_penalty - precip_penalty + et_recovery;
    index.clamp(0.0, 100.0)
}

/// Identifies harvest windows. Returns a list of dates (Strings) that are part of a consecutive 3-day block
/// with 0 precipitation and good sun exposure.
pub fn find_harvest_windows(forecast: &[WeatherData]) -> Vec<String> {
    let mut harvest_dates = Vec::new();
    if forecast.len() < 3 {
        return harvest_dates;
    }

    for i in 0..=(forecast.len() - 3) {
        let day1 = &forecast[i];
        let day2 = &forecast[i + 1];
        let day3 = &forecast[i + 2];

        // Check if all 3 days have 0 precip
        if day1.precipitation == 0.0 && day2.precipitation == 0.0 && day3.precipitation == 0.0 {
            // Check if sunshine is decent (e.g. > 10 MJ/m2 roughly, though varies by season, let's just use precip for now or > 5.0)
            if day1.sun_exposure > 5.0 && day2.sun_exposure > 5.0 && day3.sun_exposure > 5.0 {
                if !harvest_dates.contains(&day1.date) {
                    harvest_dates.push(day1.date.clone());
                }
                if !harvest_dates.contains(&day2.date) {
                    harvest_dates.push(day2.date.clone());
                }
                if !harvest_dates.contains(&day3.date) {
                    harvest_dates.push(day3.date.clone());
                }
            }
        }
    }
    
    harvest_dates.sort();
    harvest_dates
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calculate_delta_t() {
        // Delta T for 20C and 50% RH is typically around 5-6C.
        // Let's just ensure it computes without panicking and returns a sensible value.
        let dt = calculate_delta_t(20.0, 50.0);
        assert!(dt > 0.0 && dt < 10.0, "Delta T should be between 0 and 10 for these conditions");
    }

    #[test]
    fn test_check_inversion_risk() {
        assert!(check_inversion_risk(15.0, 18.0), "Inversion should be true if higher temp at altitude");
        assert!(!check_inversion_risk(20.0, 18.0), "Inversion should be false if lower temp at altitude");
    }

    #[test]
    fn test_calculate_trafficability() {
        let good_conditions = calculate_trafficability(0.0, 0.1, 5.0);
        assert!(good_conditions > 80.0, "Trafficability should be high in dry conditions");

        let bad_conditions = calculate_trafficability(25.0, 0.4, 1.0);
        assert!(bad_conditions < 50.0, "Trafficability should be low after heavy rain");
    }

    #[test]
    fn test_find_harvest_windows() {
        let forecast = vec![
            WeatherData {
                id: None, field_id: 1,
                date: "2026-07-01".to_string(),
                data_type: "forecast".to_string(),
                temperature_max: Some(30.0), temperature_min: Some(20.0), precipitation: 0.0, sun_exposure: 10.0,
                soil_moisture_0_7cm: 0.1, soil_temp_0_7cm: 25.0, evapotranspiration: 2.0, weather_code: Some(0)
            },
            WeatherData {
                id: None, field_id: 1,
                date: "2026-07-02".to_string(),
                data_type: "forecast".to_string(),
                temperature_max: Some(30.0), temperature_min: Some(20.0), precipitation: 0.0, sun_exposure: 10.0,
                soil_moisture_0_7cm: 0.1, soil_temp_0_7cm: 25.0, evapotranspiration: 2.0, weather_code: Some(0)
            },
            WeatherData {
                id: None, field_id: 1,
                date: "2026-07-03".to_string(),
                data_type: "forecast".to_string(),
                temperature_max: Some(30.0), temperature_min: Some(20.0), precipitation: 0.0, sun_exposure: 10.0,
                soil_moisture_0_7cm: 0.1, soil_temp_0_7cm: 25.0, evapotranspiration: 2.0, weather_code: Some(0)
            },
            WeatherData {
                id: None, field_id: 1,
                date: "2026-07-04".to_string(),
                data_type: "forecast".to_string(),
                temperature_max: Some(30.0), temperature_min: Some(20.0), precipitation: 5.0, sun_exposure: 2.0,
                soil_moisture_0_7cm: 0.1, soil_temp_0_7cm: 25.0, evapotranspiration: 2.0, weather_code: Some(0)
            },
        ];

        let windows = find_harvest_windows(&forecast);
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0], "2026-07-01");
        assert_eq!(windows[2], "2026-07-03");
    }
}
