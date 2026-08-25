pub const RETRY_LIMIT: u32 = 3;

pub struct Response {
    pub status: u16,
    pub body: String,
}

pub fn fetch(url: &str) -> Response {
    let mut attempt = 0;

    loop {
        attempt += 1;

        let response = send(url);

        if response.status < 500 || attempt > RETRY_LIMIT {
            return response;
        }
    }
}

fn send(url: &str) -> Response {
    Response {
        status: 200,
        body: format!("ok: {url}"),
    }
}

pub fn fetch_all(urls: &[&str]) -> Vec<Response> {
    urls.iter().map(|url| fetch(url)).collect()
}

pub fn healthy(url: &str) -> bool {
    fetch(url).status < 400
}
