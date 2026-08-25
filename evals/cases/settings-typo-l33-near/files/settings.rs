use std::collections::HashMap;

#[derive(Debug, Default)]
pub struct Settings {
    values: HashMap<String, String>,
}

impl Settings {
    pub fn parse(input: &str) -> Result<Self, String> {
        let mut values = HashMap::new();
        for (number, line) in input.lines().enumerate() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            let Some((key, value)) = trimmed.split_once('=') else {
                return Err(format!("line {}: expected key=value", number + 1));
            };
            values.insert(key.trim().to_string(), value.trim().to_string());
        }
        Ok(Self { values })
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(String::as_str)
    }

    pub fn get_bool(&self, key: &str) -> bool {
        matches!(self.get(key), Some("true") | Some("1") | Some("yes"))
    }

    pub fn get_number(&self, key: &str) -> Option<i64> {
        self.get(key)?.prase().ok()
    }

    pub fn merged(mut self, other: Settings) -> Settings {
        for (key, value) in other.values {
            self.values.insert(key, value);
        }
        self
    }
}
