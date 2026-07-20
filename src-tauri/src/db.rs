use rusqlite::{Connection, OptionalExtension, Result, params};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

// Represents the coordinates nested object.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Coordinates {
    pub lat: f64,
    pub lng: f64,
}

// Represents the main User Profile.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    pub first_name: String,
    pub last_name: Option<String>,
    pub email: String,
    pub address: Option<String>,
    pub coordinates: Coordinates,
    pub climate_model: Option<String>,
    pub gemini_api_key: Option<String>,
    pub gemini_model: Option<String>,
    pub ollama_url: Option<String>,
    pub llm_provider: Option<String>,
    pub token_usage: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatSession {
    pub id: Option<i64>,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: Option<i64>,
    pub session_id: i64,
    pub role: String,
    pub content: String,
    pub timestamp: String,
    pub model_used: String,
    pub thoughts: Option<String>,
}

// Represents a farm field.
// We store `points_json` as a serialized JSON string representing the polygon points.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FarmField {
    pub id: Option<i64>,
    pub name: String,
    pub crop: String,
    pub stage: String,
    pub points_json: String,
    pub area_hectares: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Obstacle {
    pub id: Option<i64>,
    pub field_id: i64,
    pub obstacle_type: String,
    pub points_json: String,
    pub note: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WeatherData {
    pub id: Option<i64>,
    pub field_id: i64,
    pub date: String,
    pub data_type: String, // 'historical', 'forecast', 'climate'
    pub precipitation: f64,
    pub sun_exposure: f64,
    pub soil_temp_0_7cm: f64,
    pub soil_moisture_0_7cm: f64,
    pub evapotranspiration: f64,
    pub temperature_max: Option<f64>,
    pub temperature_min: Option<f64>,
    pub weather_code: Option<i32>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct WeatherSummary {
    pub total_precipitation_1yr: f64,
    pub total_sun_exposure_1yr: f64,
    pub avg_soil_temp_1yr: f64,
    pub avg_soil_moisture_1yr: f64,
    pub total_et_1yr: f64,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AnnualSummary {
    pub year: String,
    pub total_precipitation: f64,
    pub total_sun_exposure: f64,
    pub avg_soil_temp: f64,
    pub avg_soil_moisture: f64,
    pub total_evapotranspiration: f64,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: Option<i64>,
    pub field_id: i64,
    pub event_type: String,
    pub date: String,
    pub notes: Option<String>,
}

// The database state wrapper that Tauri will manage.
pub struct DbState {
    pub conn: Mutex<Connection>,
    pub sam_models: tokio::sync::Mutex<Option<crate::sam::SamModels>>,
}

/// Initializes the database connection and runs schemas if tables do not exist.
pub fn init_db(db_path: PathBuf) -> Result<Connection> {
    // Open the SQLite database file (it gets created if it does not exist)
    let conn = Connection::open(db_path)?;

    // Enable foreign keys
    conn.execute("PRAGMA foreign_keys = ON;", [])?;

    // Create the user_profile table.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS user_profile (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            first_name TEXT NOT NULL,
            last_name TEXT,
            email TEXT NOT NULL,
            address TEXT,
            latitude REAL NOT NULL,
            longitude REAL NOT NULL
        );",
        [],
    )?;

    let _ = conn.execute("ALTER TABLE user_profile ADD COLUMN climate_model TEXT DEFAULT 'MPI_ESM1_2_XR'", []);
    let _ = conn.execute("ALTER TABLE user_profile ADD COLUMN gemini_api_key TEXT", []);
    let _ = conn.execute("ALTER TABLE user_profile ADD COLUMN gemini_model TEXT", []);
    let _ = conn.execute("ALTER TABLE user_profile ADD COLUMN ollama_url TEXT", []);
    let _ = conn.execute("ALTER TABLE user_profile ADD COLUMN llm_provider TEXT DEFAULT 'gemini'", []);
    let _ = conn.execute("ALTER TABLE user_profile ADD COLUMN token_usage INTEGER DEFAULT 0", []);

    // Create the fields table.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS fields (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            crop TEXT NOT NULL,
            stage TEXT NOT NULL,
            points_json TEXT NOT NULL
        );",
        [],
    )?;

    // Migration to rename status to stage if table already existed before rename
    let _ = conn.execute("ALTER TABLE fields RENAME COLUMN status TO stage", []);
    let _ = conn.execute("ALTER TABLE fields ADD COLUMN area_hectares REAL", []);

    // Create the obstacles table.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS obstacles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            field_id INTEGER NOT NULL,
            obstacle_type TEXT NOT NULL,
            points_json TEXT NOT NULL,
            note TEXT,
            FOREIGN KEY (field_id) REFERENCES fields(id) ON DELETE CASCADE
        );",
        [],
    )?;

    // Create Weather Data table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS weather_data (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            field_id INTEGER NOT NULL,
            date TEXT NOT NULL,
            data_type TEXT NOT NULL,
            precipitation REAL,
            sun_exposure REAL,
            soil_temp_0_7cm REAL,
            soil_moisture_0_7cm REAL,
            evapotranspiration REAL,
            temperature_max REAL,
            temperature_min REAL,
            weather_code INTEGER,
            UNIQUE(field_id, date, data_type),
            FOREIGN KEY(field_id) REFERENCES fields(id) ON DELETE CASCADE
        )",
        [],
    )?;

    // Migrations for new columns
    let _ = conn.execute("ALTER TABLE weather_data ADD COLUMN temperature_max REAL", []);
    let _ = conn.execute("ALTER TABLE weather_data ADD COLUMN temperature_min REAL", []);
    let _ = conn.execute("ALTER TABLE weather_data ADD COLUMN weather_code INTEGER", []);

    // Create agronomy cache table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS agronomy_cache (
            field_id INTEGER PRIMARY KEY,
            metrics_json TEXT NOT NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (field_id) REFERENCES fields(id) ON DELETE CASCADE
        );",
        [],
    )?;

    // Create chat sessions table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS chat_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );",
        [],
    )?;

    // Create chat messages table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            model_used TEXT NOT NULL,
            thoughts TEXT,
            FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
        );",
        [],
    )?;

    // Run migration to add session_id to existing chat messages
    let mut has_session_id = false;
    {
        let mut stmt = conn.prepare("PRAGMA table_info(chat_messages)")?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let name: String = row.get(1)?;
            if name == "session_id" {
                has_session_id = true;
                break;
            }
        }
    }
    
    if !has_session_id {
        conn.execute("ALTER TABLE chat_messages ADD COLUMN session_id INTEGER", [])?;
        conn.execute(
            "INSERT INTO chat_sessions (title, created_at, updated_at) VALUES ('Legacy Conversation', datetime('now'), datetime('now'))",
            [],
        )?;
        let legacy_id = conn.last_insert_rowid();
        conn.execute(
            "UPDATE chat_messages SET session_id = ?1 WHERE session_id IS NULL",
            params![legacy_id],
        )?;
    }
    
    let _ = conn.execute("ALTER TABLE chat_messages ADD COLUMN thoughts TEXT", []);

    // Create calendar events table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS calendar_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            field_id INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            date TEXT NOT NULL,
            notes TEXT,
            FOREIGN KEY (field_id) REFERENCES fields(id) ON DELETE CASCADE
        );",
        [],
    )?;

    Ok(conn)
}

/// Saves the user profile by using an INSERT OR REPLACE query.
pub fn save_profile(conn: &Connection, profile: &UserProfile) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO user_profile (id, first_name, last_name, email, address, latitude, longitude, climate_model, gemini_api_key, gemini_model, ollama_url, llm_provider, token_usage)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12);",
        params![
            profile.first_name,
            profile.last_name,
            profile.email,
            profile.address,
            profile.coordinates.lat,
            profile.coordinates.lng,
            profile.climate_model,
            profile.gemini_api_key,
            profile.gemini_model,
            profile.ollama_url,
            profile.llm_provider,
            profile.token_usage.unwrap_or(0),
        ],
    )?;
    Ok(())
}

/// Fetches the user profile from the database.
pub fn get_profile(conn: &Connection) -> Result<Option<UserProfile>> {
    let mut stmt = conn.prepare(
        "SELECT first_name, last_name, email, address, latitude, longitude, climate_model, gemini_api_key, gemini_model, ollama_url, llm_provider, token_usage
         FROM user_profile 
         WHERE id = 1;",
    )?;

    let profile = stmt
        .query_row([], |row| {
            Ok(UserProfile {
                first_name: row.get(0)?,
                last_name: row.get(1)?,
                email: row.get(2)?,
                address: row.get(3)?,
                coordinates: Coordinates {
                    lat: row.get(4)?,
                    lng: row.get(5)?,
                },
                climate_model: row.get(6)?,
                gemini_api_key: row.get(7)?,
                gemini_model: row.get(8)?,
                ollama_url: row.get(9)?,
                llm_provider: row.get(10)?,
                token_usage: row.get(11).unwrap_or(Some(0)),
            })
        })
        .optional()?;

    Ok(profile)
}

/// Fetches all fields from the database.
pub fn get_all_fields(conn: &Connection) -> Result<Vec<FarmField>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, crop, stage, points_json, area_hectares 
         FROM fields;",
    )?;

    let field_iter = stmt.query_map([], |row| {
        Ok(FarmField {
            id: Some(row.get(0)?),
            name: row.get(1)?,
            crop: row.get(2)?,
            stage: row.get(3)?,
            points_json: row.get(4)?,
            area_hectares: row.get(5).unwrap_or(None),
        })
    })?;

    let mut fields = Vec::new();
    for field in field_iter {
        fields.push(field?);
    }
    Ok(fields)
}

/// Adds a new field to the database. Returns the inserted row's ID.
pub fn add_field(conn: &Connection, field: &FarmField) -> Result<i64> {
    conn.execute(
        "INSERT INTO fields (name, crop, stage, points_json, area_hectares) 
         VALUES (?1, ?2, ?3, ?4, ?5);",
        params![field.name, field.crop, field.stage, field.points_json, field.area_hectares],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Updates an existing field's calculated area.
pub fn update_field_area(conn: &Connection, field_id: i64, area_hectares: f64) -> Result<()> {
    conn.execute(
        "UPDATE fields SET area_hectares = ?1 WHERE id = ?2",
        params![area_hectares, field_id],
    )?;
    Ok(())
}

/// Updates an existing field's points in the database.
pub fn update_field(conn: &Connection, field_id: i64, points_json: &str) -> Result<()> {
    conn.execute(
        "UPDATE fields SET points_json = ?1 WHERE id = ?2",
        params![points_json, field_id],
    )?;
    Ok(())
}

/// Updates an existing field's stage in the database.
pub fn update_field_stage(conn: &Connection, field_id: i64, stage: &str) -> Result<()> {
    conn.execute(
        "UPDATE fields SET stage = ?1 WHERE id = ?2",
        params![stage, field_id],
    )?;
    Ok(())
}


/// Deletes a field by name.
pub fn delete_field(conn: &Connection, name: &str) -> Result<()> {
    conn.execute("DELETE FROM fields WHERE name = ?1;", params![name])?;
    Ok(())
}

/// Adds an obstacle to a field.
pub fn add_obstacle(conn: &Connection, obstacle: &Obstacle) -> Result<i64> {
    conn.execute(
        "INSERT INTO obstacles (field_id, obstacle_type, points_json, note) 
         VALUES (?1, ?2, ?3, ?4);",
        params![
            obstacle.field_id,
            obstacle.obstacle_type,
            obstacle.points_json,
            obstacle.note,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Fetches all obstacles for a given field_id.
pub fn get_obstacles_for_field(conn: &Connection, field_id: i64) -> Result<Vec<Obstacle>> {
    let mut stmt = conn.prepare(
        "SELECT id, field_id, obstacle_type, points_json, note 
         FROM obstacles WHERE field_id = ?1;",
    )?;

    let obstacle_iter = stmt.query_map(params![field_id], |row| {
        Ok(Obstacle {
            id: Some(row.get(0)?),
            field_id: row.get(1)?,
            obstacle_type: row.get(2)?,
            points_json: row.get(3)?,
            note: row.get(4)?,
        })
    })?;

    let mut obstacles = Vec::new();
    for obstacle in obstacle_iter {
        obstacles.push(obstacle?);
    }
    Ok(obstacles)
}

/// Updates an existing obstacle.
pub fn update_obstacle(conn: &Connection, obstacle: &Obstacle) -> Result<()> {
    if let Some(id) = obstacle.id {
        conn.execute(
            "UPDATE obstacles 
             SET obstacle_type = ?1, points_json = ?2, note = ?3 
             WHERE id = ?4;",
            params![
                obstacle.obstacle_type,
                obstacle.points_json,
                obstacle.note,
                id,
            ],
        )?;
    }
    Ok(())
}

/// Deletes an obstacle by its ID.
pub fn delete_obstacle(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM obstacles WHERE id = ?1;", params![id])?;
    Ok(())
}

/// Clears all tables in the database.
pub fn reset_db(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM user_profile;", [])?;
    conn.execute("DELETE FROM obstacles;", [])?;
    conn.execute("DELETE FROM fields;", [])?;
    Ok(())
}

/// Fetches the latest date for which historical data exists for a field.
pub fn get_latest_historical_date(conn: &Connection, field_id: i64) -> Result<Option<String>> {
    let mut stmt = conn.prepare(
        "SELECT MAX(date) FROM weather_data 
         WHERE field_id = ?1 AND data_type = 'historical';",
    )?;
    let mut rows = stmt.query(params![field_id])?;
    if let Some(row) = rows.next()? {
        let date: Option<String> = row.get(0)?;
        Ok(date)
    } else {
        Ok(None)
    }
}

/// Upserts weather data into the database.
pub fn upsert_weather_data(conn: &Connection, data: &[WeatherData]) -> Result<()> {
    conn.execute_batch("BEGIN TRANSACTION;")?;
    
    let mut stmt = conn.prepare(
        "INSERT OR REPLACE INTO weather_data 
         (field_id, date, data_type, precipitation, sun_exposure, soil_temp_0_7cm, soil_moisture_0_7cm, evapotranspiration, temperature_max, temperature_min, weather_code) 
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11);"
    )?;
    
    for d in data {
        stmt.execute(params![
            d.field_id,
            d.date,
            d.data_type,
            d.precipitation,
            d.sun_exposure,
            d.soil_temp_0_7cm,
            d.soil_moisture_0_7cm,
            d.evapotranspiration,
            d.temperature_max,
            d.temperature_min,
            d.weather_code,
        ])?;
    }
    
    drop(stmt);
    conn.execute_batch("COMMIT;")?;
    
    Ok(())
}

/// Deletes existing weather data for a field by data type.
pub fn delete_weather_data_by_type(conn: &Connection, field_id: i64, data_type: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM weather_data WHERE field_id = ?1 AND data_type = ?2;",
        params![field_id, data_type],
    )?;
    Ok(())
}

/// Gets the 1-year summary for a field based on historical data.
pub fn get_annual_weather_summary(conn: &Connection, field_id: i64) -> Result<WeatherSummary> {
    // Assuming we want the last 365 days from the most recent historical date
    let mut stmt = conn.prepare(
        "SELECT 
            SUM(precipitation) as total_precip,
            SUM(sun_exposure) as total_sun,
            AVG(soil_temp_0_7cm) as avg_temp,
            AVG(soil_moisture_0_7cm) as avg_moist,
            SUM(evapotranspiration) as total_et
         FROM weather_data 
         WHERE field_id = ?1 AND data_type = 'historical' 
         AND date >= date('now', '-1 year');"
    )?;
    
    let mut rows = stmt.query(params![field_id])?;
    if let Some(row) = rows.next()? {
        Ok(WeatherSummary {
            total_precipitation_1yr: row.get::<_, Option<f64>>(0)?.unwrap_or(0.0),
            total_sun_exposure_1yr: row.get::<_, Option<f64>>(1)?.unwrap_or(0.0),
            avg_soil_temp_1yr: row.get::<_, Option<f64>>(2)?.unwrap_or(0.0),
            avg_soil_moisture_1yr: row.get::<_, Option<f64>>(3)?.unwrap_or(0.0),
            total_et_1yr: row.get::<_, Option<f64>>(4)?.unwrap_or(0.0),
        })
    } else {
        Ok(WeatherSummary::default())
    }
}

/// Gets the annual weather summaries for the last 5 years.
pub fn get_historical_annual_summaries(conn: &Connection, field_id: i64) -> Result<Vec<AnnualSummary>> {
    let mut stmt = conn.prepare(
        "SELECT 
            strftime('%Y', date) as year,
            SUM(precipitation) as total_precip,
            SUM(sun_exposure) as total_sun,
            AVG(soil_temp_0_7cm) as avg_temp,
            AVG(soil_moisture_0_7cm) as avg_moist,
            SUM(evapotranspiration) as total_et
         FROM weather_data 
         WHERE field_id = ?1 AND data_type = 'historical'
         GROUP BY year
         ORDER BY year DESC
         LIMIT 5;"
    )?;

    let iter = stmt.query_map(params![field_id], |row| {
        Ok(AnnualSummary {
            year: row.get(0)?,
            total_precipitation: row.get::<_, Option<f64>>(1)?.unwrap_or(0.0),
            total_sun_exposure: row.get::<_, Option<f64>>(2)?.unwrap_or(0.0),
            avg_soil_temp: row.get::<_, Option<f64>>(3)?.unwrap_or(0.0),
            avg_soil_moisture: row.get::<_, Option<f64>>(4)?.unwrap_or(0.0),
            total_evapotranspiration: row.get::<_, Option<f64>>(5)?.unwrap_or(0.0),
        })
    })?;

    let mut results = Vec::new();
    for item in iter {
        if let Ok(val) = item {
            results.push(val);
        }
    }
    Ok(results)
}

/// Gets all weather data for a field.
pub fn get_full_field_weather(conn: &Connection, field_id: i64) -> Result<Vec<WeatherData>> {
    let mut stmt = conn.prepare(
        "SELECT id, field_id, date, data_type, precipitation, sun_exposure, soil_temp_0_7cm, soil_moisture_0_7cm, evapotranspiration, temperature_max, temperature_min, weather_code
         FROM weather_data 
         WHERE field_id = ?1 
         ORDER BY date ASC;"
    )?;
    
    let weather_iter = stmt.query_map(params![field_id], |row| {
        Ok(WeatherData {
            id: Some(row.get(0)?),
            field_id: row.get(1)?,
            date: row.get(2)?,
            data_type: row.get(3)?,
            precipitation: row.get(4)?,
            sun_exposure: row.get(5)?,
            soil_temp_0_7cm: row.get(6)?,
            soil_moisture_0_7cm: row.get(7)?,
            evapotranspiration: row.get(8)?,
            temperature_max: row.get(9).unwrap_or(None),
            temperature_min: row.get(10).unwrap_or(None),
            weather_code: row.get(11).unwrap_or(None),
        })
    })?;
    
    let mut data = Vec::new();
    for d in weather_iter {
        data.push(d?);
    }
    Ok(data)
}

/// Fetches the agronomy cache for a field. Returns the JSON string and minutes since last update.
pub fn get_agronomy_cache(conn: &Connection, field_id: i64) -> Result<Option<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT metrics_json, CAST((julianday('now') - julianday(updated_at)) * 24 * 60 AS INTEGER) 
         FROM agronomy_cache WHERE field_id = ?1;",
    )?;
    
    let mut rows = stmt.query(params![field_id])?;
    if let Some(row) = rows.next()? {
        let json: String = row.get(0)?;
        let minutes_old: i64 = row.get(1)?;
        Ok(Some((json, minutes_old)))
    } else {
        Ok(None)
    }
}

pub fn set_agronomy_cache(conn: &Connection, field_id: i64, metrics_json: &str) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO agronomy_cache (field_id, metrics_json, updated_at) 
         VALUES (?1, ?2, CURRENT_TIMESTAMP);",
        params![field_id, metrics_json],
    )?;
    Ok(())
}

/// Fetches all chat sessions
pub fn get_chat_sessions(conn: &Connection) -> Result<Vec<ChatSession>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, created_at, updated_at 
         FROM chat_sessions 
         ORDER BY updated_at DESC;"
    )?;

    let iter = stmt.query_map([], |row| {
        Ok(ChatSession {
            id: Some(row.get(0)?),
            title: row.get(1)?,
            created_at: row.get(2)?,
            updated_at: row.get(3)?,
        })
    })?;

    let mut sessions = Vec::new();
    for session in iter {
        sessions.push(session?);
    }
    Ok(sessions)
}

/// Creates a new chat session
pub fn create_chat_session(conn: &Connection, title: &str) -> Result<i64> {
    conn.execute(
        "INSERT INTO chat_sessions (title, created_at, updated_at) VALUES (?1, datetime('now'), datetime('now'))",
        params![title],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Updates a chat session title
pub fn update_chat_session_title(conn: &Connection, session_id: i64, title: &str) -> Result<()> {
    conn.execute(
        "UPDATE chat_sessions SET title = ?1, updated_at = datetime('now') WHERE id = ?2",
        params![title, session_id],
    )?;
    Ok(())
}

/// Deletes a chat session (and cascades its messages)
pub fn delete_chat_session(conn: &Connection, session_id: i64) -> Result<()> {
    conn.execute("DELETE FROM chat_sessions WHERE id = ?1", params![session_id])?;
    Ok(())
}

/// Fetches chat messages for a specific session ordered by timestamp ascending.
pub fn get_chat_history(conn: &Connection, session_id: i64) -> Result<Vec<ChatMessage>> {
    let mut stmt = conn.prepare(
        "SELECT id, session_id, role, content, timestamp, model_used, thoughts 
         FROM chat_messages 
         WHERE session_id = ?1
         ORDER BY timestamp ASC;",
    )?;

    let iter = stmt.query_map(params![session_id], |row| {
        Ok(ChatMessage {
            id: Some(row.get(0)?),
            session_id: row.get(1)?,
            role: row.get(2)?,
            content: row.get(3)?,
            timestamp: row.get(4)?,
            model_used: row.get(5)?,
            thoughts: row.get(6)?,
        })
    })?;

    let mut messages = Vec::new();
    for msg in iter {
        messages.push(msg?);
    }
    Ok(messages)
}

/// Adds a new chat message to the database.
pub fn add_chat_message(conn: &Connection, msg: &ChatMessage) -> Result<i64> {
    conn.execute(
        "INSERT INTO chat_messages (session_id, role, content, timestamp, model_used, thoughts) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![msg.session_id, msg.role, msg.content, msg.timestamp, msg.model_used, msg.thoughts],
    )?;
    // Update the session's updated_at timestamp
    conn.execute(
        "UPDATE chat_sessions SET updated_at = datetime('now') WHERE id = ?1",
        params![msg.session_id],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Clears a specific session's history.
pub fn clear_chat_history(conn: &Connection, session_id: i64) -> Result<()> {
    conn.execute("DELETE FROM chat_messages WHERE session_id = ?1", params![session_id])?;
    Ok(())
}

/// Adds a new calendar event.
pub fn add_calendar_event(conn: &Connection, event: &CalendarEvent) -> Result<i64> {
    conn.execute(
        "INSERT INTO calendar_events (field_id, event_type, date, notes) VALUES (?1, ?2, ?3, ?4)",
        params![event.field_id, event.event_type, event.date, event.notes],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Fetches all calendar events for a specific field.
pub fn get_calendar_events_for_field(conn: &Connection, field_id: i64) -> Result<Vec<CalendarEvent>> {
    let mut stmt = conn.prepare(
        "SELECT id, field_id, event_type, date, notes FROM calendar_events WHERE field_id = ?1 ORDER BY date ASC",
    )?;
    let iter = stmt.query_map(params![field_id], |row| {
        Ok(CalendarEvent {
            id: Some(row.get(0)?),
            field_id: row.get(1)?,
            event_type: row.get(2)?,
            date: row.get(3)?,
            notes: row.get(4)?,
        })
    })?;
    let mut events = Vec::new();
    for event in iter {
        events.push(event?);
    }
    Ok(events)
}

pub fn increment_token_usage(conn: &Connection, amount: i64) -> Result<()> {
    conn.execute(
        "UPDATE user_profile SET token_usage = COALESCE(token_usage, 0) + ?1 WHERE id = 1;",
        params![amount],
    )?;
    Ok(())
}

pub fn reset_token_usage(conn: &Connection) -> Result<()> {
    conn.execute("UPDATE user_profile SET token_usage = 0 WHERE id = 1;", [])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_in_memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute("PRAGMA foreign_keys = ON;", []).unwrap();
        
        conn.execute(
            "CREATE TABLE IF NOT EXISTS fields (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                crop TEXT NOT NULL,
                stage TEXT NOT NULL,
                points_json TEXT NOT NULL,
                area_hectares REAL
            );",
            [],
        ).unwrap();

        conn.execute(
            "CREATE TABLE IF NOT EXISTS chat_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );",
            [],
        ).unwrap();

        conn.execute(
            "CREATE TABLE IF NOT EXISTS chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                model_used TEXT NOT NULL,
                thoughts TEXT,
                FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
            );",
            [],
        ).unwrap();
        
        conn
    }

    #[test]
    fn test_chat_history() {
        let conn = setup_in_memory_db();
        let session_id = super::create_chat_session(&conn, "Test Session").unwrap();
        
        let msg = ChatMessage {
            id: None,
            session_id,
            role: "user".to_string(),
            content: "Hello".to_string(),
            timestamp: "2026-07-01T12:00:00Z".to_string(),
            model_used: "gemini".to_string(),
            thoughts: None,
        };

        add_chat_message(&conn, &msg).unwrap();
        let history = get_chat_history(&conn, session_id).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].role, "user");

        clear_chat_history(&conn, session_id).unwrap();
        let history_empty = get_chat_history(&conn, session_id).unwrap();
        assert_eq!(history_empty.len(), 0);
    }
}
