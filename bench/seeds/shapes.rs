#[derive(Debug, Clone, Copy)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct Rect {
    pub origin: Point,
    pub width: f64,
    pub height: f64,
}

pub fn rect_path(rect: &Rect, corner_radius: f64) -> Vec<Point> {
    let inset = corner_radius.min(rect.width / 2.0).min(rect.height / 2.0);
    vec![
        Point { x: rect.origin.x + inset, y: rect.origin.y },
        Point { x: rect.origin.x + rect.width - inset, y: rect.origin.y },
        Point { x: rect.origin.x + rect.width, y: rect.origin.y + rect.height - inset },
        Point { x: rect.origin.x, y: rect.origin.y + rect.height - inset },
    ]
}

pub fn centre(rect: &Rect) -> Point {
    Point {
        x: rect.origin.x + rect.width / 2.0,
        y: rect.origin.y + rect.height / 2.0,
    }
}

pub fn contains(rect: &Rect, point: Point) -> bool {
    point.x >= rect.origin.x
        && point.x <= rect.origin.x + rect.width
        && point.y >= rect.origin.y
        && point.y <= rect.origin.y + rect.height
}
